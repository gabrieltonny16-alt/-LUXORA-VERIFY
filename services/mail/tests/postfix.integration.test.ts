import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { MailQueue } from "../src/queue.js";
import { createMailServer, deliverOne, type MailEnv } from "../src/server.js";
import { parseDeliveryStatusReport } from "../src/dsn.js";

const enabled = process.env.LUXORA_POSTFIX_TEST === "1";
const mailbox = process.env.LUXORA_POSTFIX_MAILBOX || "/var/mail/runner";

async function waitForDsn(deliveryId: string, timeoutMs = 20_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(mailbox);
      if (contents.includes(Buffer.from(deliveryId))) return contents;
    } catch { /* Postfix may not have delivered the first message yet. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Postfix did not deliver a DSN to the local bounce mailbox in time");
}

test("real Postfix SMTP submission -> generated RFC 3464 DSN -> LUXORA suppression", { skip: !enabled }, async () => {
  const queueKey = randomBytes(32).toString("base64");
  const queue = new MailQueue(":memory:", queueKey);
  const eventToken = "postfix-integration-event-token-32-bytes";
  const internalToken = "postfix-integration-internal-token-32-bytes";
  const env: MailEnv = {
    PORT: 0, INTERNAL_SERVICE_TOKEN: internalToken, EVENT_INGEST_TOKEN: eventToken,
    QUEUE_DB_PATH: ":memory:", QUEUE_ENCRYPTION_KEY: queueKey,
    SMTP_HOST: "127.0.0.1", SMTP_PORT: 25, SMTP_SECURE: false,
    SMTP_USER: "", SMTP_PASSWORD: "", MAIL_FROM: "verify@luxora.test",
    MAIL_FROM_NAME: "LUXORA VERIFY", BOUNCE_ADDRESS: "bounces@luxora.test",
  };
  const api = createMailServer(env, queue);
  const apiPort = await new Promise<number>((resolve, reject) => {
    api.once("error", reject);
    api.listen(0, "127.0.0.1", () => {
      const address = api.address();
      if (!address || typeof address === "string") return reject(new Error("Local API did not bind"));
      resolve(address.port);
    });
  });
  const transport = nodemailer.createTransport({
    host: "127.0.0.1", port: 25, secure: false,
    connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000,
  });
  const destination = "unknown-postfix-recipient@luxora.test";
  let smtpFailure = "none";
  try {
    const queued = queue.enqueue("postfix-integration-delivery-0001", {
      destination, code: "123456", purpose: "sign_up",
    });
    await deliverOne(queue, transport, env, error => {
      smtpFailure = error instanceof Error ? error.message : String(error);
    });
    assert.equal(queue.stats().sent, 1, `Postfix must accept SMTP submission; safe diagnostic: ${smtpFailure}`);

    const rawDsn = await waitForDsn(queued.id);
    const parsed = await parseDeliveryStatusReport(rawDsn);
    assert.ok(parsed, "Postfix must generate a parseable RFC 3464 permanent-failure report");
    assert.equal(parsed.deliveryId, queued.id, "Postfix must preserve the RFC 3461 envelope ID");
    assert.equal(parsed.event.type, "hard_bounce");
    assert.equal(parsed.event.recipient, destination);

    const response = await fetch(`http://127.0.0.1:${apiPort}/v1/mta-events`, {
      method: "POST",
      headers: { authorization: `Bearer ${eventToken}`, "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: parsed.deliveryId, event: parsed.event }),
    });
    assert.equal(response.status, 202, "the authenticated endpoint must accept the actual Postfix DSN");
    assert.deepEqual(await response.json(), { accepted: true, duplicate: false, suppressed: true });
    assert.equal(queue.isSuppressed(destination), true);
  } finally {
    await new Promise<void>(resolve => api.close(() => resolve()));
    transport.close();
    queue.close();
  }
});
