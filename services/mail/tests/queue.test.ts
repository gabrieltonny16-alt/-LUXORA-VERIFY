import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { MailQueue } from "../src/queue.js";

test("mail queue persists encrypted deliveries and deduplicates challenge IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "luxora-mail-"));
  const path = join(directory, "queue.sqlite");
  const key = randomBytes(32).toString("base64");
  const payload = { destination: "person@example.com", code: "123456", purpose: "sign_up" as const };
  try {
    const first = new MailQueue(path, key);
    const accepted = first.enqueue("challenge-idempotency-001", payload);
    assert.equal(accepted.created, true);
    assert.equal(accepted.status, "queued");
    const duplicate = first.enqueue("challenge-idempotency-001", payload);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, accepted.id);
    assert.throws(() => first.enqueue("challenge-idempotency-001", { ...payload, code: "654321" }));
    first.close();

    const afterRestart = new MailQueue(path, key);
    const claimed = afterRestart.claim();
    assert.ok(claimed);
    assert.equal(claimed.id, accepted.id);
    assert.deepEqual(claimed.payload, payload);
    afterRestart.markSent(claimed.id);
    afterRestart.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mail queue rejects an invalid encryption key", () => {
  assert.throws(() => new MailQueue(":memory:", randomBytes(16).toString("base64")));
});
