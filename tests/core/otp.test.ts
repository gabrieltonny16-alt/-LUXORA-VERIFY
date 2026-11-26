import { describe, expect, it } from "vitest";
import {
  checkOtp,
  generateOtp,
  hashOtp,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  type OtpChallengeState,
} from "../../src/core/otp.js";

const pepper = "test-only-pepper-with-at-least-32-bytes";
const now = 1_800_000_000;

async function challengeFor(code: string, overrides: Partial<OtpChallengeState> = {}): Promise<OtpChallengeState> {
  return {
    codeHmacHex: await hashOtp(code, pepper),
    createdAt: now,
    expiresAt: now + OTP_TTL_SECONDS,
    attempts: 0,
    maxAttempts: OTP_MAX_ATTEMPTS,
    consumedAt: null,
    ...overrides,
  };
}

describe("OTP generation", () => {
  it("creates six decimal digits, including leading zeroes", () => {
    for (let index = 0; index < 100; index += 1) {
      const code = generateOtp();
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(OTP_LENGTH);
    }
  });

  it("uses the documented initial policy", () => {
    expect(OTP_TTL_SECONDS).toBe(300);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
  });
});

describe("OTP hashing and verification", () => {
  it("produces a stable 32-byte HMAC digest", async () => {
    const first = await hashOtp("001234", pepper);
    const second = await hashOtp("001234", pepper);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a pepper shorter than 32 bytes", async () => {
    await expect(hashOtp("123456", "short")).rejects.toThrow(/32 bytes/);
  });

  it("rejects malformed codes before hashing", async () => {
    await expect(hashOtp("12345", pepper)).rejects.toThrow(/six digits/);
    await expect(hashOtp("12a456", pepper)).rejects.toThrow(/six digits/);
  });

  it("accepts the correct unexpired code", async () => {
    const challenge = await challengeFor("004219");
    await expect(checkOtp("004219", challenge, pepper, now)).resolves.toEqual({ ok: true });
  });

  it("rejects an incorrect code", async () => {
    const challenge = await challengeFor("004219");
    await expect(checkOtp("004220", challenge, pepper, now)).resolves.toEqual({
      ok: false,
      reason: "invalid_code",
    });
  });

  it("rejects expired challenges", async () => {
    const challenge = await challengeFor("004219", { expiresAt: now });
    await expect(checkOtp("004219", challenge, pepper, now)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects already consumed challenges", async () => {
    const challenge = await challengeFor("004219", { consumedAt: now - 1 });
    await expect(checkOtp("004219", challenge, pepper, now)).resolves.toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  it("rejects challenges at their attempt limit", async () => {
    const challenge = await challengeFor("004219", { attempts: OTP_MAX_ATTEMPTS });
    await expect(checkOtp("004219", challenge, pepper, now)).resolves.toEqual({
      ok: false,
      reason: "attempts_exhausted",
    });
  });
});
