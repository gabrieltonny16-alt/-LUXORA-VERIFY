# LUXORA MAIL Gateway

Private Cloudflare Worker gateway between the LUXORA VERIFY Worker and the
LUXORA-operated Node.js mail application.

## Security design

1. LUXORA VERIFY calls this Worker through a Cloudflare service binding. The gateway
   Worker has `workers_dev = false` and no public route.
2. The gateway verifies a dedicated `VERIFY_TO_GATEWAY_TOKEN`.
3. It forwards only a validated OTP delivery payload to a fixed HTTPS origin URL.
4. It authenticates to that origin using a separate `MAIL_ORIGIN_TOKEN`.
5. The origin hostname must be protected by Cloudflare Access using a Service Auth
   policy. The gateway supplies its Access service-token ID and secret.
6. The Node.js mail application remains bound to loopback behind Cloudflare Tunnel.
   Do not bind the Node mail port to a public interface.

The gateway does not accept arbitrary destination URLs, does not forward arbitrary
headers, does not follow redirects, caps request bodies at 8 KiB, and returns success
only when the origin returns HTTP 202 with a valid durable-queue receipt.

## Required configuration

Set these as Worker secrets for the gateway (never commit them):

- `VERIFY_TO_GATEWAY_TOKEN`: at least 32 random bytes. Must match the
  `MAIL_SERVICE_TOKEN` secret configured on LUXORA VERIFY.
- `MAIL_ORIGIN_URL`: fixed HTTPS URL ending exactly in `/v1/deliveries`, routed
  through Cloudflare Tunnel and protected by Cloudflare Access.
- `MAIL_ORIGIN_TOKEN`: at least 32 random bytes. Must match the Node mail service's
  `INTERNAL_SERVICE_TOKEN`.
- `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: Cloudflare Access Service
  Token credentials for the origin hostname. Both are mandatory.

The LUXORA VERIFY Worker also needs its existing D1 binding and secrets. Its
`MAIL_SERVICE` binding is declared in the repository root `wrangler.toml`.
The D1 database ID in that file is deliberately a placeholder until the database is
created and approved. SMS service binding and SMS delivery are separate work.

## Provisioning sequence (not performed)

1. Provision the LUXORA mail host and run the Node service on loopback port 8788.
2. Create a Cloudflare Tunnel route to `http://127.0.0.1:8788`; do not open port 8788
   on the public firewall.
3. Protect the tunnel hostname with a Cloudflare Access Service Auth policy.
4. Deploy this Worker with `npx wrangler deploy --config services/mail-gateway/wrangler.toml`.
5. Add the five secrets above with `wrangler secret put` using the same config.
6. Configure the root LUXORA VERIFY Worker secrets, create the D1 database, apply
   migrations, and deploy only after a reviewed end-to-end test.

No tunnel, Access policy, DNS record, host, Worker deployment, or secret was created
by this code change. The gateway source is not operational until those steps are
explicitly provisioned.
