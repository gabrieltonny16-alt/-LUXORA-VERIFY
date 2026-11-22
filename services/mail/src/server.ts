import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { MailQueue, type MailPayload } from "./queue.js";

export interface MailEnv {
  PORT: number; INTERNAL_SERVICE_TOKEN: string; QUEUE_DB_PATH: string; QUEUE_ENCRYPTION_KEY: string;
  SMTP_HOST: string; SMTP_PORT: number; SMTP_SECURE: boolean; SMTP_USER: string; SMTP_PASSWORD: string;
  MAIL_FROM: string; MAIL_FROM_NAME: string;
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
  if (Buffer.byteLength(token, "utf8") < 32) throw new Error("INTERNAL_SERVICE_TOKEN must be at least 32 bytes");
  const queueKey = required("QUEUE_ENCRYPTION_KEY");
  if (Buffer.from(queueKey, "base64").length !== 32) throw new Error("QUEUE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return {
    PORT: port, INTERNAL_SERVICE_TOKEN: token, QUEUE_DB_PATH: process.env.QUEUE_DB_PATH?.trim() || "./data/mail-queue.sqlite",
    QUEUE_ENCRYPTION_KEY: queueKey, SMTP_HOST: required("SMTP_HOST"), SMTP_PORT: smtpPort,
    SMTP_SECURE: process.env.SMTP_SECURE === "true", SMTP_USER: required("SMTP_USER"),
    SMTP_PASSWORD: required("SMTP_PASSWORD"), MAIL_FROM: required("MAIL_FROM"),
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME?.trim() || "LUXORA VERIFY",
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
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided, "utf8"), right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
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
      const auth = request.headers.authorization ?? "";
      const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!tokenMatches(supplied, env.INTERNAL_SERVICE_TOKEN)) { sendJson(response, 401, { error: "unauthorized" }); return; }
      sendJson(response, 200, { queue: queue.stats() });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/deliveries") {
      sendJson(response, 404, { error: "not_found" }); return;
    }
    const auth = request.headers.authorization ?? "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!tokenMatches(supplied, env.INTERNAL_SERVICE_TOKEN)) { sendJson(response, 401, { error: "unauthorized" }); return; }
    let payload: unknown;
    try { payload = await readBody(request); } catch { sendJson(response, 400, { error: "invalid_request" }); return; }
    if (!validDelivery(payload)) { sendJson(response, 400, { error: "invalid_request" }); return; }
    const key = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(key) ? key[0] : key;
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      sendJson(response, 400, { error: "idempotency_key_required" }); return;
    }
    try {
      const result = queue.enqueue(idempotencyKey, payload);
      sendJson(response, 202, { accepted: true, delivery_id: result.id, status: result.status, duplicate: !result.created });
    } catch { sendJson(response, 503, { error: "queue_unavailable" }); }
  });
}
async function deliverOne(queue: MailQueue, transport: Pick<Transporter, "sendMail">, env: MailEnv): Promise<void> {
  const item = queue.claim();
  if (!item) return;
  try {
    const message = messageFor(item.payload);
    await transport.sendMail({
      from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM }, to: item.payload.destination,
      subject: message.subject, text: message.text, html: message.html,
      headers: { "X-Luxora-Message-Class": "verification", "X-Luxora-Delivery-Id": item.id },
    });
    queue.markSent(item.id);
  } catch {
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
  server.listen(env.PORT, "127.0.0.1", () => process.stdout.write(`LUXORA MAIL listening on 127.0.0.1:${env.PORT}\n`));
  const shutdown = () => { clearInterval(poll); server.close(); queue.close(); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
if (process.env.NODE_ENV !== "test") {
  startMailService().catch(() => { process.stderr.write("LUXORA MAIL failed to start; check private configuration.\n"); process.exitCode = 1; });
}
