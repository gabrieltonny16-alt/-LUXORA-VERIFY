# LUXORA VERIFY

**A standalone verification service for every LUXORA and CREOVA product.**

LUXORA VERIFY is being built as a reusable authentication-verification API. Applications integrate once and can request email or SMS one-time passcodes through provider adapters. The service owns verification policy, token lifecycle, abuse controls, delivery orchestration, and audit records.

## Build principles

- Provider-independent core: the verification engine must not depend on a specific SMS or email vendor.
- One API for multiple projects: CREOVA, BingwaPulse, LuxoraFlow, and future applications can integrate through separate project credentials.
- Secure by default: short-lived, single-use codes; hashed code storage; strict attempt and resend limits; generic responses that avoid account enumeration; no OTPs or secrets in logs.
- Free-first development: local tests and sandbox adapters first. No paid provider, production delivery, deployment, or live messaging without explicit approval.
- Auditable: record request, delivery, verification, expiry, throttling, and failure events without storing plaintext OTPs.
- Replaceable infrastructure: keep transport adapters and persistence interfaces separate from verification policy.

## Initial architecture

- **API:** TypeScript on Cloudflare Workers.
- **Persistence:** Cloudflare D1 (SQLite) behind a repository boundary; local development first.
- **Verification core:** cryptographically secure OTP generation, keyed hashing, expiry, one-time consumption, attempt limits, resend cooldowns, and project-level policy.
- **Delivery adapters:** email and SMS interfaces with development/test adapters first. Real vendors are added only after the core is tested and approved.
- **Project access:** per-project API credentials stored as hashes; credentials are never committed to this repository.

## Planned API

- `POST /v1/otp/requests` — request an email or SMS code.
- `POST /v1/otp/verifications` — verify a code.
- `GET /health` — service health only; no secrets or infrastructure details.

The exact request/response contract and error semantics will be documented before external app integration.

## Repository status

This repository is the independent service project. It is not part of the CREOVA application repository and will not reuse the older `luxora-otp` function.

Current stage: **foundation and secure core implementation**. No provider account is required to build or test the core. No live OTP delivery is enabled.

## Development

The first milestone is a locally testable verification core and API contract. Cloudflare resources, credentials, deployment, and real email/SMS providers are separate setup steps and require explicit approval.

## Security

Report suspected vulnerabilities privately to the repository owner. Never open an issue containing real OTPs, API keys, access tokens, personal contact details, or production logs.
