import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const OPERATOR_ROLES = ["owner", "admin", "operator", "auditor"] as const;
export type OperatorRole = typeof OPERATOR_ROLES[number];
export type OperatorPermission =
  | "operations.read"
  | "audit.read"
  | "suppression.release"
  | "operators.manage";

const ROLE_PERMISSIONS: Record<OperatorRole, readonly OperatorPermission[]> = {
  owner: ["operations.read", "audit.read", "suppression.release", "operators.manage"],
  admin: ["operations.read", "audit.read", "suppression.release", "operators.manage"],
  operator: ["operations.read"],
  auditor: ["operations.read", "audit.read"],
};

export interface AuthenticatedOperator {
  id: string;
  email: string;
  displayName: string;
  role: OperatorRole;
  permissions: readonly OperatorPermission[];
}

export interface OperatorSession {
  token: string;
  expiresAt: number;
  operator: AuthenticatedOperator;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function passwordHash(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class MailOperatorAuth {
  private readonly db: InstanceType<typeof Database>;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_operators (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','auditor')),
        password_salt BLOB NOT NULL,
        password_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER,
        disabled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mail_operator_sessions (
        token_hash TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES mail_operators(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS mail_operator_sessions_operator_idx
        ON mail_operator_sessions(operator_id, expires_at);
      CREATE TABLE IF NOT EXISTS mail_operator_login_attempts (
        email TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        locked_until INTEGER
      );
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

  private createRecord(input: { email: string; displayName: string; password: string; role: OperatorRole }): AuthenticatedOperator {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    if (!validEmail(email) || displayName.length < 2 || displayName.length > 80
      || input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH
      || !OPERATOR_ROLES.includes(input.role)) {
      throw new Error("Invalid operator details");
    }
    const salt = randomBytes(16);
    const hash = passwordHash(input.password, salt);
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO mail_operators(id,email,display_name,role,password_salt,password_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, email, displayName, input.role, salt, hash, now, now);
    return { id, email, displayName, role: input.role, permissions: ROLE_PERMISSIONS[input.role] };
  }

  bootstrapOwner(input: { email: string; displayName: string; password: string }): AuthenticatedOperator {
    return this.db.transaction(() => {
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM mail_operators").get() as { count: number }).count;
      if (count !== 0) throw new Error("Operator bootstrap is already complete");
      const owner = this.createRecord({ ...input, role: "owner" });
      this.writeAudit(owner.id, "owner_bootstrap", owner.id, "Initial owner account created.", "created");
      return owner;
    })();
  }

  createOperator(input: {
    actor: AuthenticatedOperator;
    email: string;
    displayName: string;
    password: string;
    role: Exclude<OperatorRole, "owner">;
  }): AuthenticatedOperator {
    if (!this.hasPermission(input.actor, "operators.manage")) throw new Error("Operator management is not permitted");
    if (input.actor.role === "admin" && input.role === "admin") throw new Error("Only an owner can create another admin");
    return this.db.transaction(() => {
      const created = this.createRecord({ email: input.email, displayName: input.displayName, password: input.password, role: input.role });
      this.writeAudit(input.actor.id, "operator_create", created.id, `Created ${created.role} account.`, "created");
      return created;
    })();
  }

  private writeAudit(operatorId: string, action: string, targetRef: string, reason: string, outcome: string): void {
    this.db.prepare(`
      INSERT INTO mail_operator_audit(id,operator_id,action,target_ref,reason,outcome,created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(randomUUID(), operatorId, action, targetRef, reason, outcome, Date.now());
  }

  authenticate(emailInput: string, password: string): OperatorSession | null {
    const email = normalizeEmail(emailInput);
    const now = Date.now();
    const attempt = this.db.prepare("SELECT window_started_at,attempts,locked_until FROM mail_operator_login_attempts WHERE email=?")
      .get(email) as {window_started_at:number;attempts:number;locked_until:number|null} | undefined;
    if (attempt?.locked_until && attempt.locked_until > now) return null;
    const row = this.db.prepare(`
      SELECT id,email,display_name,role,password_salt,password_hash,disabled_at
      FROM mail_operators WHERE email=?
    `).get(email) as {
      id:string;email:string;display_name:string;role:OperatorRole;
      password_salt:Buffer;password_hash:Buffer;disabled_at:number|null;
    } | undefined;
    const withinPasswordLimit = password.length <= PASSWORD_MAX_LENGTH;
    const candidate = passwordHash(withinPasswordLimit ? password : "invalid-password-input", row?.password_salt ?? Buffer.alloc(16));
    const storedHash = row?.password_hash ?? Buffer.alloc(32);
    if (!row || row.disabled_at !== null || !withinPasswordLimit || !safeEqual(candidate, storedHash)) {
      const expiredWindow = !attempt || now - attempt.window_started_at > 15 * 60_000;
      const windowStart = expiredWindow ? now : attempt!.window_started_at;
      const attempts = expiredWindow ? 1 : attempt!.attempts + 1;
      const lockedUntil = attempts >= 10 ? now + 15 * 60_000 : null;
      this.db.prepare(`
        INSERT INTO mail_operator_login_attempts(email,window_started_at,attempts,locked_until)
        VALUES (?,?,?,?)
        ON CONFLICT(email) DO UPDATE SET window_started_at=excluded.window_started_at,
          attempts=excluded.attempts,locked_until=excluded.locked_until
      `).run(email, windowStart, attempts, lockedUntil);
      return null;
    }
    this.db.prepare("DELETE FROM mail_operator_login_attempts WHERE email=?").run(email);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare("INSERT INTO mail_operator_sessions(token_hash,operator_id,created_at,expires_at) VALUES (?,?,?,?)")
      .run(tokenHash(token), row.id, now, expiresAt);
    this.db.prepare("UPDATE mail_operators SET last_login_at=?,updated_at=? WHERE id=?").run(now, now, row.id);
    const role = row.role;
    return {
      token, expiresAt,
      operator: { id: row.id, email: row.email, displayName: row.display_name, role, permissions: ROLE_PERMISSIONS[role] },
    };
  }

  resolveSession(token: string | undefined): AuthenticatedOperator | null {
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const row = this.db.prepare(`
      SELECT o.id,o.email,o.display_name,o.role
      FROM mail_operator_sessions s
      JOIN mail_operators o ON o.id=s.operator_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND o.disabled_at IS NULL
    `).get(tokenHash(token), Date.now()) as {
      id:string;email:string;display_name:string;role:OperatorRole;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id, email: row.email, displayName: row.display_name,
      role: row.role, permissions: ROLE_PERMISSIONS[row.role],
    };
  }

  revokeSession(token: string | undefined): boolean {
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return false;
    const result = this.db.prepare("UPDATE mail_operator_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL")
      .run(Date.now(), tokenHash(token));
    return result.changes === 1;
  }

  hasPermission(operator: AuthenticatedOperator, permission: OperatorPermission): boolean {
    return ROLE_PERMISSIONS[operator.role].includes(permission);
  }

  listOperators(): Array<{id:string;email:string;displayName:string;role:OperatorRole;createdAt:number;lastLoginAt:number|null;disabledAt:number|null}> {
    const rows = this.db.prepare(`
      SELECT id,email,display_name,role,created_at,last_login_at,disabled_at
      FROM mail_operators ORDER BY created_at ASC,id ASC
    `).all() as Array<{id:string;email:string;display_name:string;role:OperatorRole;created_at:number;last_login_at:number|null;disabled_at:number|null}>;
    return rows.map(row => ({
      id: row.id, email: row.email, displayName: row.display_name, role: row.role,
      createdAt: row.created_at, lastLoginAt: row.last_login_at, disabledAt: row.disabled_at,
    }));
  }

  close(): void { this.db.close(); }
}
