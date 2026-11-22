import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MailQueue } from "../src/queue.js";
import { createMailServer, type MailEnv } from "../src/server.js";

test("private operations API exposes queue, dead-letter and suppression metadata without recipient addresses", async () => {
  const key = randomBytes(32).toString("base64");
  const queue = new MailQueue(":memory:", key);
  const adminToken = "operations-api-admin-token-at-least-32-bytes";
  const env: MailEnv = {
    PORT: 0,
    INTERNAL_SERVICE_TOKEN: "operations-api-internal-token-at-least-32-bytes",
    EVENT_INGEST_TOKEN: "operations-api-event-token-at-least-32-bytes",
    ADMIN_TOKEN: adminToken,
    QUEUE_DB_PATH: ":memory:", QUEUE_ENCRYPTION_KEY: key,
    SMTP_HOST: "127.0.0.1", SMTP_PORT: 2525, SMTP_SECURE: false,
    SMTP_USER: "", SMTP_PASSWORD: "", MAIL_FROM: "no-reply@luxora.test",
    MAIL_FROM_NAME: "LUXORA VERIFY", BOUNCE_ADDRESS: "bounces@luxora.test",
  };
  const server = createMailServer(env, queue);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Operations test server failed to bind"));
      resolve(address.port);
    });
  });
  const base = "http://127.0.0.1:" + port;
  const destination = "private-recipient@example.test";
  try {
    const queued = queue.enqueue("operations-queue-test-0001", {
      destination, code: "123456", purpose: "sign_up",
    });
    queue.recordDeliveryEvent({
      eventId: "abcdef0123456789abcdef0123456789",
      type: "complaint", recipient: destination,
    });

    const unauthorized = await fetch(base + "/v1/admin/queue");
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: "Bearer " + adminToken };
    const queueResponse = await fetch(base + "/v1/admin/queue?limit=10&offset=0", { headers });
    assert.equal(queueResponse.status, 200);
    const queueBody = await queueResponse.json() as { queue: { dead: number }; items: Array<{id:string;status:string;attempts:number}> };
    assert.equal(queueBody.queue.dead, 1);
    assert.equal(queueBody.items[0]?.id, queued.id);
    assert.equal(queueBody.items[0]?.status, "dead");
    assert.equal(JSON.stringify(queueBody).includes(destination), false);

    const deadResponse = await fetch(base + "/v1/admin/dead-letters", { headers });
    assert.equal(deadResponse.status, 200);
    const deadBody = await deadResponse.json() as { items: Array<{id:string;lastErrorCode:string|null}> };
    assert.equal(deadBody.items.length, 1);
    assert.equal(deadBody.items[0]?.id, queued.id);
    assert.equal(deadBody.items[0]?.lastErrorCode, "recipient_suppressed");

    const suppressionResponse = await fetch(base + "/v1/admin/suppressions", { headers });
    assert.equal(suppressionResponse.status, 200);
    const suppressionBody = await suppressionResponse.json() as { summary: { complaint:number }; items: Array<{recipientRef:string;reason:string}> };
    assert.equal(suppressionBody.summary.complaint, 1);
    assert.equal(suppressionBody.items[0]?.reason, "complaint");
    assert.match(suppressionBody.items[0]?.recipientRef ?? "", /^[a-f0-9]{16}$/);
    assert.equal(JSON.stringify(suppressionBody).includes(destination), false);

    const invalid = await fetch(base + "/v1/admin/queue?limit=not-a-number", { headers });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    queue.close();
  }
});
