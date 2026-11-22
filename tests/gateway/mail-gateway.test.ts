import { describe, expect, it, vi } from "vitest";
import { createMailGateway, type MailGatewayEnv } from "../../services/mail-gateway/src/index.js";

const env: MailGatewayEnv = {
  VERIFY_TO_GATEWAY_TOKEN: "v".repeat(40),
  MAIL_ORIGIN_URL: "https://mail-origin.example.com/v1/deliveries",
  MAIL_ORIGIN_TOKEN: "m".repeat(40),\n  CF_ACCESS_CLIENT_ID: "access-client-id",\n  CF_ACCESS_CLIENT_SECRET: "access-client-secret",
};
const body = { destination: "person@example.com", code: "123456", purpose: "sign_up" };
function request(overrides: { authorization?: string; key?: string; body?: unknown } = {}): Request {
  return new Request("https://gateway.internal/v1/deliveries", {
    method: "POST",
    headers: {
      authorization: overrides.authorization ?? `Bearer ${env.VERIFY_TO_GATEWAY_TOKEN}`,
      "idempotency-key": overrides.key ?? "challenge-idempotency-001",
      "content-type": "application/json",
    },
    body: JSON.stringify(overrides.body ?? body),
  });
}

describe("private LUXORA MAIL gateway", () => {
  it("rejects unauthenticated requests without contacting the mail origin", async () => {
    const upstream = vi.fn();
    const response = await createMailGateway(env, upstream)(request({ authorization: "Bearer wrong" }));
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards authenticated deliveries with a separate origin token and stable idempotency key", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      accepted: true, delivery_id: "delivery-123", status: "queued", duplicate: false,
    }), { status: 202 }));
    const response = await createMailGateway(env, upstream)(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true, delivery_id: "delivery-123", status: "queued", duplicate: false,
    });
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(env.MAIL_ORIGIN_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${env.MAIL_ORIGIN_TOKEN}`);
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("challenge-idempotency-001");\n    expect(new Headers(init?.headers).get("CF-Access-Client-Id")).toBe("access-client-id");
  });

  it("does not forward to a non-HTTPS or attacker-controlled URL", async () => {
    const upstream = vi.fn();
    const response = await createMailGateway({ ...env, MAIL_ORIGIN_URL: "http://127.0.0.1:8788/v1/deliveries" }, upstream)(request());
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses to connect when Cloudflare Access is not configured", async () => {\n    const upstream = vi.fn();\n    const response = await createMailGateway({ ...env, CF_ACCESS_CLIENT_SECRET: "" }, upstream)(request());\n    expect(response.status).toBe(503);\n    expect(upstream).not.toHaveBeenCalled();\n  });\n\n  it("does not claim acceptance when the mail origin returns an error", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("failure", { status: 500 }));
    const response = await createMailGateway(env, upstream)(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "mail_origin_unavailable" });
  });
});
