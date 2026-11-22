# Deployment readiness

## Implemented
- Provider-independent OTP generation and HMAC verification.
- AES-GCM destination encryption and keyed destination fingerprints.
- HTTP request, verification, and health handlers.
- D1 repository adapter with conditional updates for failed attempts and one-time consumption.
- First-party delivery router for separate LUXORA-owned mail and SMS services.
- Worker runtime now requires both internal service bindings. There is no disabled-delivery or fake-success fallback.
- Architecture for self-operated email and SMS is documented in docs/first-party-delivery-network.md.

## Not yet operational
- LUXORA MAIL SMTP transport, durable queue, bounce handling, suppression, and sender-domain setup.
- LUXORA SMS gateway transport, durable queue, SMPP/operator adapters, and delivery receipts.
- Authorized telecom interconnection for real SMS.
- Worker service bindings for MAIL_SERVICE and SMS_SERVICE.
- Remote D1 database, migrations, Worker deployment, and runtime secrets.
- Project provisioning, API-key issuance/revocation, and global/project rate limits.
- Successful CI run has not been confirmed.

## Next engineering gates
1. Run and pass type-checking and automated tests.
2. Implement LUXORA MAIL with durable queue and SMTP transport.
3. Implement LUXORA SMS with durable queue and transport interfaces.
4. Add project provisioning, scoped API keys, revocation, and rate limits.
5. Review database atomicity and delivery idempotency.
6. Test locally without sending real messages.
7. Obtain explicit approval before remote provisioning, DNS changes, production secrets, external routes, or deployment.
