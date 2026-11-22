# LUXORA MAIL

First-party email delivery service for LUXORA VERIFY. It owns message composition,
SMTP submission, and the internal delivery endpoint. The SMTP host is intended to be
operated by LUXORA; this service can also be tested against a local SMTP sink.

## Runtime

Node.js 22 or later.

1. Copy `.env.example` to a private environment file.
2. Set an internal service token of at least 32 random bytes.
3. Configure an SMTP submission host, credentials, and verified sender address.
4. Install dependencies from the repository root workflow or this package.
5. Run `npm run start` from this directory.

The service binds to loopback by default. Put it behind a private network or authenticated
service gateway; do not expose its port directly to the public internet.

## Endpoints

- `GET /health`: process health only; does not disclose SMTP credentials.
- `POST /v1/deliveries`: requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
  Body: `{ "destination": "person@example.com", "code": "123456", "purpose": "sign_up" }`.
  A 202 response means the SMTP server accepted the message. It does not guarantee
  final inbox delivery.

## Self-operated mail infrastructure

This service is the application-side mail delivery component, not a public MX server.
For LUXORA-owned email delivery, provision and harden a mail host (for example Postfix)
with a stable IP, PTR/reverse DNS, SPF, DKIM signing, DMARC, TLS, queue monitoring,
bounce processing, suppression, abuse controls, and reputation monitoring. The service
must not be considered production-ready until those controls and deliverability tests
are complete.

Do not use a personal mailbox as a bulk sender. Do not send unsolicited email. Never
log OTP values, full destinations, SMTP credentials, or message bodies.
