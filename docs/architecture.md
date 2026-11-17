# Architecture

## Product boundary

LUXORA VERIFY is a standalone service. Client applications do not generate, store, deliver, or validate their own OTPs. They call this service using a project-specific credential and receive a narrow result.

## Request lifecycle

1. An application calls the request endpoint with a project credential, channel, destination, and purpose.
2. The API authenticates the project, validates channel and destination, applies project and destination rate limits, and checks resend cooldowns.
3. The core generates a cryptographically secure numeric code and stores only an HMAC-SHA-256 digest, expiry, attempt budget, and lifecycle metadata.
4. A delivery adapter sends the code. The provider is selected by channel and project policy. The API never returns the code.
5. The application submits the code to the verification endpoint.
6. The service checks expiry, one-time use, attempt limits, and the HMAC digest. Successful verification consumes the challenge atomically.
7. A minimal audit event is written without OTPs, API keys, or unnecessary personal data.

## Separation of concerns

- `core/`: OTP generation, digesting, policy decisions, and domain types.
- `adapters/`: persistence and email/SMS delivery implementations.
- `http/`: routing, request validation, authentication, and response mapping.
- `migrations/`: versioned D1 schema.
- `tests/`: deterministic tests for security-sensitive behavior.

The core must not import a vendor SDK, Cloudflare binding, HTTP framework, or application-specific code.

## First implementation target

Cloudflare Workers + D1 is the proposed low-cost hosting target. The API and domain core remain portable TypeScript so the service can be moved if infrastructure needs change. D1 access will sit behind a repository interface. No remote database is created or modified in this repository-only stage.

## Provider lifecycle

Development begins with fake/test delivery adapters. A provider adapter must support timeouts, normalized errors, idempotency where available, and safe metadata-only logs. A production adapter cannot be activated until credentials, sender identity, costs, geographic coverage, and approval are confirmed.

## Multi-project model

Each consuming application is a separate project with:
- an immutable project ID;
- one or more revocable API credentials (stored as hashes);
- allowed channels and purposes;
- per-project rate limits and resend policy;
- environment separation (development/staging/production);
- usage and delivery metrics.

Credentials must be scoped to the API and environment. One application's credential must not authorize another application's settings or logs.
