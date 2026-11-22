import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MailPayload { destination: string; code: string; purpose: "sign_up" | "sign_in" | "password_reset" | "change_contact"; }
export interface QueueItem { id: string; idempotencyKey: string; payload: MailPayload; attempts: number; }
export type EnqueueResult = { id: string; status: "queued" | "processing" | "sent" | "dead"; created: boolean };
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
    `);
  }
  enqueue(idempotencyKey: string, payload: MailPayload): EnqueueResult {
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
  markFailed(id: string, attempts: number, errorCode: string, maxAttempts = 8): void {
    const now = Date.now(), nextAttempts = attempts + 1;
    if (nextAttempts >= maxAttempts) {
      this.db.prepare("UPDATE mail_queue SET status='dead',attempts=?,lease_until=NULL,last_error_code=?,encrypted_payload='',updated_at=? WHERE id=? AND status='processing'").run(nextAttempts, errorCode, now, id);
      return;
    }
    const delay = Math.min(60 * 60_000, 5_000 * (2 ** Math.min(nextAttempts - 1, 10)));
    this.db.prepare("UPDATE mail_queue SET status='queued',attempts=?,next_attempt_at=?,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=? AND status='processing'").run(nextAttempts, now + delay, errorCode, now, id);
  }
  close(): void { this.db.close(); }
}
