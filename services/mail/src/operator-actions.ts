import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type OperatorActionResult =
  | { ok: true; auditId: string }
  | { ok: false; reason: "not_found" | "ambiguous_reference"; auditId: string };

export class MailOperatorActions {
  private readonly db: InstanceType<typeof Database>;
  private readonly key: Buffer;

  constructor(databasePath: string, encryptionKey: string) {
    if (databasePath === ":memory:") throw new Error("Operator actions require the persistent queue database");
    this.key = Buffer.from(encryptionKey, "base64");
    if (this.key.length !== 32) throw new Error("Invalid queue encryption key");
    this.db = new Database(databasePath);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_operator_audit (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        reason TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_operator_audit_created_idx
        ON mail_operator_audit(created_at DESC);
    `);
  }

  private audit(operatorId: string, action: string, targetRef: string, reason: string, outcome: string): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO mail_operator_audit(id,operator_id,action,target_ref,reason,outcome,created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, operatorId, action, targetRef, reason, outcome, Date.now());
    return id;
  }

  releaseSuppression(input: { recipientRef: string; operatorId: string; reason: string }): OperatorActionResult {
    const { recipientRef, operatorId, reason } = input;
    if (!/^[a-f0-9]{16}$/.test(recipientRef) || !/^[A-Za-z0-9._@-]{3,80}$/.test(operatorId)
      || reason.trim().length < 12 || reason.length > 500) {
      throw new Error("Invalid operator action");
    }
    const prefix = recipientRef.toLowerCase();
    return this.db.transaction(() => {
      const matches = this.db.prepare(
        "SELECT recipient_hash FROM mail_suppressions WHERE substr(recipient_hash,1,16)=?"
      ).all(prefix) as Array<{ recipient_hash: string }>;
      if (matches.length === 0) {
        const auditId = this.audit(operatorId, "suppression_release", prefix, reason.trim(), "not_found");
        return { ok: false, reason: "not_found" as const, auditId };
      }
      if (matches.length !== 1) {
        const auditId = this.audit(operatorId, "suppression_release", prefix, reason.trim(), "ambiguous_reference");
        return { ok: false, reason: "ambiguous_reference" as const, auditId };
      }
      this.db.prepare("DELETE FROM mail_suppressions WHERE recipient_hash=?").run(matches[0].recipient_hash);
      const auditId = this.audit(operatorId, "suppression_release", prefix, reason.trim(), "released");
      return { ok: true, auditId };
    })();
  }

  listAudit(limit = 50, offset = 0): Array<{id:string;operatorId:string;action:string;targetRef:string;reason:string;outcome:string;createdAt:number}> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.min(100_000, Math.trunc(offset)));
    const rows = this.db.prepare(`
      SELECT id,operator_id,action,target_ref,reason,outcome,created_at
      FROM mail_operator_audit ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset) as Array<{id:string;operator_id:string;action:string;target_ref:string;reason:string;outcome:string;created_at:number}>;
    return rows.map(row => ({id:row.id,operatorId:row.operator_id,action:row.action,targetRef:row.target_ref,reason:row.reason,outcome:row.outcome,createdAt:row.created_at}));
  }

  recordReplayBlocked(input: { deliveryId: string; operatorId: string; reason: string }): string {
    const { deliveryId, operatorId, reason } = input;
    if (!/^[a-f0-9]{32}$/.test(deliveryId) || !/^[A-Za-z0-9._@-]{3,80}$/.test(operatorId)
      || reason.trim().length < 12 || reason.length > 500) {
      throw new Error("Invalid operator action");
    }
    return this.audit(operatorId, "dead_letter_replay", deliveryId, reason.trim(), "blocked_payload_cleared_or_otp_expiry");
  }

  close(): void { this.db.close(); }
}
