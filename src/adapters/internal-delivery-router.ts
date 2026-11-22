import type { OtpChannel, OtpDelivery, OtpPurpose } from "../http/handler.js";

/** Cloudflare service-binding-compatible interface for private first-party services. */
export interface InternalService { fetch(request: Request): Promise<Response>; }
export interface InternalDeliveryConfig {
  mail: InternalService; sms: InternalService; mailToken: string; smsToken: string;
}
/** Routes OTPs to LUXORA-owned delivery services without calling third-party messaging APIs. */
export class InternalDeliveryRouter implements OtpDelivery {
  constructor(private readonly services: InternalDeliveryConfig) {}
  async send(input: {
    channel: OtpChannel; destination: string; code: string; purpose: OtpPurpose; idempotencyKey: string;
  }): Promise<"queued" | "failed" | "unknown"> {
    const service = input.channel === "email" ? this.services.mail : this.services.sms;
    const token = input.channel === "email" ? this.services.mailToken : this.services.smsToken;
    const path = input.channel === "email" ? "mail" : "sms";
    try {
      const result = await service.fetch(new Request(`https://${path}.internal/v1/deliveries`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify({ destination: input.destination, code: input.code, purpose: input.purpose }),
      }));
      if (result.status === 202 || result.status === 200) return "queued";
      if (result.status >= 500) return "unknown";
      return "failed";
    } catch {
      // A network failure can happen after a downstream service accepted a message.
      // Mark unknown rather than retrying blindly and potentially duplicating an OTP.
      return "unknown";
    }
  }
}
