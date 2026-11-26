import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeliveryStatusReport } from "../src/dsn.js";

const deliveryId = "0123456789abcdef0123456789abcdef";
function report(action: string, status: string): string {
  return [
    "From: MAILER-DAEMON@example.test",
    "To: bounces@example.test",
    "Subject: Delivery Status Notification",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="luxora-boundary"',
    "",
    "--luxora-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This is an automatically generated delivery status notification.",
    "--luxora-boundary",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.test",
    "",
    `Original-Envelope-Id: ${deliveryId}`,
    "",
    "Final-Recipient: rfc822; person@example.com",
    `Action: ${action}`,
    `Status: ${status}`,
    "--luxora-boundary--",
    "",
  ].join("\r\n");
}

test("parses permanent RFC delivery failure as a hard bounce", async () => {
  const parsed = await parseDeliveryStatusReport(report("failed", "5.1.1"));
  assert.ok(parsed);
  assert.equal(parsed.deliveryId, deliveryId);
  assert.equal(parsed.event.type, "hard_bounce");
  assert.equal(parsed.event.recipient, "person@example.com");
  assert.equal(parsed.event.eventId.length, 64);
});

test("parses temporary delay as a soft bounce", async () => {
  const parsed = await parseDeliveryStatusReport(report("delayed", "4.2.0"));
  assert.ok(parsed);
  assert.equal(parsed.event.type, "soft_bounce");
});

test("does not turn delivered or malformed reports into bounce events", async () => {
  assert.equal(await parseDeliveryStatusReport(report("delivered", "2.0.0")), null);
  assert.equal(await parseDeliveryStatusReport("From: no-dsn@example.test\r\n\r\nhello"), null);
});

test("rejects oversized DSN messages", async () => {
  await assert.rejects(() => parseDeliveryStatusReport(Buffer.alloc(256 * 1024 + 1)), /size/);
});
