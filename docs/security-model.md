# Security model

## Non-negotiable controls

- Generate codes with a cryptographically secure random source. Never use `Math.random()`.
- Store only a keyed HMAC digest of each OTP. The HMAC pepper is a server secret and must never be committed.
- OTPs are single-use and expire quickly. Initial default: 5 minutes.
- Initial code length: 6 decimal digits.
- Initial verification budget: 5 attempts per challenge.
- Initial resend cooldown: 60 seconds.
- Apply rate limits across project, destination, IP/risk signal, and time window before delivery.
- Return generic public errors where detailed responses would reveal whether an account or destination exists.
- Never log OTP values, full destinations, API credentials, HMAC digests, or provider secrets.
- Do not expose an OTP through API responses, browser state, analytics, or error messages.
- Use HTTPS only for deployed environments.
- Rotate and revoke project credentials; store only a one-way hash of each credential.
- Keep development, staging, and production credentials and data separate.

## Verification ordering

A verification attempt must:
1. authenticate the calling project;
2. load the challenge by an opaque identifier scoped to that project;
3. reject consumed or expired challenges;
4. reject challenges whose attempt budget is exhausted;
5. validate code shape;
6. compare fixed-length digest bytes without ordinary string equality;
7. atomically increment failed attempts or mark the challenge consumed.

The persistence adapter must prevent two concurrent successful requests from consuming the same challenge. A read-then-write sequence without a conditional update is not sufficient.

## Data minimization

Store destination data only as long as operationally required. Prefer encrypted destination values or a keyed destination fingerprint for rate limiting and deduplication. Define and enforce retention periods for challenge records and audit events before production.

## Operational gates

No real email or SMS provider, production sending, paid service, remote database, or deployment is enabled by this foundation commit. Each requires an explicit approval step. The repository must contain no live credentials.
