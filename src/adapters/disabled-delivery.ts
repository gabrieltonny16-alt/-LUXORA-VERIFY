import type { OtpDelivery } from "../http/handler.js";

/**
 * Safe default: no email or SMS leaves the service until a provider is
 * deliberately configured. Never use a fake successful delivery in production.
 */
export class DisabledDelivery implements OtpDelivery {
  async send(): Promise<"failed"> {
    return "failed";
  }
}
