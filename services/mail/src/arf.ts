import { createHash } from "node:crypto";
import type { DeliveryEvent } from "./queue.js";

export interface ParsedArf { event: DeliveryEvent; }

function parseHeaders(block: string): Array<[string, string]> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const fields: Array<[string, string]> = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.push([line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]);
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
  throw new Error("Unsupported ARF transfer encoding");
}

function recipientAddress(value: string): string | null {
  const separator = value.indexOf(";");
  const address = (separator >= 0 ? value.slice(separator + 1) : value).trim().replace(/^<|>$/g, "");
  return address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

/**
 * Parses a single-recipient RFC 5965 abuse feedback report.
 * This validates report structure only; callers must ensure the report came
 * through a trusted feedback-loop source before passing it to this parser.
 */
export async function parseAbuseFeedbackReport(raw: Buffer | string): Promise<ParsedArf | null> {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  if (bytes.length === 0 || bytes.length > 256 * 1024) throw new Error("ARF message size is invalid");
  const message = bytes.toString("utf8");
  const separator = message.search(/\r?\n\r?\n/);
  if (separator < 0) return null;
  const topHeaders = parseHeaders(message.slice(0, separator));
  const contentType = topHeaders.find(([name]) => name === "content-type")?.[1] ?? "";
  if (!/^multipart\/report\b/i.test(contentType) || !/report-type\s*=\s*"?feedback-report"?/i.test(contentType)) return null;
  const boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 70) return null;
  const body = message.slice(separator).replace(/^\r?\n\r?\n/, "");
  const parts = body.split(`--${boundary}`).slice(1).filter(part => !/^--/.test(part.trimStart()));
  const feedbackBlocks: string[] = [];
  for (let part of parts) {
    part = part.replace(/^\r?\n/, "");
    const breakMatch = part.match(/\r?\n\r?\n/);
    if (!breakMatch || breakMatch.index === undefined) continue;
    const headers = parseHeaders(part.slice(0, breakMatch.index));
    const type = (headers.find(([name]) => name === "content-type")?.[1] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "message/feedback-report") continue;
    const content = part.slice(breakMatch.index + breakMatch[0].length).replace(/\r?\n$/, "");
    feedbackBlocks.push(decodePart(content, headers.find(([name]) => name === "content-transfer-encoding")?.[1]));
  }
  if (feedbackBlocks.length !== 1) return null;
  const fields = parseHeaders(feedbackBlocks[0]!);
  const get = (name: string) => fields.filter(([key]) => key === name).map(([, value]) => value);
  const feedbackTypes = get("feedback-type");
  if (feedbackTypes.length !== 1 || !["abuse", "fraud", "virus"].includes(feedbackTypes[0]!.toLowerCase())) return null;
  const versions = get("version");
  if (versions.length !== 1 || versions[0] !== "1") return null;

  const recipientValues = [...get("original-rcpt-to"), ...get("final-recipient")];
  if (recipientValues.length !== 1) return null;
  const recipient = recipientAddress(recipientValues[0]!);
  if (!recipient) return null;

  const eventId = createHash("sha256").update(bytes).digest("hex");
  return { event: { eventId, type: "complaint", recipient } };
}
