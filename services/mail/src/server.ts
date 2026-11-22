import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { MailQueue, RecipientSuppressedError, UnknownDeliveryEventError, type DeliveryEvent, type MailPayload } from "./queue.js";

export interface MailEnv {
  PORT: number; INTERNAL_SERVICE_TOKEN: string; EVENT_INGEST_TOKEN: string; ADMIN_TOKEN: string;
  QUEUE_DB_PATH: string; QUEUE_ENCRYPTION_KEY: string;
  SMTP_HOST: string; SMTP_PORT: number; SMTP_SECURE: boolean; SMTP_USER: string; SMTP_PASSWORD: string;
  MAIL_FROM: string; MAIL_FROM_NAME: string; BOUNCE_ADDRESS: string;
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function loadEnv(): MailEnv {
  const port = Number(process.env.PORT ?? "8788");
  const smtpPort = Number(process.env.SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error("Invalid SMTP_PORT");
  const token = required("INTERNAL_SERVICE_TOKEN");
  const eventToken = required("EVENT_INGEST_TOKEN");
  const adminToken = required("ADMIN_TOKEN");
  if (Buffer.byteLength(token, "utf8") < 32) throw new Error("INTERNAL_SERVICE_TOKEN must be at least 32 bytes");
  if (Buffer.byteLength(eventToken, "utf8") < 32) throw new Error("EVENT_INGEST_TOKEN must be at least 32 bytes");
  if (Buffer.byteLength(adminToken, "utf8") < 32) throw new Error("ADMIN_TOKEN must be at least 32 bytes");
  const queueKey = required("QUEUE_ENCRYPTION_KEY");
  if (Buffer.from(queueKey, "base64").length !== 32) throw new Error("QUEUE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return {
    PORT: port, INTERNAL_SERVICE_TOKEN: token, EVENT_INGEST_TOKEN: eventToken, ADMIN_TOKEN: adminToken,
    QUEUE_DB_PATH: process.env.QUEUE_DB_PATH?.trim() || "./data/mail-queue.sqlite",
    QUEUE_ENCRYPTION_KEY: queueKey, SMTP_HOST: required("SMTP_HOST"), SMTP_PORT: smtpPort,
    SMTP_SECURE: process.env.SMTP_SECURE === "true", SMTP_USER: required("SMTP_USER"),
    SMTP_PASSWORD: required("SMTP_PASSWORD"), MAIL_FROM: required("MAIL_FROM"),
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME?.trim() || "LUXORA VERIFY", BOUNCE_ADDRESS: required("BOUNCE_ADDRESS"),
  };
}
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 8192) { reject(new Error("body_too_large")); request.destroy(); }
    });
    request.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid_json")); } });
    request.on("error", reject);
  });
}
function validDelivery(value: unknown): value is MailPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.destination === "string" && item.destination.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.destination)
    && typeof item.code === "string" && /^\d{6}$/.test(item.code)
    && ["sign_up", "sign_in", "password_reset", "change_contact"].includes(String(item.purpose));
}
function validDeliveryEvent(value: unknown): value is DeliveryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.eventId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(item.eventId)
    && ["hard_bounce", "soft_bounce", "complaint"].includes(String(item.type))
    && typeof item.recipient === "string" && item.recipient.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.recipient);
}
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided, "utf8"), right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorized(request: IncomingMessage, token: string): boolean {
  const auth = request.headers.authorization ?? "";
  return tokenMatches(auth.startsWith("Bearer ") ? auth.slice(7) : undefined, token);
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function messageFor(input: MailPayload): { subject: string; text: string; html: string } {
  const purposeText: Record<MailPayload["purpose"], string> = {
    sign_up: "complete your registration", sign_in: "sign in to your account",
    password_reset: "reset your password", change_contact: "confirm your contact change",
  };
  const action = purposeText[input.purpose];
  return {
    subject: "Your LUXORA verification code",
    text: `Your LUXORA verification code is ${input.code}. Use it to ${action}. It expires in 5 minutes. If you did not request this code, ignore this email.`,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172033"><main style="max-width:520px;margin:32px auto;padding:28px;border:1px solid #e5e7eb;border-radius:16px"><p style="font-weight:700;letter-spacing:2px">LUXORA VERIFY</p><h1 style="font-size:22px">Your verification code</h1><p>Use this code to ${action}:</p><p style="font-size:34px;font-weight:700;letter-spacing:8px">${input.code}</p><p>This code expires in 5 minutes. If you did not request it, ignore this email.</p><small>Never share this code with anyone.</small></main></body></html>`,
  };
}
export function createMailServer(env: MailEnv, queue: MailQueue) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok", service: "luxora-mail", queue: "persistent" }); return;
    }
    if (request.method === "GET" && request.url === "/v1/queue") {
      if (!authorized(request, env.INTERNAL_SERVICE_TOKEN)) { sendJson(response, 401, { error: "unauthorized" }); return; }
      sendJson(response, 200, { queue: queue.stats() }); return;
    }
    if (request.method === "GET" && request.url === "/v1/suppressions") {
      if (!authorized(request, env.INTERNAL_SERVICE_TOKEN)) { sendJson(response, 401, { error: "unauthorized" }); return; }
      sendJson(response, 200, { suppressions: queue.suppressionStats() }); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v1/admin/")) {
      if (!authorized(request, env.ADMIN_TOKEN)) { sendJson(response, 401, { error: "unauthorized" }); return; }
      const url = new URL(request.url, "http://127.0.0.1");
      const limitText = url.searchParams.get("limit") ?? "50";
      const offsetText = url.searchParams.get("offset") ?? "0";
      if (!/^\\d{1,3}$/.test(limitText) || !/^\\d{1,6}$/.test(offsetText)) {
        sendJson(response, 400, { error: "invalid_pagination" }); return;
      }
      const limit = Math.max(1, Math.min(100, Number(limitText)));
      const offset = Math.min(100_000, Number(offsetText));
      if (url.pathname === "/v1/admin/queue") {
        sendJson(response, 200, { queue: queue.stats(), items: queue.listQueue(limit, offset), limit, offset }); return;
      }
      if (url.pathname === "/v1/admin/dead-letters") {
        sendJson(response, 200, { items: queue.listDeadLetters(limit, offset), limit, offset }); return;
      }
      if (url.pathname === "/v1/admin/suppressions") {
        sendJson(response, 200, { summary: queue.suppressionStats(), items: queue.listSuppressions(limit, offset), limit, offset }); return;
      }
      sendJson(response, 404, { error: "not_found" }); return;
    }
    if (request.method !== "POST" || !["/v1/deliveries", "/v1/events", "/v1/mta-events", "/v1/arf-events"].includes(request.url ?? "")) {
      sendJson(response, 404, { error: "not_found" }); return;
    }
    const isEvent = request.url === "/v1/events";
    const isMtaEvent = request.url === "/v1/mta-events";
    const isArfEvent = request.url === "/v1/arf-events";
    if (!authorized(request, isEvent || isMtaEvent || isArfEvent ? env.EVENT_INGEST_TOKEN : env.INTERNAL_SERVICE_TOKEN)) {
      sendJson(response, 401, { error: "unauthorized" }); return;
    }
    let payload: unknown;
    try { payload = await readBody(request); } catch { sendJson(response, 400, { error: "invalid_request" }); return; }
    if (isArfEvent) {
      if (!validDeliveryEvent(payload) || payload.type !== "complaint") { sendJson(response, 400, { error: "invalid_complaint_event" }); return; }
      const result = queue.recordDeliveryEvent(payload);
      sendJson(response, 202, { accepted: true, duplicate: result.duplicate, suppressed: result.suppressed });
      return;
    }
    if (isMtaEvent) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) { sendJson(response, 400, { error: "invalid_event" }); return; }
      const item = payload as Record<string, unknown>;
      if (typeof item.deliveryId !== "string" || !/^[a-f0-9]{32}$/i.test(item.deliveryId) || !validDeliveryEvent(item.event)) {
        sendJson(response, 400, { error: "invalid_event" }); return;
      }
      try {
        const result = queue.recordMtaDeliveryEvent(item.deliveryId, item.event);
        sendJson(response, 202, { accepted: true, duplicate: result.duplicate, suppressed: result.suppressed });
      } catch (error) {
        if (error instanceof UnknownDeliveryEventError) { sendJson(response, 409, { error: "unknown_or_mismatched_delivery" }); return; }
        sendJson(response, 503, { error: "event_processing_failed" });
      }
      return;
    }
    if (isEvent) {
      if (!validDeliveryEvent(payload)) { sendJson(response, 400, { error: "invalid_event" }); return; }
      const result = queue.recordDeliveryEvent(payload);
      sendJson(response, 202, { accepted: true, duplicate: result.duplicate, suppressed: result.suppressed });
      return;
    }
    if (!validDelivery(payload)) { sendJson(response, 400, { error: "invalid_request" }); return; }
    const key = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(key) ? key[0] : key;
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      sendJson(response, 400, { error: "idempotency_key_required" }); return;
    }
    try {
      const result = queue.enqueue(idempotencyKey, payload);
      sendJson(response, 202, { accepted: true, delivery_id: result.id, status: result.status, duplicate: !result.created });
    } catch (error) {
      if (error instanceof RecipientSuppressedError) { sendJson(response, 409, { error: "recipient_suppressed" }); return; }
      sendJson(response, 503, { error: "queue_unavailable" });
    }
  });
}
export async function deliverOne(
  queue: MailQueue,
  transport: Pick<Transporter, "sendMail">,
  env: MailEnv,
  onSmtpError?: (error: unknown) => void,
): Promise<void> {
  const item = queue.claim();
  if (!item) return;
  if (queue.isSuppressed(item.payload.destination)) { queue.markSuppressed(item.id); return; }
  try {
    const message = messageFor(item.payload);
    await transport.sendMail({
      from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM }, to: item.payload.destination,
      envelope: { from: env.BOUNCE_ADDRESS, to: [item.payload.destination] },
      dsn: { id: item.id, return: "headers", notify: ["failure", "delay"], recipient: item.payload.destination },
      subject: message.subject, text: message.text, html: message.html,
      headers: { "X-Luxora-Message-Class": "verification", "X-Luxora-Delivery-Id": item.id },
    } as never);
    queue.markSent(item.id);
  } catch (error) {
    onSmtpError?.(error);
    queue.markFailed(item.id, item.attempts, "smtp_submission_failed");
  }
}
export async function startMailService(): Promise<void> {
  const env = loadEnv();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    tls: { minVersion: "TLSv1.2" }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  const queue = new MailQueue(env.QUEUE_DB_PATH, env.QUEUE_ENCRYPTION_KEY);
  const server = createMailServer(env, queue);
  let draining = false;
  const poll = setInterval(async () => {
    if (draining) return;
    draining = true;
    try { await deliverOne(queue, transport, env); } finally { draining = false; }
  }, 1000);
  poll.unref();
  server.listen(env.PORT, "127.0.0.1", () => process.stdout.write(`LUXORA MAIL listening on 127.0.0.1:${env.PORT}
`));
  const shutdown = () => { clearInterval(poll); server.close(); queue.close(); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMailService().catch(() => { process.stderr.write("LUXORA MAIL failed to start; check private configuration.
"); process.exitCode = 1; });
}
