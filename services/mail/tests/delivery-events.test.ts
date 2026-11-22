import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { MailQueue } from "../src/queue.js";
import { createMailServer, type MailEnv } from "../src/server.js";

const token = "test-internal-token-that-is-at-least-32-bytes";
const env: MailEnv = {
  PORT: 8788, INTERNAL_SERVICE_TOKEN: token, QUEUE_DB_PATH: ":memory:",
  QUEUE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SMTP_HOST: "localhost",
  SMTP_PORT: 587, SMTP_SECURE: false, SMTP_USER: "test", SMTP_PASSWORD: "test",
  MAIL_FROM: "verify@example.test", MAIL_FROM_NAME: "LUXORA VERIFY",
};
const payload = { destination: "person@example.com", code: "123456", purpose: "sign_up" as const };

async function withServer(run: (baseUrl: string, queue: MailQueue) => Promise<void>) {
  const queue = new MailQueue(":memory:", env.QUEUE_ENCRYPTION_KEY);
  const server = createMailServer(env, queue);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`, queue); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    queue.close();
  }
}

test("hard bounces suppress recipients and cancel queued mail", () => {
  const queue = new MailQueue(":memory:", env.QUEUE_ENCRYPTION_KEY);
  try {
    queue.enqueue("challenge-hard-bounce-001", payload);
    const event = { eventId: "provider-event-0001", type: "hard_bounce" as const, recipient: "PERSON@example.com" };
    assert.deepEqual(queue.recordDeliveryEvent(event), { duplicate: false, suppressed: true });
    assert.equal(queue.isSuppressed("person@example.com"), true);
    assert.deepEqual(queue.stats(), { queued: 0, processing: 0, sent: 0, dead: 1 });
    assert.throws(() => queue.enqueue("challenge-hard-bounce-002", payload), /Recipient is suppressed/);
    assert.deepEqual(queue.recordDeliveryEvent(event), { duplicate: true, suppressed: true });
    assert.deepEqual(queue.suppressionStats(), { total: 1, hardBounce: 1, complaint: 0, events: 1 });
  } finally { queue.close(); }
});

test("soft bounces are recorded without suppressing the recipient", () => {
  const queue = new MailQueue(":memory:", env.QUEUE_ENCRYPTION_KEY);
  try {
    const result = queue.recordDeliveryEvent({ eventId: "provider-event-0002", type: "soft_bounce", recipient: "person@example.com" });
    assert.deepEqual(result, { duplicate: false, suppressed: false });
    assert.equal(queue.isSuppressed("person@example.com"), false);
    assert.equal(queue.enqueue("challenge-soft-bounce-001", payload).status, "queued");
    assert.deepEqual(queue.suppressionStats(), { total: 0, hardBounce: 0, complaint: 0, events: 1 });
  } finally { queue.close(); }
});

test("complaints suppress and take precedence over hard-bounce reason", () => {
  const queue = new MailQueue(":memory:", env.QUEUE_ENCRYPTION_KEY);
  try {
    queue.recordDeliveryEvent({ eventId: "provider-event-0003", type: "hard_bounce", recipient: "person@example.com" });
    queue.recordDeliveryEvent({ eventId: "provider-event-0004", type: "complaint", recipient: "person@example.com" });
    assert.deepEqual(queue.suppressionStats(), { total: 1, hardBounce: 0, complaint: 1, events: 2 });
  } finally { queue.close(); }
});

test("delivery event endpoint requires authentication and validates payloads", async () => {
  await withServer(async baseUrl => {
    const body = JSON.stringify({ eventId: "provider-event-0005", type: "complaint", recipient: "person@example.com" });
    const unauthorized = await fetch(`${baseUrl}/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${baseUrl}/v1/events`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: "short", type: "complaint", recipient: "person@example.com" }),
    });
    assert.equal(invalid.status, 400);
    const accepted = await fetch(`${baseUrl}/v1/events`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, duplicate: false, suppressed: true });
    const stats = await fetch(`${baseUrl}/v1/suppressions`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(await stats.json(), { suppressions: { total: 1, hardBounce: 0, complaint: 1, events: 1 } });
    const denied = await fetch(`${baseUrl}/v1/deliveries`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "challenge-suppressed-001" },
      body: JSON.stringify(payload),
    });
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), { error: "recipient_suppressed" });
  });
});
