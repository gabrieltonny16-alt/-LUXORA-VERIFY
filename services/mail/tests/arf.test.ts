import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MailQueue } from "../src/queue.js";
import { createMailServer, type MailEnv } from "../src/server.js";
import { parseAbuseFeedbackReport } from "../src/arf.js";

function report(feedbackType = "abuse", recipient = "person@example.test"): string {
  return [
    "From: feedback-loop@example.test",
    "To: complaints@luxora.test",
    "Subject: Abuse Feedback Report",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="luxora-arf-test"',
    "",
    "--luxora-arf-test",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "A user reported this message as unwanted.",
    "--luxora-arf-test",
    "Content-Type: message/feedback-report",
    "",
    "Feedback-Type: " + feedbackType,
    "User-Agent: Example Feedback Loop",
    "Version: 1",
    "Original-Mail-From: <no-reply@luxora.test>",
    "Original-Rcpt-To: rfc822; " + recipient,
    "--luxora-arf-test--",
    "",
  ].join("\r\n");
}

test("parses a single-recipient RFC 5965 abuse report as a complaint", async () => {
  const raw = report();
  const parsed = await parseAbuseFeedbackReport(raw);
  assert.ok(parsed);
  assert.equal(parsed.event.type, "complaint");
  assert.equal(parsed.event.recipient, "person@example.test");
  assert.equal(parsed.event.eventId.length, 64);
});

test("accepts supported complaint feedback types and ignores non-complaint reports", async () => {
  assert.equal((await parseAbuseFeedbackReport(report("fraud")))?.event.type, "complaint");
  assert.equal((await parseAbuseFeedbackReport(report("virus")))?.event.type, "complaint");
  assert.equal(await parseAbuseFeedbackReport(report("not-spam")), null);
  assert.equal(await parseAbuseFeedbackReport("Subject: no report\r\n\r\nhello"), null);
});

test("rejects multiple recipients, malformed addresses, and oversized reports", async () => {
  const multi = report().replace("Original-Rcpt-To: rfc822; person@example.test",
    "Original-Rcpt-To: rfc822; person@example.test\r\nOriginal-Rcpt-To: rfc822; other@example.test");
  assert.equal(await parseAbuseFeedbackReport(multi), null);
  assert.equal(await parseAbuseFeedbackReport(report("abuse", "not-an-email")), null);
  await assert.rejects(() => parseAbuseFeedbackReport(Buffer.alloc(256 * 1024 + 1)), /size/);
});

test("authenticated ARF intake records a complaint, suppresses the recipient, and deduplicates replay", async () => {
  const queueKey = randomBytes(32).toString("base64");
  const queue = new MailQueue(":memory:", queueKey);
  const token = "arf-integration-event-token-at-least-32-bytes";
  const env: MailEnv = {
    PORT: 0, INTERNAL_SERVICE_TOKEN: "arf-integration-internal-token-32-bytes",\n    ADMIN_TOKEN: "arf-integration-admin-token-at-least-32-bytes",
    EVENT_INGEST_TOKEN: token, QUEUE_DB_PATH: ":memory:", QUEUE_ENCRYPTION_KEY: queueKey,
    SMTP_HOST: "127.0.0.1", SMTP_PORT: 2525, SMTP_SECURE: false, SMTP_USER: "",
    SMTP_PASSWORD: "", MAIL_FROM: "no-reply@luxora.test", MAIL_FROM_NAME: "LUXORA VERIFY",
    BOUNCE_ADDRESS: "bounces@luxora.test",
  };
  const server = createMailServer(env, queue);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("ARF test server failed to bind"));
      resolve(address.port);
    });
  });
  const parsed = await parseAbuseFeedbackReport(report());
  assert.ok(parsed);
  const url = `http://127.0.0.1:${port}/v1/arf-events`;
  try {
    const unauthorized = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.event),
    });
    assert.equal(unauthorized.status, 401);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(parsed.event),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, duplicate: false, suppressed: true });
    assert.equal(queue.isSuppressed("person@example.test"), true);

    const replay = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(parsed.event),
    });
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { accepted: true, duplicate: true, suppressed: true });
    const stats = queue.suppressionStats();
    assert.equal(stats.complaint, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    queue.close();
  }
});
