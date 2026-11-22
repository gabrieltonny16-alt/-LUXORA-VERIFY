import type { OtpChannel, OtpDelivery, OtpPurpose } from "../http/handler.js";

/** Cloudflare service-binding-compatible interface for private first-party services. */
export interface InternalService {
  fetch(request: Request): Promise<Response>;
}

export interface InternalDeliveryConfig {
  mail: InternalService;
  sms: InternalService;
}

/**
 * Routes messages to LUXORA-owned delivery services over private service bindings.
 * No third-party provider is called by this adapter. The mail and SMS services
 * own their respective transport connections and can later add direct network links.
 */
export class InternalDeliveryRouter implements OtpDelivery {
  constructor(private readonly services: InternalDeliveryConfig) {}

  async send(input: {
    channel: OtpChannel;
    destination: string;
    code: string;
    purpose: OtpPurpose;
  }): Promise<"sent" | "failed" | "unknown"> {
    const service = input.channel === "email" ? this.services.mail : this.services.sms;
    const path = input.channel === "email" ? "mail" : "sms";
    try {
      const result = await service.fetch(new Request(`https://${path}.internal/v1/deliveries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destination: input.destination,
          code: input.code,
          purpose: input.purpose,
        }),
      }));
      if (result.status === 202 || result.status === 200) return "sent";
      if (result.status >= 500) return "unknown";
      return "failed";
    } catch {
      // A network failure can happen after a downstream service accepted a message.
      // Mark unknown rather than retrying blindly and potentially duplicating an OTP.
      return "unknown";
    }
  }
}
