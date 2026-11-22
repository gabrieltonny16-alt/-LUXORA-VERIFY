# LUXORA MAIL

First-party email delivery application for LUXORA VERIFY. It owns message composition,
the authenticated internal delivery endpoint, an encrypted persistent queue, event
intake and suppression decisions, and SMTP submission. The SMTP host is intended to
be operated by LUXORA.

## Runtime

Node.js 22 or later.

1. Copy `.env.example` to a private environment file.
2. Set an internal service token with at least 32 random bytes.
3. Generate a separate 32-byte queue encryption key and base64-encode it.
4. Configure an SMTP submission host, credentials, and verified sender address.
5. Install dependencies, then run `npm run typecheck`, `npm test`, and `npm run build`.
6. Start with `npm run start`.

The service binds to loopback by default. Keep the SQLite data directory on a persistent
volume and back up the database and encryption key securely. Losing the encryption key
makes queued OTP payloads unreadable. Do not share one SQLite file between multiple
independent hosts; use a single active queue worker until a distributed lease/locking
backend is deliberately introduced.

## Queue behaviour

- Delivery requests require `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` and an
  `Idempotency-Key` derived from the OTP challenge ID.
- A successful `202` means the request was durably accepted into SQLite, not that the
  recipient's inbox received it.
- Queue payloads (destination, OTP, purpose) are encrypted with AES-256-GCM at rest.
- Duplicate challenge IDs return the existing queue item instead of creating a second
  message. Reusing a key for a different still-queued payload is rejected.
- A worker claims one item at a time, recovers expired processing leases, and retries
  SMTP submission with exponential backoff up to eight attempts.
- Successfully sent and permanently failed queue rows have their encrypted payload
  cleared. Dead-letter records retain only non-sensitive delivery metadata.

## Bounce, complaint and suppression controls

- `POST /v1/events` accepts authenticated, idempotent delivery events:
  `hard_bounce`, `soft_bounce`, and `complaint`.
- Hard bounces and complaints create a durable suppression entry. Soft bounces are
  recorded for monitoring but do not automatically suppress the address.
- Suppression keys are HMAC fingerprints; the suppression tables do not store raw
  recipient addresses.
- When an address is suppressed, queued or leased messages for it are marked dead and
  their encrypted payloads are cleared. New delivery requests for that address receive
  HTTP 409 `recipient_suppressed`.
- Complaint status takes precedence over a hard-bounce reason for the same address.
- Replayed event IDs are deduplicated. `GET /v1/suppressions` returns aggregate counts
  only, never recipient addresses.

The event endpoint is an authenticated intake contract, not yet a connected bounce
receiver. A LUXORA-operated MTA DSN parser or signed provider-independent webhook
adapter must still authenticate and translate real remote delivery notifications into
this event format. Do not expose the event endpoint publicly or trust arbitrary callers.

## Endpoints

- `GET /health`: process health.
- `GET /v1/queue`: authenticated queue counters (queued, processing, sent, dead).
- `GET /v1/suppressions`: authenticated aggregate suppression/event counters.
- `POST /v1/deliveries`: authenticated, idempotent queue submission.
  Body: `{ "destination": "person@example.com", "code": "123456", "purpose": "sign_up" }`.
  Header: `Idempotency-Key: <challenge-id>`.
- `POST /v1/events`: authenticated delivery event intake.
  Body: `{ "eventId": "unique-event-id", "type": "hard_bounce", "recipient": "person@example.com" }`.

The service reports durable queue acceptance to LUXORA VERIFY (the API audit label
`sent` means accepted by the internal delivery queue, not confirmed inbox delivery).

## Self-operated mail infrastructure

This is the application-side delivery and queue service, not a public MX server or a
complete mail-hosting system. For LUXORA-owned email delivery, provision and harden a
LUXORA-operated mail host (for example Postfix) with stable IP, PTR/reverse DNS, SPF,
DKIM signing, DMARC, TLS, queue monitoring, authenticated bounce ingestion, suppression,
abuse controls, and reputation monitoring. The mail host and DNS are not provisioned by
this repository. Do not consider the system production-ready until those controls and
end-to-end deliverability tests are complete.

Do not use a personal mailbox as a bulk sender. Do not send unsolicited email. Never
log OTP values, full destinations, SMTP credentials, or message bodies.
