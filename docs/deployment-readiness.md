# Deployment readiness

## Implemented
- Provider-independent OTP generation and HMAC verification.
- AES-GCM destination encryption and keyed destination fingerprints.
- HTTP request, verification, and health handlers.
- D1 repository adapter with conditional updates for failed attempts and one-time consumption.
- First-party delivery router with separate authenticated mail and SMS service bindings.
- LUXORA MAIL Node.js service with authenticated delivery endpoint, OTP email templates, SMTP transport, TLS settings, and safe error responses.
- LUXORA MAIL container build and dedicated CI type-check/build job.
- First-party email and SMS infrastructure architecture documented.

## Not yet operational
- LUXORA MAIL does not yet have a durable queue, idempotency store, bounce processing, suppression management, or a self-operated Postfix/MTA host.
- The SMTP host, sender domain, SPF, DKIM, DMARC, PTR/reverse DNS, TLS certificates, and deliverability reputation are not provisioned or verified.
- LUXORA MAIL is not yet connected to the Cloudflare service binding through a private gateway.
- LUXORA SMS gateway and transport adapters are not implemented.
- Authorized telecom interconnection for real SMS does not exist.
- Worker service bindings, runtime secrets, remote D1 database, migrations, and deployment are not provisioned.
- Project provisioning, API-key issuance/revocation, and global/project rate limits remain required.
- No successful CI run has been confirmed.

## Next engineering gates
1. Verify the LUXORA MAIL type-check and container build in CI.
2. Add durable mail queue, idempotency, retries, bounce processing, and suppression.
3. Build the private gateway connecting the Worker service binding to the self-operated mail host.
4. Build LUXORA SMS gateway and its transport interfaces.
5. Add project provisioning, scoped API keys, revocation, and rate limits.
6. Review D1 atomicity and delivery idempotency.
7. Test locally without sending real messages.
8. Obtain explicit approval before provisioning remote resources, changing DNS, configuring production secrets, enabling external routes, or deploying.
