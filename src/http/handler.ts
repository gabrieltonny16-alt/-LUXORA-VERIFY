import { checkOtp, generateOtp, hashOtp, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS, OTP_TTL_SECONDS, type OtpChallengeState } from "../core/otp.js";
import { decryptValue, encryptValue, keyedFingerprint } from "../core/crypto.js";

export type OtpChannel = "email" | "sms";
export type OtpPurpose = "sign_up" | "sign_in" | "password_reset" | "change_contact";

export interface VerifyProject {
  id: string;
  isActive: boolean;
  allowedChannels: readonly OtpChannel[];
}

export interface StoredChallenge extends OtpChallengeState {
  id: string;
  projectId: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  destinationFingerprint: string;
  destinationCiphertext: string;
  resendAfter: number;
}

export interface NewChallenge extends StoredChallenge {}

export interface VerifyRepository {
  authenticateProject(keyHash: string): Promise<VerifyProject | null>;
  createChallengeIfAllowed(challenge: NewChallenge, now: number): Promise<"created" | "cooldown">;
  getChallenge(id: string, projectId: string): Promise<StoredChallenge | null>;
  incrementFailedAttempt(id: string, expectedAttempts: number, now: number): Promise<boolean>;
  consumeChallenge(id: string, expectedAttempts: number, now: number): Promise<boolean>;
  recordDelivery(id: string, status: "sent" | "failed" | "unknown"): Promise<void>;
  audit(event: { projectId: string; challengeId?: string; event: string; outcome: string; at: number }): Promise<void>;
}

export interface OtpDelivery {
  send(input: { channel: OtpChannel; destination: string; code: string; purpose: OtpPurpose }): Promise<"sent" | "failed" | "unknown">;
}

export interface VerifyConfig {
  repository: VerifyRepository;
  delivery: OtpDelivery;
  apiKeyPepper: string;
  otpPepper: string;
  destinationFingerprintPepper: string;
  destinationEncryptionKey: string;
  version?: string;
  now?: () => number;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDestination(channel: OtpChannel, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return null;
  if (channel === "email") {
    const normalized = trimmed.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
  }
  const compact = trimmed.replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function authenticate(request: Request, config: VerifyConfig): Promise<VerifyProject | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{24,200})$/.exec(header);
  if (!match) return null;
  const keyHash = await keyedFingerprint(match[1]!, config.apiKeyPepper);
  const project = await config.repository.authenticateProject(keyHash);
  return project?.isActive ? project : null;
}

export function createVerifyHandler(config: VerifyConfig): (request: Request) => Promise<Response> {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return response({ status: "ok", service: "luxora-verify", version: config.version ?? "0.1.0" });
    }

    if (url.pathname !== "/v1/otp/requests" && url.pathname !== "/v1/otp/verifications") {
      return response({ error: "not_found" }, 404);
    }
    if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);

    let project: VerifyProject | null;
    try {
      project = await authenticate(request, config);
    } catch {
      return response({ error: "service_unavailable" }, 503);
    }
    if (!project) return response({ error: "unauthorized" }, 401);

    const body = await readJson(request);
    if (!body) return response({ error: "invalid_request" }, 400);
    const timestamp = now();

    if (url.pathname === "/v1/otp/requests") {
      const channel = body.channel;
      const purpose = body.purpose;
      if (channel !== "email" && channel !== "sms") return response({ error: "invalid_request" }, 400);
      if (!["sign_up", "sign_in", "password_reset", "change_contact"].includes(String(purpose))) {
        return response({ error: "invalid_request" }, 400);
      }
      if (!project.allowedChannels.includes(channel)) return response({ error: "channel_not_allowed" }, 403);
      const destination = normalizeDestination(channel, body.destination);
      if (!destination) return response({ error: "invalid_request" }, 400);

      try {
        const fingerprint = await keyedFingerprint(channel + ":" + destination, config.destinationFingerprintPepper);
        const challengeId = crypto.randomUUID();
        const code = generateOtp();
        const challenge: NewChallenge = {
          id: challengeId,
          projectId: project.id,
          channel,
          purpose: purpose as OtpPurpose,
          destinationFingerprint: fingerprint,
          destinationCiphertext: await encryptValue(destination, config.destinationEncryptionKey),
          codeHmacHex: await hashOtp(code, config.otpPepper),
          createdAt: timestamp,
          expiresAt: timestamp + OTP_TTL_SECONDS,
          resendAfter: timestamp + OTP_RESEND_COOLDOWN_SECONDS,
          attempts: 0,
          maxAttempts: OTP_MAX_ATTEMPTS,
          consumedAt: null,
        };
        const created = await config.repository.createChallengeIfAllowed(challenge, timestamp);
        if (created === "cooldown") return response({ error: "try_again_later" }, 429);

        let deliveryStatus: "sent" | "failed" | "unknown";
        try {
          const decryptedDestination = await decryptValue(challenge.destinationCiphertext, config.destinationEncryptionKey);
          deliveryStatus = await config.delivery.send({ channel, destination: decryptedDestination, code, purpose: purpose as OtpPurpose });
        } catch {
          deliveryStatus = "failed";
        }
        await config.repository.recordDelivery(challengeId, deliveryStatus);
        await config.repository.audit({ projectId: project.id, challengeId, event: "otp.requested", outcome: deliveryStatus, at: timestamp });
        if (deliveryStatus !== "sent") return response({ error: "delivery_unavailable" }, 503);
        return response({ challenge_id: challengeId, status: "accepted", expires_in: OTP_TTL_SECONDS, resend_after: OTP_RESEND_COOLDOWN_SECONDS }, 202);
      } catch {
        return response({ error: "service_unavailable" }, 503);
      }
    }

    if (typeof body.challenge_id !== "string" || body.challenge_id.length < 16 || body.challenge_id.length > 80 || typeof body.code !== "string") {
      return response({ error: "invalid_request" }, 400);
    }
    try {
      const challenge = await config.repository.getChallenge(body.challenge_id, project.id);
      if (!challenge) return response({ verified: false, error: "verification_failed" }, 400);
      const state: OtpChallengeState = {
        codeHmacHex: challenge.codeHmacHex,
        createdAt: challenge.createdAt,
        expiresAt: challenge.expiresAt,
        attempts: challenge.attempts,
        maxAttempts: challenge.maxAttempts,
        consumedAt: challenge.consumedAt,
      };
      const result = await checkOtp(body.code, state, config.otpPepper, timestamp);
      if (!result.ok) {
        if (result.reason === "invalid_code") {
          await config.repository.incrementFailedAttempt(challenge.id, challenge.attempts, timestamp);
        }
        await config.repository.audit({ projectId: project.id, challengeId: challenge.id, event: "otp.verification", outcome: result.reason, at: timestamp });
        return response({ verified: false, error: "verification_failed" }, 400);
      }
      const consumed = await config.repository.consumeChallenge(challenge.id, challenge.attempts, timestamp);
      if (!consumed) return response({ verified: false, error: "verification_failed" }, 400);
      await config.repository.audit({ projectId: project.id, challengeId: challenge.id, event: "otp.verification", outcome: "verified", at: timestamp });
      return response({ verified: true, verification_id: challenge.id });
    } catch {
      return response({ error: "service_unavailable" }, 503);
    }
  };
}
