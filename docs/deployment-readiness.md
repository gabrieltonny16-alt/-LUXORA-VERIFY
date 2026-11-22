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
- Container build definition and dedicated CI type-check, test, and build steps.

## Not yet operational
- The SMTP host is not provisioned or verified; no sender domain, SPF, DKIM, DMARC,
  PTR/reverse DNS, TLS certificates, or delivery reputation has been established.
- Bounce/complaint processing, suppression lists, operator visibility, and dead-letter replay
  are not implemented.
- LUXORA MAIL is a Node.js service. The Cloudflare Worker service binding cannot call that
  process directly; a private authenticated gateway or supported private network bridge is
  still required.
- LUXORA SMS gateway and transport adapters are not implemented.
- Authorized telecom interconnection for real SMS does not exist.
- Worker service bindings, runtime secrets, remote D1 database, migrations, and deployment
  are not provisioned.
- Project provisioning, API-key issuance/revocation, and global/project rate limits remain
  required.
- CI results for the latest queue implementation must be checked before treating it as verified.

## Next engineering gates
1. Verify LUXORA MAIL type-check, queue tests, and container build in CI.
2. Implement bounce/complaint processing, suppression, operator visibility, and safe dead-letter handling.
3. Build the private gateway connecting the Worker service binding to the self-operated mail service.
4. Build LUXORA SMS gateway and its transport interfaces.
5. Add project provisioning, scoped API keys, revocation, and rate limits.
6. Review D1 atomicity and end-to-end delivery idempotency.
7. Test locally without sending real messages.
8. Obtain explicit approval before provisioning remote resources, changing DNS, configuring
   production secrets, enabling external routes, or deploying.
