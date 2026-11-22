export interface MailGatewayEnv {
  VERIFY_TO_GATEWAY_TOKEN: string;
  MAIL_ORIGIN_URL: string;
  MAIL_ORIGIN_TOKEN: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}
type DeliveryBody = {
  destination: string;
  code: string;
  purpose: "sign_up" | "sign_in" | "password_reset" | "change_contact";
};
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
function equalSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = new TextEncoder().encode(actual), right = new TextEncoder().encode(expected);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}
function validBody(value: unknown): value is DeliveryBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.destination === "string" && body.destination.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.destination)
    && typeof body.code === "string" && /^\d{6}$/.test(body.code)
    && ["sign_up", "sign_in", "password_reset", "change_contact"].includes(String(body.purpose));
}
async function readLimitedBody(request: Request, limit: number): Promise<unknown | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch { return null; }
}
function originEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/v1/deliveries") return null;
    return url.toString();
  } catch { return null; }
}

/** Private Worker-to-Worker gateway. No public route is configured for this Worker. */
export function createMailGateway(
  env: MailGatewayEnv,
  upstreamFetch: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "luxora-mail-gateway" }, 200);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/deliveries") return json({ error: "not_found" }, 404);
    if (env.VERIFY_TO_GATEWAY_TOKEN.length < 32) return json({ error: "gateway_not_configured" }, 503);\n    if (!equalSecret(request.headers.get("authorization")?.startsWith("Bearer ")
      ? request.headers.get("authorization")!.slice(7) : null, env.VERIFY_TO_GATEWAY_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      return json({ error: "idempotency_key_required" }, 400);
    }
    const payload = await readLimitedBody(request, 8192);
    if (!validBody(payload)) return json({ error: "invalid_request" }, 400);
    const endpoint = originEndpoint(env.MAIL_ORIGIN_URL);
    if (!endpoint || env.MAIL_ORIGIN_TOKEN.length < 32
      || !env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      return json({ error: "gateway_not_configured" }, 503);
    }

    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${env.MAIL_ORIGIN_TOKEN}`,
      "idempotency-key": idempotencyKey,
    });
    headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
    try {
      const upstream = await upstreamFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (upstream.status !== 202) {
        return json({ error: upstream.status >= 500 ? "mail_origin_unavailable" : "mail_origin_rejected" },
          upstream.status >= 500 ? 503 : 502);
      }
      let accepted: unknown;
      try { accepted = await upstream.json(); } catch { return json({ error: "mail_origin_invalid_response" }, 502); }
      const result = typeof accepted === "object" && accepted !== null ? accepted as Record<string, unknown> : {};
      if (result.accepted !== true || typeof result.delivery_id !== "string") {
        return json({ error: "mail_origin_invalid_response" }, 502);
      }
      return json({ accepted: true, delivery_id: result.delivery_id, status: "queued", duplicate: result.duplicate === true }, 202);
    } catch {
      return json({ error: "mail_origin_unavailable" }, 503);
    }
  };
}
export default {
  fetch(request: Request, env: MailGatewayEnv): Promise<Response> {
    return createMailGateway(env)(request);
  },
};
