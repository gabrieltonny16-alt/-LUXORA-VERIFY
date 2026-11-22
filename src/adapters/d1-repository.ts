import type { NewChallenge, OtpChannel, StoredChallenge, VerifyProject, VerifyRepository } from "../http/handler.js";

interface D1Result {
  meta?: { changes?: number };
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
}

interface ProjectRow {
  id: string;
  is_active: number;
  allowed_channels: string;
}

interface ChallengeRow {
  id: string;
  project_id: string;
  channel: OtpChannel;
  purpose: StoredChallenge["purpose"];
  destination_fingerprint: string;
  destination_ciphertext: string;
  code_hmac: string;
  created_at: number;
  expires_at: number;
  resend_after: number;
  attempts: number;
  max_attempts: number;
  consumed_at: number | null;
}

function mapChallenge(row: ChallengeRow): StoredChallenge {
  return {
    id: row.id,
    projectId: row.project_id,
    channel: row.channel,
    purpose: row.purpose,
    destinationFingerprint: row.destination_fingerprint,
    destinationCiphertext: row.destination_ciphertext,
    codeHmacHex: row.code_hmac,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resendAfter: row.resend_after,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    consumedAt: row.consumed_at,
  };
}

/**
 * D1 persistence adapter. Mutating verification operations use conditional SQL
 * so concurrent requests cannot consume a challenge or spend an attempt twice.
 */
export class D1VerifyRepository implements VerifyRepository {
  constructor(
    private readonly database: D1Database,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async authenticateProject(keyHash: string): Promise<VerifyProject | null> {
    const row = await this.database.prepare(
      `SELECT p.id, p.is_active, p.allowed_channels
       FROM project_api_keys k
       JOIN projects p ON p.id = k.project_id
       WHERE k.key_hash = ?
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > ?)
       LIMIT 1`,
    ).bind(keyHash, this.clock()).first<ProjectRow>();

    if (!row || row.is_active !== 1) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.allowed_channels);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const allowedChannels = parsed.filter((item): item is OtpChannel => item === "email" || item === "sms");
    return { id: row.id, isActive: true, allowedChannels };
  }

  async createChallengeIfAllowed(challenge: NewChallenge, now: number): Promise<"created" | "cooldown"> {
    const result = await this.database.prepare(
      `INSERT INTO otp_challenges (
         id, project_id, channel, purpose, destination_fingerprint,
         destination_ciphertext, code_hmac, created_at, expires_at,
         resend_after, attempts, max_attempts, consumed_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM projects WHERE id = ? AND is_active = 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM otp_challenges
         WHERE project_id = ?
           AND destination_fingerprint = ?
           AND purpose = ?
           AND resend_after > ?
       )`,
    ).bind(
      challenge.id,
      challenge.projectId,
      challenge.channel,
      challenge.purpose,
      challenge.destinationFingerprint,
      challenge.destinationCiphertext,
      challenge.codeHmacHex,
      challenge.createdAt,
      challenge.expiresAt,
      challenge.resendAfter,
      challenge.attempts,
      challenge.maxAttempts,
      challenge.consumedAt,
      challenge.projectId,
      challenge.projectId,
      challenge.destinationFingerprint,
      challenge.purpose,
      now,
    ).run();

    return (result.meta?.changes ?? 0) === 1 ? "created" : "cooldown";
  }

  async getChallenge(id: string, projectId: string): Promise<StoredChallenge | null> {
    const row = await this.database.prepare(
      `SELECT id, project_id, channel, purpose, destination_fingerprint,
              destination_ciphertext, code_hmac, created_at, expires_at,
              resend_after, attempts, max_attempts, consumed_at
       FROM otp_challenges
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
    ).bind(id, projectId).first<ChallengeRow>();
    return row ? mapChallenge(row) : null;
  }

  async incrementFailedAttempt(id: string, expectedAttempts: number, now: number): Promise<boolean> {
    const result = await this.database.prepare(
      `UPDATE otp_challenges
       SET attempts = attempts + 1
       WHERE id = ?
         AND attempts = ?
         AND attempts < max_attempts
         AND consumed_at IS NULL
         AND expires_at > ?`,
    ).bind(id, expectedAttempts, now).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async consumeChallenge(id: string, expectedAttempts: number, now: number): Promise<boolean> {
    const result = await this.database.prepare(
      `UPDATE otp_challenges
       SET consumed_at = ?
       WHERE id = ?
         AND attempts = ?
         AND consumed_at IS NULL
         AND expires_at > ?
         AND attempts < max_attempts`,
    ).bind(now, id, expectedAttempts, now).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async recordDelivery(id: string, status: "queued" | "failed" | "unknown"): Promise<void> {
    await this.database.prepare(
      "UPDATE otp_challenges SET delivery_status = ? WHERE id = ?",
    ).bind(status, id).run();
  }

  async audit(event: { projectId: string; challengeId?: string; event: string; outcome: string; at: number }): Promise<void> {
    await this.database.prepare(
      `INSERT INTO audit_events (id, project_id, challenge_id, event_type, outcome, occurred_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    ).bind(crypto.randomUUID(), event.projectId, event.challengeId ?? null, event.event, event.outcome, event.at).run();
  }
}
