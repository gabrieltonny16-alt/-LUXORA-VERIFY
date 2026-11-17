import { DisabledDelivery } from "./adapters/disabled-delivery.js";
import { D1VerifyRepository, type D1Database } from "./adapters/d1-repository.js";
import { createVerifyHandler } from "./http/handler.js";

interface Env {
  DB: D1Database;
  API_KEY_PEPPER: string;
  OTP_PEPPER: string;
  DESTINATION_FINGERPRINT_PEPPER: string;
  DESTINATION_ENCRYPTION_KEY: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const handler = createVerifyHandler({
      repository: new D1VerifyRepository(env.DB),
      delivery: new DisabledDelivery(),
      apiKeyPepper: env.API_KEY_PEPPER,
      otpPepper: env.OTP_PEPPER,
      destinationFingerprintPepper: env.DESTINATION_FINGERPRINT_PEPPER,
      destinationEncryptionKey: env.DESTINATION_ENCRYPTION_KEY,
      version: "0.1.0",
    });
    return handler(request);
  },
};
