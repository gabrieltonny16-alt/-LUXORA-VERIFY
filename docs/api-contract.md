# API contract (v1 draft)

Base path: `/v1`

All requests use HTTPS in deployed environments and JSON bodies. Consuming projects authenticate with a project API key in the `Authorization: Bearer <key>` header. Keys are environment-scoped and never included in URLs.

## Request an OTP

`POST /v1/otp/requests`

Request:
```json
{
  "channel": "email",
  "destination": "person@example.com",
  "purpose": "sign_up"
}
```

Allowed channels: `email`, `sms`.

Initial purposes: `sign_up`, `sign_in`, `password_reset`, `change_contact`.

Success (202):
```json
{
  "challenge_id": "opaque-id",
  "status": "accepted",
  "expires_in": 300,
  "resend_after": 60
}
```

The response never contains the OTP or a provider credential.

Initial throttling defaults: 60 OTP requests per project per rolling minute, plus a 60-second resend cooldown for the same destination and channel across OTP purposes. A throttled request returns `429` with `try_again_later`. Edge/IP and risk-signal limits are additional production requirements.

## Verify an OTP

`POST /v1/otp/verifications`

Request:
```json
{
  "challenge_id": "opaque-id",
  "code": "123456"
}
```

Success (200):
```json
{
  "verified": true,
  "verification_id": "opaque-id"
}
```

Failure responses are intentionally generic. Internal audit metadata may distinguish expiry, wrong code, attempt exhaustion, throttling, and provider failure, but must not expose whether a destination belongs to an account.

## Health

`GET /health`

Returns only service availability and version. It must not reveal database identifiers, secrets, provider configuration, or internal exception details.

## Status

This is the initial contract draft. It is not yet a deployed API. Request idempotency, project provisioning, signed verification receipts, and webhook callbacks will be specified before the first consuming application is integrated.
