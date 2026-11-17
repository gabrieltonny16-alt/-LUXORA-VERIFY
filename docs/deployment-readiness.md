# Deployment readiness

## Implemented in the repository

- Provider-independent OTP generation and HMAC verification.
- AES-GCM destination encryption and keyed destination fingerprints.
- HTTP request, verification, and health handlers.
- D1 repository adapter with conditional updates for failed attempts and one-time consumption.
- A Worker entry point with delivery disabled by default.
- Unit and HTTP handler tests.

## Not yet ready to deploy

- No D1 database has been created or migrated.
- No Cloudflare Worker has been deployed.
- No runtime secrets have been configured.
- No project provisioning or API-key issuance workflow exists yet.
- No rate limiter beyond the per-destination resend cooldown exists yet.
- No email or SMS provider is connected.
- No successful CI run has been confirmed.

## Mandatory next gates

1. Complete and run automated tests and type-checking.
2. Add project provisioning and one-time API-key issuance with hashed-at-rest storage.
3. Add global, per-project, and per-destination rate limits.
4. Add a provider adapter and test it without real-world delivery.
5. Review D1 migration and atomicity behavior.
6. Ask for explicit approval before creating remote resources, configuring secrets, enabling providers, or deploying.
