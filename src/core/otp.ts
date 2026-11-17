export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

const encoder = new TextEncoder();

export type OtpFailureReason =
  | "invalid_code"
  | "expired"
  | "already_used"
  | "attempts_exhausted";

export type OtpCheck =
  | { ok: true }
  | { ok: false; reason: OtpFailureReason };

export interface OtpChallengeState {
  codeHmacHex: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  consumedAt: number | null;
}

/**
 * Generate an unbiased six-digit decimal code using Web Crypto.
 * The returned code must only be passed to a delivery adapter; never log it.
 */
export function generateOtp(): string {
  const range = 0x1_0000_0000;
  const ceiling = Math.floor(range / 1_000_000) * 1_000_000;
  const bytes = new Uint32Array(1);

  let value: number;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0]!;
  } while (value >= ceiling);

  return String(value % 1_000_000).padStart(OTP_LENGTH, "0");
}

/** HMAC-SHA-256 prevents a database-only leak from enabling offline OTP guessing. */
export async function hashOtp(code: string, pepper: string): Promise<string> {
  if (!/^\d{6}$/.test(code)) {
    throw new Error("OTP must contain exactly six digits");
  }
  if (encoder.encode(pepper).byteLength < 32) {
    throw new Error("OTP pepper must contain at least 32 bytes");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(code));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Check a submitted code against persisted challenge state.
 * The caller must persist failed-attempt increments and successful consumption
 * atomically (conditional UPDATE), not rely on this pure check alone.
 */
export async function checkOtp(
  submittedCode: string,
  challenge: OtpChallengeState,
  pepper: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<OtpCheck> {
  if (challenge.consumedAt !== null) return { ok: false, reason: "already_used" };
  if (now >= challenge.expiresAt) return { ok: false, reason: "expired" };
  if (challenge.attempts >= challenge.maxAttempts) {
    return { ok: false, reason: "attempts_exhausted" };
  }
  if (!/^\d{6}$/.test(submittedCode)) {
    return { ok: false, reason: "invalid_code" };
  }

  const candidate = hexToBytes(await hashOtp(submittedCode, pepper));
  const expected = hexToBytes(challenge.codeHmacHex);
  return constantTimeEqual(candidate, expected)
    ? { ok: true }
    : { ok: false, reason: "invalid_code" };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return new Uint8Array(32);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Fixed-length byte comparison; inputs are always normalized to 32 bytes. */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 32; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
