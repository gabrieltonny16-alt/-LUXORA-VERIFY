# HTTP runtime and adapter contract

The first HTTP layer is a portable Web-standard `Request`/`Response` handler in `src/http/handler.ts`. It is deliberately independent of Cloudflare bindings and can be hosted by a Worker adapter later.

## Required configuration

- `apiKeyPepper`: at least 32 bytes; used to HMAC project API keys before lookup.
- `otpPepper`: at least 32 bytes; used by the OTP HMAC implementation.
- `destinationFingerprintPepper`: at least 32 bytes; used to create non-reversible destination lookup fingerprints.
- `destinationEncryptionKey`: at least 32 bytes; used for AES-GCM encryption of delivery destinations.
- A repository implementation with atomic operations.
- A delivery implementation. The repository-only stage uses test delivery in tests; no live provider is configured.

All secrets belong in runtime secret storage, never source control, migrations, logs, or client applications.

## Repository atomicity requirements

A production repository must implement these operations with database-enforced conditions/transactions:

- `createChallengeIfAllowed`: atomically enforce the resend cooldown for the same project, destination fingerprint, and purpose before inserting.
- `incrementFailedAttempt`: update only when the stored attempt count equals `expectedAttempts`, the challenge is unconsumed, and it has not expired.
- `consumeChallenge`: update only when the stored attempt count equals `expectedAttempts`, the challenge is unconsumed, and it has not expired.

A plain read-then-write implementation is not sufficient for these methods. The D1 adapter must use conditional SQL updates and/or transactions to prevent concurrent verification races.

## Delivery behavior

The API sends a code only through the injected delivery adapter. A failed or uncertain delivery is never reported as successful. Delivery errors are normalized; provider credentials and OTP values must not appear in logs or API responses.

## Current implementation boundary

The HTTP handler and its tests are implemented, but this is not yet a deployable service. A durable database adapter, project provisioning/key issuance, global and per-project rate limiting, delivery providers, runtime entry point, and deployment configuration remain future steps. No remote database, provider, secret, or deployment is configured by these files.
