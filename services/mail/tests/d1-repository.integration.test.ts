import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import test from "node:test";
import assert from "node:assert/strict";
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


test("authenticates active, unexpired project keys and maps allowed channels", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite, { keyHash: API_KEY_HASH });
    assert.deepEqual(await repository.authenticateProject(API_KEY_HASH), {
      id: "project_test", isActive: true, allowedChannels: ["email", "sms"],
    });
    sqlite.close();
  });

test("rejects revoked, expired and inactive project credentials", async () => {
    const revoked = createRepository();
    seedProject(revoked.sqlite, { keyHash: API_KEY_HASH, revokedAt: NOW - 1 });
    assert.equal(await revoked.repository.authenticateProject(API_KEY_HASH), null);
    revoked.sqlite.close();

    const expired = createRepository();
    seedProject(expired.sqlite, { keyHash: API_KEY_HASH, expiresAt: NOW });
    assert.equal(await expired.repository.authenticateProject(API_KEY_HASH), null);
    expired.sqlite.close();

    const inactive = createRepository();
    seedProject(inactive.sqlite, { keyHash: API_KEY_HASH, active: 0 });
    assert.equal(await inactive.repository.authenticateProject(API_KEY_HASH), null);
    inactive.sqlite.close();
  });

test("fails closed when a project's allowed-channel JSON is malformed", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite, { keyHash: API_KEY_HASH, channels: "not-json" });
    assert.equal(await repository.authenticateProject(API_KEY_HASH), null);
    sqlite.close();
  });

test("creates a challenge, reads it back and persists delivery status", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const item = challenge();
    assert.equal(await repository.createChallengeIfAllowed(item, NOW), "created");
    assert.deepEqual(await repository.getChallenge(item.id, item.projectId), item);
    await repository.recordDelivery(item.id, "queued");
    assert.deepEqual(sqlite.prepare("SELECT delivery_status FROM otp_challenges WHERE id = ?").get(item.id),
      { delivery_status: "queued" });
    sqlite.close();
  });

test("enforces destination cooldown across purposes in the database", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const first = challenge({ destinationFingerprint: "same-destination" });
    assert.equal(await repository.createChallengeIfAllowed(first, NOW), "created");
    const second = challenge({ purpose: "password_reset", destinationFingerprint: "same-destination" });
    assert.equal(await repository.createChallengeIfAllowed(second, NOW), "cooldown");
    sqlite.close();
  });

test("enforces the rolling project request ceiling atomically in SQL", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    for (let index = 0; index < 60; index += 1) {
      assert.equal(await repository.createChallengeIfAllowed(challenge({
        destinationFingerprint: "destination_" + index,
      }), NOW), "created");
    }
    assert.equal(await repository.createChallengeIfAllowed(challenge({
      destinationFingerprint: "destination_61",
    }), NOW), "cooldown");
    assert.deepEqual(sqlite.prepare("SELECT COUNT(*) AS count FROM otp_challenges").get(), { count: 60 });
    sqlite.close();
  });

test("uses conditional updates to prevent double-spending attempts or consuming twice", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const item = challenge();
    await repository.createChallengeIfAllowed(item, NOW);
    assert.equal(await repository.incrementFailedAttempt(item.id, 0, NOW), true);
    assert.equal(await repository.incrementFailedAttempt(item.id, 0, NOW), false);
    assert.equal(await repository.consumeChallenge(item.id, 1, NOW), true);
    assert.equal(await repository.consumeChallenge(item.id, 1, NOW), false);
    sqlite.close();
  });

test("rejects expired and exhausted challenges at the SQL boundary", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const expired = challenge({ id: "expired", expiresAt: NOW });
    await repository.createChallengeIfAllowed(expired, NOW - 100);
    assert.equal(await repository.consumeChallenge(expired.id, 0, NOW), false);

    const exhausted = challenge({ id: "exhausted", attempts: 5, maxAttempts: 5 });
    await repository.createChallengeIfAllowed(exhausted, NOW);
    assert.equal(await repository.consumeChallenge(exhausted.id, 5, NOW), false);
    assert.equal(await repository.incrementFailedAttempt(exhausted.id, 5, NOW), false);
    sqlite.close();
  });

test("writes audit records with challenge references and safe metadata", async () => {
    const { sqlite, repository } = createRepository();
    seedProject(sqlite);
    const item = challenge();
    await repository.createChallengeIfAllowed(item, NOW);
    await repository.audit({
      projectId: item.projectId, challengeId: item.id, event: "otp.requested", outcome: "queued", at: NOW,
    });
    assert.deepEqual(sqlite.prepare("SELECT project_id, challenge_id, event_type, outcome, occurred_at, metadata_json FROM audit_events")
      .get(), {
        project_id: item.projectId,
        challenge_id: item.id,
        event_type: "otp.requested",
        outcome: "queued",
        occurred_at: NOW,
        metadata_json: "{}",
      });
    sqlite.close();
});
