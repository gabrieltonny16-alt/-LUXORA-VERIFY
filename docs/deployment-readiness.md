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
- Durable delivery-event intake for hard bounces, soft bounces, and complaints; event-ID
  deduplication; HMAC-fingerprinted suppression records; queue cancellation for suppressed
  recipients; rejection of future sends to suppressed recipients; and aggregate-only counters.
- Tests for queue persistence, idempotency, payload mismatch, encryption-key validation,
  bounce/complaint suppression, soft-bounce handling, event authentication, and suppression
  response behaviour.
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
- Bounce/complaint event intake and suppression logic exist, but no real MTA DSN parser,
  trusted webhook adapter, operator dashboard, or manual dead-letter replay is connected.
- LUXORA SMS gateway and transport adapters are not implemented.
- Authorized telecom interconnection for real SMS does not exist.
- Production Worker secrets, DNS, private networking, remote D1, and deployments are not provisioned.
- Project provisioning, API-key issuance/revocation, and global/project rate limits remain required.
- GitHub Actions verified the core type-check/tests and LUXORA MAIL type-check/queue tests/build
  successfully on the gateway implementation commit. The latest CI run for the bounce/complaint
  work must pass before this addition is treated as verified. Repository checks do not verify
  a deployed tunnel, SMTP host, or real delivery.

## Next engineering gates
1. Verify LUXORA MAIL type-check, delivery-event tests, queue tests, and build in CI.
2. Implement a trusted LUXORA MTA bounce/complaint adapter and operational suppression review.
3. Add operator visibility and safe dead-letter review/replay controls.
4. Provision the mail host, Cloudflare Tunnel, and Access Service Auth only after explicit approval.
5. Configure Worker secrets and D1, then run a reviewed end-to-end test without sending real messages.
6. Build LUXORA SMS gateway and transport interfaces.
7. Add project provisioning, scoped API keys, revocation, and rate limits.
8. Review D1 atomicity and end-to-end delivery idempotency.
9. Obtain explicit approval before paid resources, DNS changes, external routes, production secrets, or deployment.
