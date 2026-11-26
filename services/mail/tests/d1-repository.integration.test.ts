import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1VerifyRepository, type D1Database } from "../../../src/adapters/d1-repository.js";
import type { NewChallenge } from "../../../src/http/handler.js";

const NOW = 1_800_000_000;
const API_KEY_HASH = "a".repeat(64);

function createRepository() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(readFileSync(new URL("../../../migrations/0001_initial_schema.sql", import.meta.url), "utf8"));
  const database: D1Database = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first<T>() {
          return (sqlite.prepare(query).get(...values) as T | undefined) ?? null;
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  const repository = new D1VerifyRepository(database, () => NOW);
  return { sqlite, repository };
}

function seedProject(sqlite: Database.Database, options: {
  id?: string; active?: number; channels?: string; keyHash?: string; revokedAt?: number | null; expiresAt?: number | null;
} = {}) {
  const id = options.id ?? "project_test";
  sqlite.prepare("INSERT INTO projects (id, name, environment, allowed_channels, is_active, created_at) VALUES (?, ?, 'development', ?, ?, ?)")
    .run(id, "Integration Test", options.channels ?? '["email","sms"]', options.active ?? 1, NOW);
  if (options.keyHash !== undefined || options.revokedAt !== undefined || options.expiresAt !== undefined) {
    sqlite.prepare("INSERT INTO project_api_keys (id, project_id, key_hash, label, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("key_" + id, id, options.keyHash ?? API_KEY_HASH, "test", NOW, options.expiresAt ?? null, options.revokedAt ?? null);
  }
  return id;
}

function challenge(overrides: Partial<NewChallenge> = {}): NewChallenge {
  return {
    id: "challenge_" + crypto.randomUUID(),
    projectId: "project_test",
    channel: "email",
    purpose: "sign_up",
    destinationFingerprint: "fingerprint_" + crypto.randomUUID(),
    destinationCiphertext: "encrypted-destination",
    codeHmacHex: "b".repeat(64),
    createdAt: NOW,
    expiresAt: NOW + 300,
    resendAfter: NOW + 60,
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    ...overrides,
  };
}

describe("D1VerifyRepository against real SQLite", () => {
  it("authenticates active, unexpired project keys and maps allowed channels", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite, { keyHash: API_KEY_HASH });
    await expect(repository.authenticateProject(API_KEY_HASH)).resolves.toEqual({
      id: "project_test", isActive: true, allowedChannels: ["email", "sms"],
    });
    sqlite.close();
  });

  it("rejects revoked, expired and inactive project credentials", async () => {
    const revoked = createRepository();
    seedProject(revoked.sqlite, { keyHash: API_KEY_HASH, revokedAt: NOW - 1 });
    await expect(revoked.repository.authenticateProject(API_KEY_HASH)).resolves.toBeNull();
    revoked.sqlite.close();

    const expired = createRepository();
    seedProject(expired.sqlite, { keyHash: API_KEY_HASH, expiresAt: NOW });
    await expect(expired.repository.authenticateProject(API_KEY_HASH)).resolves.toBeNull();
    expired.sqlite.close();

    const inactive = createRepository();
    seedProject(inactive.sqlite, { keyHash: API_KEY_HASH, active: 0 });
    await expect(inactive.repository.authenticateProject(API_KEY_HASH)).resolves.toBeNull();
    inactive.sqlite.close();
  });

  it("fails closed when a project's allowed-channel JSON is malformed", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite, { keyHash: API_KEY_HASH, channels: "not-json" });
    await expect(repository.authenticateProject(API_KEY_HASH)).resolves.toBeNull();
    sqlite.close();
  });

  it("creates a challenge, reads it back and persists delivery status", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const item = challenge();
    await expect(repository.createChallengeIfAllowed(item, NOW)).resolves.toBe("created");
    await expect(repository.getChallenge(item.id, item.projectId)).resolves.toMatchObject(item);
    await repository.recordDelivery(item.id, "queued");
    expect(sqlite.prepare("SELECT delivery_status FROM otp_challenges WHERE id = ?").get(item.id))
      .toEqual({ delivery_status: "queued" });
    sqlite.close();
  });

  it("enforces destination cooldown across purposes in the database", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const first = challenge({ destinationFingerprint: "same-destination" });
    await expect(repository.createChallengeIfAllowed(first, NOW)).resolves.toBe("created");
    const second = challenge({ purpose: "password_reset", destinationFingerprint: "same-destination" });
    await expect(repository.createChallengeIfAllowed(second, NOW)).resolves.toBe("cooldown");
    sqlite.close();
  });

  it("enforces the rolling project request ceiling atomically in SQL", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    for (let index = 0; index < 60; index += 1) {
      await expect(repository.createChallengeIfAllowed(challenge({
        destinationFingerprint: "destination_" + index,
      }), NOW)).resolves.toBe("created");
    }
    await expect(repository.createChallengeIfAllowed(challenge({
      destinationFingerprint: "destination_61",
    }), NOW)).resolves.toBe("cooldown");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM otp_challenges").get()).toEqual({ count: 60 });
    sqlite.close();
  });

  it("uses conditional updates to prevent double-spending attempts or consuming twice", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const item = challenge();
    await repository.createChallengeIfAllowed(item, NOW);
    await expect(repository.incrementFailedAttempt(item.id, 0, NOW)).resolves.toBe(true);
    await expect(repository.incrementFailedAttempt(item.id, 0, NOW)).resolves.toBe(false);
    await expect(repository.consumeChallenge(item.id, 1, NOW)).resolves.toBe(true);
    await expect(repository.consumeChallenge(item.id, 1, NOW)).resolves.toBe(false);
    sqlite.close();
  });

  it("rejects expired and exhausted challenges at the SQL boundary", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const expired = challenge({ id: "expired", expiresAt: NOW });
    await repository.createChallengeIfAllowed(expired, NOW - 100);
    await expect(repository.consumeChallenge(expired.id, 0, NOW)).resolves.toBe(false);

    const exhausted = challenge({ id: "exhausted", attempts: 5, maxAttempts: 5 });
    await repository.createChallengeIfAllowed(exhausted, NOW);
    await expect(repository.consumeChallenge(exhausted.id, 5, NOW)).resolves.toBe(false);
    await expect(repository.incrementFailedAttempt(exhausted.id, 5, NOW)).resolves.toBe(false);
    sqlite.close();
  });

  it("writes audit records with challenge references and safe metadata", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const item = challenge();
    await repository.createChallengeIfAllowed(item, NOW);
    await repository.audit({
      projectId: item.projectId, challengeId: item.id, event: "otp.requested", outcome: "queued", at: NOW,
    });
    expect(sqlite.prepare("SELECT project_id, challenge_id, event_type, outcome, occurred_at, metadata_json FROM audit_events")
      .get()).toEqual({
        project_id: item.projectId,
        challenge_id: item.id,
        event_type: "otp.requested",
        outcome: "queued",
        occurred_at: NOW,
        metadata_json: "{}",
      });
    sqlite.close();
  });
});
