# HTTP runtime and adapter contract

The HTTP layer is a portable Web-standard Request/Response handler. The Worker entry
point injects D1 persistence and private first-party service bindings.

## Required runtime configuration

- D1 database binding: `DB`.
- Private first-party mail gateway binding: `MAIL_SERVICE`.
- Private first-party SMS service binding: `SMS_SERVICE` (not implemented yet).
- `MAIL_SERVICE_TOKEN` and `SMS_SERVICE_TOKEN`: independent high-entropy service credentials.
- `API_KEY_PEPPER`, `OTP_PEPPER`, and `DESTINATION_FINGERPRINT_PEPPER`: each at least 32 bytes.
- `DESTINATION_ENCRYPTION_KEY`: at least 32 bytes.

All secrets belong in runtime secret storage, never source control, migrations, logs,
or client applications.

## First-party delivery contract

The Worker routes email and SMS jobs to private LUXORA delivery services. Both receive
POST `/v1/deliveries` with JSON containing `destination`, `code`, and `purpose`,
plus an `Idempotency-Key` derived from the unique OTP challenge ID.

- HTTP 202 means the downstream service durably accepted the job into its queue.
- HTTP 4xx means the downstream service rejected the job.
- HTTP 5xx or a transport exception is treated as unknown because acceptance may have
  happened before the connection failed.

LUXORA MAIL persists encrypted payloads in SQLite, deduplicates challenge IDs, recovers
expired processing leases, and retries SMTP submission with bounded exponential backoff.
Its 202 response means queue acceptance, not final inbox delivery.

## Private mail gateway topology

`src/index.ts` -> Cloudflare service binding `MAIL_SERVICE` -> private
`luxora-mail-gateway` Worker -> Cloudflare Access Service Auth -> Cloudflare Tunnel
-> Node.js LUXORA MAIL on loopback port 8788 -> SMTP host.

The gateway has `workers_dev = false` and no public route. It validates a dedicated
inbound bearer token, validates the OTP payload and idempotency key, forwards to one
fixed HTTPS origin, uses a separate origin bearer token, requires Cloudflare Access
service-token credentials, refuses redirects, and only returns 202 after the mail
service confirms durable queue acceptance.

The Node mail application must remain bound to `127.0.0.1`; do not expose port 8788
directly. The origin hostname must be protected by a Cloudflare Access Service Auth
policy. See `services/mail-gateway/README.md`.

The repository root `wrangler.toml` declares the `MAIL_SERVICE` binding. Its D1
database ID is intentionally a placeholder until a database is created. The gateway
and service binding are code/configuration only; no tunnel, Access policy, DNS record,
secret, or Worker has been provisioned. SMS binding and gateway are separate work.

Do not log OTP values, full destinations, API keys, or transport secrets.

## Repository atomicity requirements

A production repository must implement these operations with database-enforced
conditions/transactions:

- `createChallengeIfAllowed`: atomically enforce resend cooldown for the same
  project, destination fingerprint, and purpose before inserting.
- `incrementFailedAttempt`: update only when the stored attempt count equals the
  expected count, the challenge is unconsumed, and it has not expired.
- `consumeChallenge`: update only when the stored attempt count equals the expected
  count, the challenge is unconsumed, and it has not expired.

A plain read-then-write implementation is not sufficient.

## Current boundary

Gateway source and service-binding configuration are committed but not deployed or
connected to a live tunnel. LUXORA MAIL's SMTP host, Access policy, sender domain,
production secrets, and remote database are not provisioned. LUXORA SMS, project
provisioning, API-key management, rate limits, and deployment are not operational.
No live messages or paid services have been activated.
