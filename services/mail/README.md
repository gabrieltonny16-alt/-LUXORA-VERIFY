# LUXORA MAIL

First-party email delivery application for LUXORA VERIFY. It owns message composition,
the authenticated internal delivery endpoint, an encrypted persistent queue, event
intake and suppression decisions, and SMTP submission. The SMTP host is intended to
be operated by LUXORA.

## Runtime

Node.js 22 or later.

1. Copy `.env.example` to a private environment file.
2. Set distinct internal-delivery, event-ingestion, and operations-admin tokens, each with at least 32 random bytes.
3. Generate a separate 32-byte queue encryption key and base64-encode it.
4. Configure an SMTP submission host, credentials, verified sender, and dedicated bounce address.
5. Install dependencies, then run `npm run typecheck`, `npm test`, and `npm run build`.
6. Start with `npm run start`.

The service binds to loopback by default. The separate `ADMIN_TOKEN` protects read-only operations endpoints; never reuse the delivery or event-ingestion tokens. Keep the SQLite data directory on a persistent
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
- A keyed HMAC recipient fingerprint is retained on each queue row so later delivery
  reports can be checked against the original recipient without retaining the address.
- SMTP submission requests DSN failure/delay reports and sets the RFC 3461 envelope ID
  to the internal delivery ID. The envelope sender is `BOUNCE_ADDRESS`.
- Duplicate challenge IDs return the existing queue item instead of creating a second
  message. Reusing a key for a different still-queued payload is rejected.
- A worker claims one item at a time, recovers expired processing leases, and retries
  SMTP submission with exponential backoff up to eight attempts.
- Successfully sent and permanently failed queue rows have their encrypted payload
  cleared. Dead-letter records retain only non-sensitive delivery metadata.

## Actual MTA bounce receiver

The compiled `dist/dsn-receiver.js` command reads one raw RFC 3464
`multipart/report; report-type=delivery-status` message from standard input. It:

1. Extracts the original envelope ID, final recipient, action, and enhanced status code.
2. Accepts only one-recipient DSNs with a valid 32-character delivery ID.
3. Maps permanent `failed` / `5.x.x` reports to hard bounces and temporary
   `delayed` or `failed` / `4.x.x` reports to soft bounces.
4. Derives a stable event ID from the raw DSN bytes, then posts it to the loopback-only
   `/v1/mta-events` endpoint using `EVENT_INGEST_TOKEN`.
5. The endpoint checks that the delivery ID exists and that the reported recipient's
   HMAC fingerprint matches the original queued delivery before recording anything.

Unmatched, malformed, multi-recipient, delivered, and unsupported reports are ignored.
The receiver does not trust a recipient address or delivery ID merely because they occur
in an email header. The local endpoint must never be exposed publicly.

### Postfix integration plan

The intended topology is:

`bounces@your-domain.example` -> Postfix local/virtual recipient routing ->
restricted Postfix `pipe` transport -> `node /opt/luxora-mail/dist/dsn-receiver.js` ->
`127.0.0.1:8788/v1/mta-events`.

A Postfix pipe transport can invoke the receiver with the raw message on stdin. The
receiver process needs access to the same private `EVENT_INGEST_TOKEN` as LUXORA MAIL.
Use a root-managed, least-privilege environment file readable only by the dedicated
mail service account; never put the token in a command-line argument, Postfix log, or
world-readable configuration. Route only the dedicated bounce address to this pipe.
Keep normal mail routing separate.

The mail host must support RFC 3461/3464 DSN extensions and preserve the original
envelope ID. If the upstream SMTP server does not support DSN, automatic correlation
cannot work; do not silently infer delivery IDs from subjects or untrusted message
headers. Test this end-to-end using controlled test addresses before enabling production
routing.

This receiver handles delivery-status notifications, not spam complaints. Complaints
need a separate authenticated ARF/feedback-loop parser and are not inferred from DSNs.

## Bounce, complaint and suppression controls

- `POST /v1/events` requires the separate `EVENT_INGEST_TOKEN` and accepts internal
  authenticated `hard_bounce`, `soft_bounce`, and `complaint` events.
- `POST /v1/mta-events` requires the same private event-ingestion token plus a delivery
  ID and event. It verifies the stored recipient fingerprint before accepting a DSN.
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


## ARF complaint receiver

The compiled `dist/arf-receiver.js` command reads one RFC 5965
`multipart/report; report-type=feedback-report` message from standard input. It accepts
only a single-recipient report whose `Feedback-Type` is `abuse`, `fraud`, or `virus`,
then derives a stable event ID from the raw report and posts a complaint event to the
loopback-only `/v1/arf-events` endpoint using the separate `EVENT_INGEST_TOKEN`.
Run it with `npm run receive-arf` after building. The optional
`MAIL_ARF_EVENT_URL` must remain a loopback URL ending in `/v1/arf-events`.

**Trust boundary:** ARF is a report format, not proof that the reporter or feedback-loop
source is authentic. The parser validates structure; it does not verify DKIM signatures,
provider identity, or the source IP. The Postfix/mail-host configuration must route only
reports received through a separately verified, trusted feedback-loop source to this
receiver. Do not pipe arbitrary inbound mail to it or expose the endpoint publicly.
Until provider-specific source authentication is configured and tested, treat ARF intake
as an isolated parser/integration capability, not an enabled production complaint feed.

The endpoint requires `EVENT_INGEST_TOKEN`, accepts complaint events only, deduplicates
replays, and applies the existing HMAC-fingerprint suppression rules. It stores no raw
recipient address in the suppression table.

## Endpoints

- `GET /health`: process health.
- `GET /v1/queue`: authenticated queue counters (queued, processing, sent, dead).
- `GET /v1/suppressions`: authenticated aggregate suppression/event counters.
- `GET /v1/admin/queue`: private admin-token view of queue metadata and aggregate counters.
- `GET /v1/admin/dead-letters`: private admin-token dead-letter metadata.
- `GET /v1/admin/suppressions`: private admin-token suppression references (truncated HMAC fingerprints), reasons, and aggregate counts.
- `POST /v1/deliveries`: authenticated, idempotent queue submission.
- `POST /v1/events`: authenticated event intake for trusted internal adapters.
- `POST /v1/mta-events`: authenticated DSN intake with delivery-ID/recipient matching.
- `POST /v1/arf-events`: private authenticated complaint intake; requires a trusted upstream feedback-loop route.

The read-only operations API exposes delivery IDs, states, attempts, timestamps, and safe error codes only. It never returns OTP payloads, recipient addresses, SMTP credentials, or full recipient fingerprints. Pagination is capped at 100 records per request. Suppression release and dead-letter replay are deliberately not exposed yet; they require audited, explicitly confirmed workflows.

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

## Local SMTP and bounce integration test

Run `npm test` from this directory. The `local-mta.integration.test.ts` test starts
a temporary SMTP server bound only to loopback and exercises the actual LUXORA MAIL
delivery worker. The test MTA advertises the DSN extension, captures the SMTP envelope
ID and failure-notification request, and accepts a test message without connecting to
the internet.

The test then creates an RFC 3464 permanent-failure report and sends the parsed event
through the real authenticated `/v1/mta-events` HTTP route. It verifies delivery-ID
and recipient matching, duplicate-event handling, hard-bounce suppression, and refusal
of future sends to the suppressed recipient. All addresses use the reserved
`example.test` domain and the OTP is a disposable test value.

This is a protocol-level local simulation, not a real Postfix installation or a test
of external mailbox delivery. It does not require a domain, DNS, SMTP credentials,
public ports, or paid services. A separate Postfix deployment and real controlled
mailbox test will still be required before production.
