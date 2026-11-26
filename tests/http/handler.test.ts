import { describe, expect, it } from "vitest";
import { createVerifyHandler, type NewChallenge, type OtpDelivery, type StoredChallenge, type VerifyProject, type VerifyRepository } from "../../src/http/handler.js";
import { keyedFingerprint } from "../../src/core/crypto.js";
import { OTP_PROJECT_REQUESTS_PER_MINUTE } from "../../src/core/otp.js";

const apiKey = "test-project-api-key-with-sufficient-length";
const apiKeyPepper = "test-api-key-pepper-which-is-at-least-32-bytes";
const otpPepper = "test-otp-pepper-which-is-at-least-32-bytes";
const fingerprintPepper = "test-fingerprint-pepper-at-least-32-bytes";
const encryptionKey = "test-encryption-key-which-is-at-least-32-bytes";
const now = 1_800_000_000;

class TestRepository implements VerifyRepository {
  readonly challenges = new Map<string, StoredChallenge>();
  readonly auditEvents: Array<{ event: string; outcome: string }> = [];
  readonly deliveryStatuses: Array<"queued" | "failed" | "unknown"> = [];
  readonly project: VerifyProject = { id: "project_test", isActive: true, allowedChannels: ["email", "sms"] };

  async authenticateProject(keyHash: string): Promise<VerifyProject | null> {
    const expected = await keyedFingerprint(apiKey, apiKeyPepper);
    return keyHash === expected ? this.project : null;
  }

  async createChallengeIfAllowed(challenge: NewChallenge, timestamp: number): Promise<"created" | "cooldown"> {
    const previous = [...this.challenges.values()].find((item) =>
      item.projectId === challenge.projectId &&
      item.destinationFingerprint === challenge.destinationFingerprint &&
      item.createdAt + 60 > timestamp
    );
    if (previous) return "cooldown";
    const projectRequests = [...this.challenges.values()].filter((item) =>
      item.projectId === challenge.projectId && item.createdAt > timestamp - 60
    ).length;
    if (projectRequests >= OTP_PROJECT_REQUESTS_PER_MINUTE) return "cooldown";
    this.challenges.set(challenge.id, { ...challenge });
    return "created";
  }

  async getChallenge(id: string, projectId: string): Promise<StoredChallenge | null> {
    const challenge = this.challenges.get(id);
    return challenge?.projectId === projectId ? { ...challenge } : null;
  }

  async incrementFailedAttempt(id: string, expectedAttempts: number): Promise<boolean> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.attempts !== expectedAttempts || challenge.consumedAt !== null) return false;
    challenge.attempts += 1;
    return true;
  }

  async consumeChallenge(id: string, expectedAttempts: number, timestamp: number): Promise<boolean> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.attempts !== expectedAttempts || challenge.consumedAt !== null || timestamp >= challenge.expiresAt) return false;
    challenge.consumedAt = timestamp;
    return true;
  }

  async recordDelivery(_id: string, status: "queued" | "failed" | "unknown"): Promise<void> {
    this.deliveryStatuses.push(status);
  }
  async audit(event: { event: string; outcome: string }): Promise<void> {
    this.auditEvents.push({ event: event.event, outcome: event.outcome });
  }
}

function setup() {
  const repository = new TestRepository();
  let deliveredCode = "";
  const delivery: OtpDelivery = {
    async send(input) {
      deliveredCode = input.code;
      return "queued";
    },
  };
  const handler = createVerifyHandler({
    repository,
    delivery,
    apiKeyPepper,
    otpPepper,
    destinationFingerprintPepper: fingerprintPepper,
    destinationEncryptionKey: encryptionKey,
    now: () => now,
  });
  return { handler, repository, getDeliveredCode: () => deliveredCode };
}

async function post(handler: (request: Request) => Promise<Response>, path: string, body: unknown, key = apiKey) {
  return handler(new Request("https://verify.test" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("LUXORA VERIFY HTTP API", () => {
  it("reports health without requiring project credentials", async () => {
    const { handler } = setup();
    const result = await handler(new Request("https://verify.test/health"));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "ok", service: "luxora-verify" });
  });

  it("rejects requests without a valid project credential", async () => {
    const { handler } = setup();
    const result = await post(handler, "/v1/otp/requests", {
      channel: "email", destination: "person@example.com", purpose: "sign_up",
    }, "invalid-project-key-with-enough-length");
    expect(result.status).toBe(401);
  });

  it("creates an OTP challenge without returning the code", async () => {
    const { handler, repository, getDeliveredCode } = setup();
    const result = await post(handler, "/v1/otp/requests", {
      channel: "email", destination: "Person@Example.com", purpose: "sign_up",
    });
    const body = await result.json() as Record<string, unknown>;
    expect(result.status).toBe(202);
    expect(body).toMatchObject({ status: "accepted", expires_in: 300, resend_after: 60 });
    expect(body).not.toHaveProperty("code");
    expect(getDeliveredCode()).toMatch(/^\d{6}$/);
    expect(repository.challenges.size).toBe(1);
    expect(repository.deliveryStatuses).toEqual(["queued"]);
    expect(repository.auditEvents).toContainEqual({ event: "otp.requested", outcome: "queued" });
    expect([...repository.challenges.values()][0]?.destinationCiphertext).not.toContain("person@example.com");
  });

  it("enforces resend cooldown for the same destination and purpose", async () => {
    const { handler } = setup();
    const payload = { channel: "email", destination: "person@example.com", purpose: "sign_up" };
    expect((await post(handler, "/v1/otp/requests", payload)).status).toBe(202);
    expect((await post(handler, "/v1/otp/requests", payload)).status).toBe(429);
  });

  it("enforces resend cooldown across OTP purposes on the same channel", async () => {
    const { handler } = setup();
    const first = { channel: "email", destination: "person@example.com", purpose: "sign_up" };
    const second = { channel: "email", destination: "person@example.com", purpose: "password_reset" };
    expect((await post(handler, "/v1/otp/requests", first)).status).toBe(202);
    expect((await post(handler, "/v1/otp/requests", second)).status).toBe(429);
  });

  it("limits OTP requests to 60 per project in a rolling minute", async () => {
    const { handler, repository } = setup();
    for (let index = 0; index < OTP_PROJECT_REQUESTS_PER_MINUTE; index += 1) {
      const result = await post(handler, "/v1/otp/requests", {
        channel: "email", destination: `person${index}@example.com`, purpose: "sign_up",
      });
      expect(result.status).toBe(202);
    }
    const limited = await post(handler, "/v1/otp/requests", {
      channel: "email", destination: "person61@example.com", purpose: "sign_up",
    });
    expect(limited.status).toBe(429);
    expect(repository.challenges.size).toBe(OTP_PROJECT_REQUESTS_PER_MINUTE);
  });

  it("verifies a code once and rejects reuse", async () => {
    const { handler, getDeliveredCode } = setup();
    const request = await post(handler, "/v1/otp/requests", {
      channel: "email", destination: "person@example.com", purpose: "sign_up",
    });
    const challenge = await request.json() as { challenge_id: string };
    const verification = await post(handler, "/v1/otp/verifications", {
      challenge_id: challenge.challenge_id, code: getDeliveredCode(),
    });
    expect(verification.status).toBe(200);
    expect(await verification.json()).toMatchObject({ verified: true });
    const replay = await post(handler, "/v1/otp/verifications", {
      challenge_id: challenge.challenge_id, code: getDeliveredCode(),
    });
    expect(replay.status).toBe(400);
  });

  it("does not disclose whether a challenge belongs to another project", async () => {
    const { handler } = setup();
    const result = await post(handler, "/v1/otp/verifications", {
      challenge_id: "challenge_id_that_does_not_exist", code: "123456",
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ verified: false, error: "verification_failed" });
  });

  it("rejects malformed destinations and unsupported channels", async () => {
    const { handler } = setup();
    expect((await post(handler, "/v1/otp/requests", {
      channel: "email", destination: "not-an-email", purpose: "sign_up",
    })).status).toBe(400);
    expect((await post(handler, "/v1/otp/requests", {
      channel: "whatsapp", destination: "+254700000000", purpose: "sign_up",
    })).status).toBe(400);
  });
});
