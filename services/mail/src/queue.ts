import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MailPayload { destination: string; code: string; purpose: "sign_up" | "sign_in" | "password_reset" | "change_contact"; }
export interface QueueItem { id: string; idempotencyKey: string; payload: MailPayload; attempts: number; }
export type DeliveryEventType = "hard_bounce" | "soft_bounce" | "complaint";
export interface DeliveryEvent { eventId: string; type: DeliveryEventType; recipient: string; }
export type EnqueueResult = { id: string; status: "queued" | "processing" | "sent" | "dead"; created: boolean };
export interface QueueStats { queued: number; processing: number; sent: number; dead: number; }
export class RecipientSuppressedError extends Error {
  constructor() { super("Recipient is suppressed"); this.name = "RecipientSuppressedError"; }
}
function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}
function decrypt(value: string, key: Buffer): string {
  const [ivText, tagText, dataText] = value.split(".");
  if (!ivText || !tagText || !dataText) throw new Error("Invalid encrypted queue payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
}
function normalizeAddress(address: string): string { return address.trim().toLowerCase(); }
export class MailQueue {
  private readonly db: InstanceType<typeof Database>;
  private readonly key: Buffer;
  constructor(path: string, encryptionKey: string) {
    this.key = Buffer.from(encryptionKey, "base64");
    if (this.key.length !== 32) throw new Error("QUEUE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_queue (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, encrypted_payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','processing','sent','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        lease_until INTEGER, last_error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS mail_queue_ready_idx ON mail_queue(status, next_attempt_at, lease_until, expires_at);
      CREATE TABLE IF NOT EXISTS mail_delivery_events (
        event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL CHECK(event_type IN ('hard_bounce','soft_bounce','complaint')),
        recipient_hash TEXT NOT NULL, received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_suppressions (
        recipient_hash TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK(reason IN ('hard_bounce','complaint')),
        created_at INTEGER NOT NULL, source_event_id TEXT NOT NULL
      );
    `);
  }
  private recipientHash(address: string): string {
    return createHmac("sha256", this.key).update("luxora-mail-recipient-v1\0").update(normalizeAddress(address)).digest("hex");
  }
  isSuppressed(address: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM mail_suppressions WHERE recipient_hash=?").get(this.recipientHash(address)));
  }
  enqueue(idempotencyKey: string, payload: MailPayload): EnqueueResult {
    if (this.isSuppressed(payload.destination)) throw new RecipientSuppressedError();
    const now = Date.now(), id = randomBytes(16).toString("hex");
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO mail_queue
      (id,idempotency_key,encrypted_payload,status,attempts,next_attempt_at,expires_at,created_at,updated_at)
      VALUES (?,?,?,'queued',0,?,?,?,?)
    `);
    const result = insert.run(id, idempotencyKey, encrypt(JSON.stringify(payload), this.key), now, now + 5 * 60_000, now, now);
    const row = this.db.prepare("SELECT id,status,encrypted_payload FROM mail_queue WHERE idempotency_key=?")
      .get(idempotencyKey) as {id:string;status:EnqueueResult["status"];encrypted_payload:string};
    if (!result.changes && row.encrypted_payload && decrypt(row.encrypted_payload, this.key) !== JSON.stringify(payload)) {
      throw new Error("Idempotency key was already used for a different delivery");
    }
    return { id: row.id, status: row.status, created: result.changes === 1 };
  }
  recordDeliveryEvent(event: DeliveryEvent): { duplicate: boolean; suppressed: boolean } {
    const now = Date.now(), recipientHash = this.recipientHash(event.recipient);
    return this.db.transaction(() => {
      const inserted = this.db.prepare(
        "INSERT OR IGNORE INTO mail_delivery_events(event_id,event_type,recipient_hash,received_at) VALUES (?,?,?,?)"
      ).run(event.eventId, event.type, recipientHash, now);
      if (inserted.changes === 0) return { duplicate: true, suppressed: this.isSuppressed(event.recipient) };
      const shouldSuppress = event.type === "hard_bounce" || event.type === "complaint";
      if (shouldSuppress) {
        this.db.prepare(`
          INSERT INTO mail_suppressions(recipient_hash,reason,created_at,source_event_id) VALUES (?,?,?,?)
          ON CONFLICT(recipient_hash) DO UPDATE SET
            reason=CASE WHEN mail_suppressions.reason='complaint' THEN 'complaint' ELSE excluded.reason END
        `).run(recipientHash, event.type, now, event.eventId);
        const rows = this.db.prepare("SELECT id,encrypted_payload FROM mail_queue WHERE status IN ('queued','processing') AND encrypted_payload<>''").all() as Array<{id:string;encrypted_payload:string}>;
        const stop = this.db.prepare("UPDATE mail_queue SET status='dead',encrypted_payload='',lease_until=NULL,last_error_code='recipient_suppressed',updated_at=? WHERE id=? AND status IN ('queued','processing')");
        for (const row of rows) {
          try {
            const payload = JSON.parse(decrypt(row.encrypted_payload, this.key)) as MailPayload;
            if (this.recipientHash(payload.destination) === recipientHash) stop.run(now, row.id);
          } catch { /* Keep malformed rows isolated; never expose payload data. */ }
        }
      }
      return { duplicate: false, suppressed: shouldSuppress || this.isSuppressed(event.recipient) };
    })();
  }
  suppressionStats(): { total: number; hardBounce: number; complaint: number; events: number } {
    const rows = this.db.prepare("SELECT reason,COUNT(*) AS count FROM mail_suppressions GROUP BY reason").all() as Array<{reason:string;count:number}>;
    const result = { total: 0, hardBounce: 0, complaint: 0, events: 0 };
    for (const row of rows) {
      result.total += row.count;
      if (row.reason === "hard_bounce") result.hardBounce = row.count;
      if (row.reason === "complaint") result.complaint = row.count;
    }
    result.events = (this.db.prepare("SELECT COUNT(*) AS count FROM mail_delivery_events").get() as {count:number}).count;
    return result;
  }
  claim(leaseMs = 60_000): QueueItem | null {
    const now = Date.now();
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mail_queue SET status='dead',encrypted_payload='',lease_until=NULL,
          last_error_code='otp_expired',updated_at=?
        WHERE status IN ('queued','processing') AND expires_at<=?
      `).run(now, now);
      const row = this.db.prepare(`
        SELECT id,idempotency_key,encrypted_payload,attempts FROM mail_queue
        WHERE expires_at>? AND ((status='queued' AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?))
        ORDER BY created_at ASC LIMIT 1
      `).get(now, now, now) as {id:string;idempotency_key:string;encrypted_payload:string;attempts:number} | undefined;
      if (!row) return null;
      const updated = this.db.prepare(`
        UPDATE mail_queue SET status='processing',lease_until=?,updated_at=?
        WHERE id=? AND expires_at>? AND ((status='queued' AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?))
      `).run(now + leaseMs, now, row.id, now, now, now);
      if (updated.changes !== 1) return null;
      return { id: row.id, idempotencyKey: row.idempotency_key, payload: JSON.parse(decrypt(row.encrypted_payload, this.key)) as MailPayload, attempts: row.attempts };
    })();
  }
  markSent(id: string): void {
    const now = Date.now();
    this.db.prepare("UPDATE mail_queue SET status='sent',sent_at=?,lease_until=NULL,encrypted_payload='',updated_at=? WHERE id=? AND status='processing'").run(now, now, id);
  }
  markSuppressed(id: string): void {
    this.db.prepare("UPDATE mail_queue SET status='dead',encrypted_payload='',lease_until=NULL,last_error_code='recipient_suppressed',updated_at=? WHERE id=? AND status='processing'").run(Date.now(), id);
  }
  markFailed(id: string, attempts: number, errorCode: string, maxAttempts = 8): void {
    const now = Date.now(), nextAttempts = attempts + 1;
    if (nextAttempts >= maxAttempts) {
      this.db.prepare("UPDATE mail_queue SET status='dead',attempts=?,lease_until=NULL,last_error_code=?,encrypted_payload='',updated_at=? WHERE id=? AND status='processing'").run(nextAttempts, errorCode, now, id);
      return;
    }
    const delay = Math.min(60 * 60_000, 5_000 * (2 ** Math.min(nextAttempts - 1, 10)));
    this.db.prepare("UPDATE mail_queue SET status='queued',attempts=?,next_attempt_at=?,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=? AND status='processing'").run(nextAttempts, now + delay, errorCode, now, id);
  }
  stats(): QueueStats {
    const rows = this.db.prepare("SELECT status,COUNT(*) AS count FROM mail_queue GROUP BY status").all() as Array<{status: keyof QueueStats; count: number}>;
    const result: QueueStats = { queued: 0, processing: 0, sent: 0, dead: 0 };
    for (const row of rows) result[row.status] = row.count;
    return result;
  }
  close(): void { this.db.close(); }
}
