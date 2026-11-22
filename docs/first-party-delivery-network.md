# First-party delivery network

## Product decision

LUXORA VERIFY owns the verification core, delivery orchestration, templates, message
policies, project controls, audit trail, and routing. Email and SMS transport are
separate first-party services operated as part of the LUXORA platform.

External aggregators are optional fallback routes only. They are not the system of
record and do not own verification logic.

## Service topology

- **LUXORA VERIFY API**: authenticates consuming projects, creates challenges, applies
  policy, and validates one-time codes.
- **LUXORA MAIL**: owns email composition, queueing, SMTP transport, bounce processing,
  suppression, and delivery telemetry.
- **LUXORA SMS**: owns SMS composition, queueing, routing, SMPP/HTTP transport adapters,
  delivery receipts, and telecom connection management.
- **Private service bindings**: the API sends delivery jobs to the first-party services
  without exposing their internal endpoints publicly.

The API currently routes through `InternalDeliveryRouter`. The runtime requires both
first-party service bindings; it does not silently substitute a fake success or a
third-party provider.

## LUXORA MAIL: self-operated email

A self-operated mail system needs more than message-generation code. It requires:
- a sending host with stable public IP and reverse DNS/PTR;
- domain DNS records for SPF, DKIM, and DMARC;
- TLS, queue persistence, retry/backoff, bounce handling, and suppression lists;
- abuse prevention, domain reputation monitoring, and operational alerting;
- feedback-loop handling and clear sender identity.

The mail service will expose a private delivery API and own its queue and transport.
A small VPS or dedicated mail host is a more suitable SMTP runtime than a Cloudflare
Worker because Workers do not provide general raw TCP SMTP sockets. The service can
be developed and tested locally before any host or domain changes are made.

## LUXORA SMS: self-operated gateway

The SMS service will own:
- message normalization and segmentation;
- durable outbound queues and retry policy;
- routing decisions and delivery-receipt correlation;
- SMPP and operator-specific transport adapters;
- per-project quotas, destination controls, and audit records.

A gateway implementation alone cannot deliver SMS to every mobile number. Reaching
ordinary subscribers requires an authorized connection to a mobile network, usually
through an operator interconnect or an SMS aggregator. Direct interconnects require
commercial and technical agreements and may require regulatory approval. A modem/GSM
gateway is not a universal substitute and must be assessed against carrier terms and
local law.

## Delivery state semantics

- `sent`: downstream first-party service explicitly accepted the job.
- `failed`: downstream service explicitly rejected the job before acceptance.
- `unknown`: timeout or connection failure where acceptance cannot be ruled out.

Unknown deliveries must not be blindly retried. The delivery services need idempotency
keys and durable job state before automatic retry is enabled.

## Current implementation boundary

Implemented now:
- a first-party internal routing adapter for email and SMS;
- a private service-binding contract;
- explicit separation between verification and transport.

Still required before delivery can operate:
- LUXORA MAIL service implementation and persistent queue;
- LUXORA SMS gateway implementation and persistent queue;
- private service bindings and secure service-to-service authentication;
- SMTP host, DNS, reverse DNS, and deliverability validation for self-operated email;
- authorized operator/SMPP connectivity for real SMS delivery;
- end-to-end tests and operational monitoring.

No mail server, SMS gateway, telecom connection, paid resource, domain record, or live
message has been activated by this repository change.
