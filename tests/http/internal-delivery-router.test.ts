import { describe, expect, it } from "vitest";
import { InternalDeliveryRouter, type InternalService } from "../../src/adapters/internal-delivery-router.js";

const input = {
  channel: "email" as const,
  destination: "person@example.test",
  code: "123456",
  purpose: "sign_up" as const,
  idempotencyKey: "challenge_1234567890",
};

function routerFor(response: Response | Error) {
  let captured: Request | undefined;
  const service: InternalService = {
    async fetch(request) {
      captured = request;
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const router = new InternalDeliveryRouter({
    mail: service,
    sms: service,
    mailToken: "test-mail-token-that-is-at-least-32-bytes-long",
    smsToken: "test-sms-token-that-is-at-least-32-bytes-long",
  });
  return { router, getRequest: () => captured };
}

describe("InternalDeliveryRouter delivery states", () => {
  it("records HTTP 202 queue acceptance as queued, not sent", async () => {
    const { router, getRequest } = routerFor(new Response('{"accepted":true}', { status: 202 }));
    await expect(router.send(input)).resolves.toBe("queued");
    expect(getRequest()?.headers.get("idempotency-key")).toBe(input.idempotencyKey);
    expect(getRequest()?.headers.get("authorization")).toMatch(/^Bearer /);
  });

  it("treats a successful HTTP response as queued rather than inbox delivery", async () => {
    const { router } = routerFor(new Response("{}", { status: 200 }));
    await expect(router.send(input)).resolves.toBe("queued");
  });

  it("records downstream 4xx responses as failed", async () => {
    const { router } = routerFor(new Response("{}", { status: 422 }));
    await expect(router.send(input)).resolves.toBe("failed");
  });

  it("records downstream 5xx responses as unknown", async () => {
    const { router } = routerFor(new Response("{}", { status: 503 }));
    await expect(router.send(input)).resolves.toBe("unknown");
  });

  it("records transport errors as unknown because acceptance may already have happened", async () => {
    const { router } = routerFor(new Error("connection lost"));
    await expect(router.send(input)).resolves.toBe("unknown");
  });
});
