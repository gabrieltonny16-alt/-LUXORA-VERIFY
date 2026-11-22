import { createHash } from "node:crypto";
import type { DeliveryEvent } from "./queue.js";

export interface ParsedDsn { deliveryId: string; event: DeliveryEvent; }
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
function decodePart(value: string, encoding: string | undefined): string {
  const mode = encoding?.toLowerCase().trim();
  if (mode === "base64") return Buffer.from(value.replace(/\s/g, ""), "base64").toString("utf8");
  if (mode === "quoted-printable") {
    const decoded = value.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi,
      (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    return Buffer.from(decoded, "binary").toString("utf8");
  }
  if (!mode || ["7bit", "8bit", "binary"].includes(mode)) return value;
  throw new Error("Unsupported DSN transfer encoding");
}
function deliveryStatusPart(raw: Buffer): string | null {
  const message = raw.toString("utf8");
  const separator = message.search(/\r?\n\r?\n/);
  if (separator < 0) return null;
  const topHeaders = parseFields(message.slice(0, separator));
  const contentType = topHeaders.get("content-type") ?? "";
  if (!/^multipart\/report\b/i.test(contentType) || !/report-type\s*=\s*"?delivery-status"?/i.test(contentType)) return null;
  const boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 70) return null;
  const body = message.slice(separator).replace(/^\r?\n\r?\n/, "");
  const parts = body.split(`--${boundary}`).slice(1).filter(part => !part.startsWith("--"));
  const matches: string[] = [];
  for (let part of parts) {
    part = part.replace(/^\r?\n/, "");
    const headerBreak = part.match(/\r?\n\r?\n/);
    if (!headerBreak || headerBreak.index === undefined) continue;
    const headers = parseFields(part.slice(0, headerBreak.index));
    const type = ((headers.get("content-type") ?? "").split(";")[0] ?? "").trim().toLowerCase();
    if (type !== "message/delivery-status") continue;
    const content = part.slice(headerBreak.index + headerBreak[0].length).replace(/\r?\n$/, "");
    matches.push(decodePart(content, headers.get("content-transfer-encoding")));
  }
  return matches.length === 1 && matches[0] ? matches[0] : null;
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
  const reportText = deliveryStatusPart(rawBuffer);
  if (!reportText) return null;
  const blocks = reportText.split(/\r?\n[ \t]*\r?\n/).map(block => block.trim()).filter(Boolean);
  if (blocks.length < 2) return null;
  const parsedBlocks = blocks.map(parseFields);
  const envelopeId = parsedBlocks.map(fields => fields.get("original-envelope-id"))
    .find(value => value !== undefined);
  const deliveryId = envelopeId ? envelopeId.replace(/^<|>$/g, "").trim() : null;
  if (!deliveryId || !/^[a-f0-9]{32}$/i.test(deliveryId)) return null;
  const recipients = parsedBlocks.filter(fields => fields.has("final-recipient"));
  if (recipients.length !== 1 || !recipients[0]) return null;
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
