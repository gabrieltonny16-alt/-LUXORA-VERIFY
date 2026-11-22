import { InternalDeliveryRouter, type InternalService } from "./adapters/internal-delivery-router.js";
import { D1VerifyRepository, type D1Database } from "./adapters/d1-repository.js";
import { createVerifyHandler } from "./http/handler.js";

interface Env {
  DB: D1Database;
  MAIL_SERVICE: InternalService;
  SMS_SERVICE: InternalService;
  API_KEY_PEPPER: string;
  OTP_PEPPER: string;
  DESTINATION_FINGERPRINT_PEPPER: string;
  DESTINATION_ENCRYPTION_KEY: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const handler = createVerifyHandler({
      repository: new D1VerifyRepository(env.DB),
      delivery: new InternalDeliveryRouter({
        mail: env.MAIL_SERVICE,
        sms: env.SMS_SERVICE,
      }),
      apiKeyPepper: env.API_KEY_PEPPER,
      otpPepper: env.OTP_PEPPER,
      destinationFingerprintPepper: env.DESTINATION_FINGERPRINT_PEPPER,
      destinationEncryptionKey: env.DESTINATION_ENCRYPTION_KEY,
      version: "0.2.0",
    });
    return handler(request);
  },
};
