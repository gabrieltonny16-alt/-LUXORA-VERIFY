import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { MailQueue, RecipientSuppressedError } from "../src/queue.js";
import { createMailServer, deliverOne, type MailEnv } from "../src/server.js";
import { parseDeliveryStatusReport } from "../src/dsn.js";

function startLocalMta() {
  let envelopeId = "";
  let recipient = "";
  let notify = "";
  const server = createNetServer((socket: Socket) => {
    socket.write("220 local-mta.test ESMTP ready\r\n");
    let buffer = "";
    let inData = false;
    const reply = (value: string) => socket.write(value + "\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          buffer = buffer.slice(end + 5);
          inData = false;
          reply("250 2.0.0 accepted for local integration test");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^EHLO\s/i.test(line) || /^HELO\s/i.test(line)) {
          socket.write("250-local-mta.test\r\n250-DSN\r\n250 8BITMIME\r\n");
        } else if (/^MAIL FROM:/i.test(line)) {
          envelopeId = line.match(/\bENVID=([^\s]+)/i)?.[1]?.replace(/^"|"$/g, "") ?? "";
          reply("250 2.1.0 sender accepted");
        } else if (/^RCPT TO:/i.test(line)) {
          recipient = line.match(/<([^>]+)>/)?.[1] ?? "";
          notify = line.match(/\bNOTIFY=([^\s]+)/i)?.[1] ?? "";
          reply("250 2.1.5 recipient accepted");
        } else if (/^DATA$/i.test(line)) {
          inData = true;
          reply("354 end with <CRLF>.<CRLF>");
        } else if (/^(RSET|NOOP)$/i.test(line)) {
          reply("250 2.0.0 ok");
        } else if (/^QUIT$/i.test(line)) {
          reply("221 2.0.0 bye");
          socket.end();
        } else {
          reply("250 2.0.0 ok");
        }
      }
    });
  });
  return new Promise<{ port: number; envelope: () => { envelopeId: string; recipient: string; notify: string }; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Local MTA did not bind to a TCP port"));
      resolve({
        port: address.port,
        envelope: () => ({ envelopeId, recipient, notify }),
        close: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())),
      });
    });
  });
}

function makeDsn(deliveryId: string, recipient: string): string {
  return [
    "From: MAILER-DAEMON@local-mta.test",
    "To: bounces@luxora.test",
    "Subject: Delivery Status Notification",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="luxora-local-test"',
    "",
    "--luxora-local-test",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Simulated permanent delivery failure for the local integration test.",
    "--luxora-local-test",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; local-mta.test",
    "",
    `Original-Envelope-Id: ${deliveryId}`,
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    "Action: failed",
    "Status: 5.1.1",
    "--luxora-local-test--",
    "",
  ].join("\r\n");
}

test("local SMTP submission -> RFC DSN -> authenticated endpoint -> suppression", async () => {
  const mta = await startLocalMta();
  const queueKey = randomBytes(32).toString("base64");
  const queue = new MailQueue(":memory:", queueKey);
  const token = "local-integration-internal-token-32-bytes";
  const eventToken = "local-integration-event-token-32-bytes";
  const env: MailEnv = {
    PORT: 0, INTERNAL_SERVICE_TOKEN: token, EVENT_INGEST_TOKEN: eventToken,
    ADMIN_TOKEN: "local-integration-admin-token-32-bytes",
    QUEUE_DB_PATH: ":memory:", QUEUE_ENCRYPTION_KEY: queueKey,
    SMTP_HOST: "127.0.0.1", SMTP_PORT: mta.port, SMTP_SECURE: false,
    SMTP_USER: "", SMTP_PASSWORD: "", MAIL_FROM: "no-reply@luxora.test",
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
    host: "127.0.0.1", port: mta.port, secure: false,
    connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000,
  });
  const destination = "bounce-target@example.test";
  try {
    const queued = queue.enqueue("local-smtp-integration-0001", {
      destination, code: "123456", purpose: "sign_up",
    });
    await deliverOne(queue, transport, env);
    const submitted = mta.envelope();
    assert.equal(submitted.envelopeId, queued.id, "SMTP MAIL FROM must carry the internal delivery ID as ENVID");
    assert.equal(submitted.recipient.toLowerCase(), destination);
    assert.match(submitted.notify, /FAILURE/i, "SMTP RCPT TO must request failure DSNs");
    assert.equal(queue.stats().sent, 1, "the local MTA must accept the message");

    const parsed = await parseDeliveryStatusReport(makeDsn(submitted.envelopeId, submitted.recipient));
    assert.ok(parsed, "the RFC 3464 bounce must be parsed");
    assert.equal(parsed.event.type, "hard_bounce");

    const postEvent = async (event: typeof parsed.event, deliveryId = queued.id) => fetch(`http://127.0.0.1:${apiPort}/v1/mta-events`, {
      method: "POST",
      headers: { authorization: `Bearer ${eventToken}`, "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, event }),
    });
    const accepted = await postEvent(parsed.event);
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, duplicate: false, suppressed: true });
    assert.equal(queue.isSuppressed(destination), true);

    const replay = await postEvent(parsed.event);
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { accepted: true, duplicate: true, suppressed: true });

    const mismatch = await postEvent({ ...parsed.event, eventId: "mismatched-recipient-event", recipient: "other@example.test" });
    assert.equal(mismatch.status, 409, "a DSN for a different recipient must not be correlated");

    assert.throws(() => queue.enqueue("local-smtp-integration-0002", {
      destination, code: "654321", purpose: "sign_in",
    }), RecipientSuppressedError);
  } finally {
    await new Promise<void>(resolve => api.close(() => resolve()));
    await transport.close();
    await mta.close();
    queue.close();
  }
});
