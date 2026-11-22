# HTTP runtime and adapter contract

The HTTP layer is a portable Web-standard Request/Response handler. The Worker entry
point injects D1 persistence and two first-party private service bindings.

## Required runtime configuration

- D1 database binding: `DB`.
- Private first-party mail service binding: `MAIL_SERVICE`.
- Private first-party SMS service binding: `SMS_SERVICE`.
- `MAIL_SERVICE_TOKEN` and `SMS_SERVICE_TOKEN`: independent 32-byte-or-longer service credentials.
- `API_KEY_PEPPER`: at least 32 bytes.
- `OTP_PEPPER`: at least 32 bytes.
- `DESTINATION_FINGERPRINT_PEPPER`: at least 32 bytes.
- `DESTINATION_ENCRYPTION_KEY`: at least 32 bytes.

All secrets belong in runtime secret storage, never source control, migrations, logs,
or client applications.

## First-party delivery contract

The Worker routes email jobs to the private mail service and SMS jobs to the private
SMS service. Both services receive a POST to `/v1/deliveries` with JSON containing
`destination`, `code`, and `purpose`.

- HTTP 200 or 202 means the downstream service accepted the delivery job.
- HTTP 4xx means the downstream service rejected the job.
- HTTP 5xx or a transport exception is treated as unknown because acceptance may
  have happened before the connection failed.

The services must add durable job storage and idempotency before automatic retries
are enabled. Do not log OTP values, full destinations, API keys, or transport secrets.
The service bindings are private Cloudflare service-to-service connections, not public
client endpoints.

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

The API and first-party routing adapter are committed. The mail and SMS services,
their queues and transports, service bindings, project provisioning, API-key
management, rate limits, remote database, and deployment are not yet operational.
No live messages or paid services have been activated.
