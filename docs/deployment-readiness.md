# Deployment readiness

## Implemented in the repository
- Provider-independent OTP generation and HMAC verification.
- AES-GCM destination encryption and keyed destination fingerprints.
- HTTP request, verification, and health handlers.
- D1 repository adapter with conditional updates for failed attempts and one-time consumption.
- First-party delivery router with separate authenticated mail and SMS service credentials.
- LUXORA MAIL Node.js application with authenticated queue submission and branded OTP templates.
- SQLite WAL-backed persistent queue with AES-256-GCM encrypted payloads, idempotency keys,
  processing leases, restart recovery, bounded exponential retries, and payload clearing after
  successful or permanently failed delivery.
- Queue tests covering persistence across restart, duplicate challenge IDs, payload mismatch,
  and encryption-key validation.
- Private LUXORA MAIL gateway Worker with separate gateway/origin credentials, strict
  HTTPS-origin allowlisting, request validation, redirect refusal, and mandatory Cloudflare
  Access Service Auth credentials.
- Cloudflare service-only gateway configuration and a root Worker service binding declaration.
- Gateway tests for authentication, forwarding, Access enforcement, URL restrictions, and
  upstream failure handling.
- Container build definition and CI type-check, test, and build steps.

## Not yet operational
- Gateway source/configuration has not been deployed; no tunnel or Access Service Auth policy exists.
- The root D1 database ID is a placeholder; database creation and migration have not occurred.
- The mail host is not provisioned or verified; no sender domain, SPF, DKIM, DMARC,
  PTR/reverse DNS, TLS certificates, or delivery reputation has been established.
- Bounce/complaint processing, suppression lists, operator visibility, and dead-letter replay
  are not implemented.
- LUXORA SMS gateway and transport adapters are not implemented.
- Authorized telecom interconnection for real SMS does not exist.
- Production Worker secrets, DNS, private networking, remote D1, and deployments are not provisioned.
- Project provisioning, API-key issuance/revocation, and global/project rate limits remain required.
- CI results for the latest queue and gateway changes must be checked before treating them as verified.

## Next engineering gates
1. Verify LUXORA MAIL queue and gateway tests, type-checks, and container build in CI.
2. Implement mail bounce/complaint processing, suppression, operator visibility, and safe dead-letter handling.
3. Provision the mail host, Cloudflare Tunnel, and Access Service Auth only after explicit approval.
4. Configure the Worker secrets and D1 database, then run a reviewed end-to-end test without sending real messages.
5. Build LUXORA SMS gateway and transport interfaces.
6. Add project provisioning, scoped API keys, revocation, and rate limits.
7. Review D1 atomicity and end-to-end delivery idempotency.
8. Obtain explicit approval before paid resources, DNS changes, external routes, production secrets, or deployment.
