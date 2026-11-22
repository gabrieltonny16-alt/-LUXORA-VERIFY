import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import type { DeliveryEvent } from "./queue.js";

export interface ParsedDsn {
  deliveryId: string;
  event: DeliveryEvent;
}
function parseFields(block: string): Map<string, string> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const fields = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name && !fields.has(name)) fields.set(name, value);
  }
  return fields;
}
function addressFromRecipient(value: string | undefined): string | null {
  if (!value) return null;
  const separator = value.indexOf(";");
  const address = (separator >= 0 ? value.slice(separator + 1) : value).trim().replace(/^<|>$/g, "");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && address.length <= 254 ? address : null;
}
export async function parseDeliveryStatusReport(raw: Buffer | string): Promise<ParsedDsn | null> {
  const rawBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  if (rawBuffer.length === 0 || rawBuffer.length > 256 * 1024) throw new Error("DSN message size is invalid");
  const parsed = await simpleParser(rawBuffer, { skipHtml: true, skipTextToHtml: true });
  const reports = parsed.attachments.filter(part => part.contentType.toLowerCase() === "message/delivery-status");
  if (reports.length !== 1) return null;
  const reportText = reports[0].content.toString("utf8");
  const blocks = reportText.split(/\r?\n\s*\r?\n/).map(block => block.trim()).filter(Boolean);
  if (blocks.length < 2) return null;
  const messageFields = parseFields(blocks[0]);
  const deliveryId = messageFields.get("original-envelope-id")?.replace(/^<|>$/g, "").trim();
  if (!deliveryId || !/^[a-f0-9]{32}$/i.test(deliveryId)) return null;
  const recipients = blocks.slice(1).map(parseFields).filter(fields => fields.has("final-recipient"));
  if (recipients.length !== 1) return null;
  const recipientFields = recipients[0];
  const recipient = addressFromRecipient(recipientFields.get("final-recipient"));
  if (!recipient) return null;
  const action = recipientFields.get("action")?.toLowerCase();
  const status = recipientFields.get("status") ?? "";
  let type: DeliveryEvent["type"] | null = null;
  if (action === "failed" && status.startsWith("5.")) type = "hard_bounce";
  else if ((action === "delayed" || action === "failed") && status.startsWith("4.")) type = "soft_bounce";
  if (!type) return null;
  const eventId = createHash("sha256").update(rawBuffer).digest("hex");
  return { deliveryId, event: { eventId, type, recipient } };
}
