# HTTP runtime and adapter contract

The HTTP layer is a portable Web-standard Request/Response handler. The Worker entry
point injects D1 persistence and private first-party service bindings.

## Required runtime configuration

- D1 database binding: `DB`.
- Private first-party mail service binding: `MAIL_SERVICE`.
- Private first-party SMS service binding: `SMS_SERVICE`.
- `MAIL_SERVICE_TOKEN` and `SMS_SERVICE_TOKEN`: independent high-entropy service credentials.
- `API_KEY_PEPPER`, `OTP_PEPPER`, and `DESTINATION_FINGERPRINT_PEPPER`: each at least 32 bytes.
- `DESTINATION_ENCRYPTION_KEY`: at least 32 bytes.

All secrets belong in runtime secret storage, never source control, migrations, logs,
or client applications.

## First-party delivery contract

The Worker routes email and SMS jobs to private LUXORA delivery services. Both receive
POST `/v1/deliveries` with JSON containing `destination`, `code`, and `purpose`,
plus an `Idempotency-Key` derived from the unique OTP challenge ID.

- HTTP 200 or 202 means the downstream service durably accepted the job.
- HTTP 4xx means the downstream service rejected the job.
- HTTP 5xx or a transport exception is treated as unknown because acceptance may have
  happened before the connection failed.

LUXORA MAIL now persists encrypted payloads in SQLite, deduplicates challenge IDs,
recovers expired processing leases, and retries SMTP submission with bounded exponential
backoff. Its 202 response means queue acceptance, not final inbox delivery. The SMS
service must implement equivalent durable idempotency before automatic retries are safe.

Cloudflare service bindings connect Worker services to other Workers; they do not
directly attach a Cloudflare Worker to an arbitrary Node.js process. LUXORA MAIL is
currently a Node.js service. A private authenticated gateway or supported private
network bridge is still required between `MAIL_SERVICE` and that Node service.
Do not expose the Node mail endpoint publicly as a shortcut.

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

The API and routing adapter are committed. LUXORA MAIL's local queue and SMTP submission
application are committed, but its SMTP host, private gateway, service binding, and
production configuration are not provisioned. LUXORA SMS, project provisioning,
API-key management, rate limits, remote database, and deployment are not operational.
No live messages or paid services have been activated.
