import { parseDeliveryStatusReport } from "./dsn.js";

async function readStdin(maxBytes = 256 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new Error("Incoming DSN exceeds the configured size limit");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function main(): Promise<void> {
  const token = process.env.EVENT_INGEST_TOKEN?.trim();
  if (!token || Buffer.byteLength(token, "utf8") < 32) throw new Error("A private EVENT_INGEST_TOKEN of at least 32 bytes is required");
  const endpoint = process.env.MAIL_EVENT_URL?.trim() || "http://127.0.0.1:8788/v1/mta-events";
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1/mta-events" || url.search || url.hash) {
    throw new Error("MAIL_EVENT_URL must be the local LUXORA MAIL MTA event endpoint");
  }
  const raw = await readStdin();
  const parsed = await parseDeliveryStatusReport(raw);
  if (!parsed) {
    process.stdout.write("LUXORA MAIL: message was not a supported, correlated DSN; no event recorded.\n");
    return;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(parsed),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const code = response.status === 409 ? "unknown_or_mismatched_delivery" : `event_endpoint_http_${response.status}`;
    throw new Error(code);
  }
  process.stdout.write("LUXORA MAIL: delivery-status event accepted.\n");
}
main().catch(error => {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`LUXORA MAIL DSN receiver failed: ${message}\n`);
  process.exitCode = 1;
});
