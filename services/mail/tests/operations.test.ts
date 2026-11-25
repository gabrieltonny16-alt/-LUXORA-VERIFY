import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailQueue } from "../src/queue.js";
import { createMailServer, type MailEnv } from "../src/server.js";

test("operations API enforces individual operator sessions, roles and authenticated audit identity", async () => {
  const key = randomBytes(32).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "luxora-mail-ops-"));
  const databasePath = join(directory, "queue.sqlite");
  const queue = new MailQueue(databasePath, key);
  const adminToken = "operations-api-admin-token-at-least-32-bytes";
  const env: MailEnv = {
    PORT: 0,
    INTERNAL_SERVICE_TOKEN: "operations-api-internal-token-at-least-32-bytes",
    EVENT_INGEST_TOKEN: "operations-api-event-token-at-least-32-bytes",
    ADMIN_TOKEN: adminToken,
    QUEUE_DB_PATH: databasePath, QUEUE_ENCRYPTION_KEY: key,
    SMTP_HOST: "127.0.0.1", SMTP_PORT: 2525, SMTP_SECURE: false,
    SMTP_USER: "", SMTP_PASSWORD: "", MAIL_FROM: "no-reply@luxora.test",
    MAIL_FROM_NAME: "LUXORA VERIFY", BOUNCE_ADDRESS: "bounces@luxora.test",
  };
  const server = createMailServer(env, queue);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Operations test server failed to bind"));
      resolve(address.port);
    });
  });
  const base = "http://127.0.0.1:" + port;
  const destination = "private-recipient@example.test";
  try {
    const bootstrap = await fetch(base + "/v1/auth/bootstrap", {
      method:"POST", headers:{authorization:"Bearer "+adminToken,"content-type":"application/json"},
      body:JSON.stringify({email:"owner@luxora.test",displayName:"LUXORA Owner",password:"owner-password-123"}),
    });
    assert.equal(bootstrap.status, 201);
    const secondBootstrap = await fetch(base + "/v1/auth/bootstrap", {
      method:"POST", headers:{authorization:"Bearer "+adminToken,"content-type":"application/json"},
      body:JSON.stringify({email:"second@luxora.test",displayName:"Second Owner",password:"second-password-123"}),
    });
    assert.equal(secondBootstrap.status, 409);

    const login = await fetch(base + "/v1/auth/login", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({email:"OWNER@LUXORA.TEST",password:"owner-password-123"}),
    });
    assert.equal(login.status, 200);
    const ownerSession = await login.json() as {token:string;operator:{id:string;role:string}};
    assert.equal(ownerSession.operator.role, "owner");

    const createOperator = await fetch(base + "/v1/admin/operators", {
      method:"POST", headers:{authorization:"Bearer "+ownerSession.token,"content-type":"application/json"},
      body:JSON.stringify({email:"operator@luxora.test",displayName:"Mail Operator",password:"operator-password-123",role:"operator"}),
    });
    assert.equal(createOperator.status, 201);
    const created = await createOperator.json() as {operator:{id:string;role:string}};
    assert.equal(created.operator.role, "operator");

    const operatorLogin = await fetch(base + "/v1/auth/login", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({email:"operator@luxora.test",password:"operator-password-123"}),
    });
    assert.equal(operatorLogin.status, 200);
    const operatorSession = await operatorLogin.json() as {token:string;operator:{id:string;role:string}};

    const queued = queue.enqueue("operations-queue-test-0001", {
      destination, code: "123456", purpose: "sign_up",
    });
    queue.recordDeliveryEvent({
      eventId: "abcdef0123456789abcdef0123456789",
      type: "complaint", recipient: destination,
    });

    const unauthorized = await fetch(base + "/v1/admin/queue");
    assert.equal(unauthorized.status, 401);
    const sharedTokenRejected = await fetch(base + "/v1/admin/queue", {
      headers:{authorization:"Bearer "+adminToken},
    });
    assert.equal(sharedTokenRejected.status, 401);

    const operatorHeaders = {authorization:"Bearer "+operatorSession.token};
    const queueResponse = await fetch(base + "/v1/admin/queue?limit=10&offset=0", {headers:operatorHeaders});
    assert.equal(queueResponse.status, 200);
    const queueBody = await queueResponse.json() as {queue:{dead:number};items:Array<{id:string;status:string}>};
    assert.equal(queueBody.queue.dead, 1);
    assert.equal(queueBody.items[0]?.id, queued.id);
    assert.equal(JSON.stringify(queueBody).includes(destination), false);

    const deniedRelease = await fetch(base + "/v1/admin/suppressions/release", {
      method:"POST",headers:{...operatorHeaders,"content-type":"application/json"},
      body:JSON.stringify({recipientRef:"0000000000000000",reason:"Reviewed incident and confirmed safe to release.",confirm:"RELEASE_SUPPRESSION"}),
    });
    assert.equal(deniedRelease.status, 403);
    const deniedAudit = await fetch(base + "/v1/admin/audit", {headers:operatorHeaders});
    assert.equal(deniedAudit.status, 403);

    const ownerHeaders = {authorization:"Bearer "+ownerSession.token};
    const deadResponse = await fetch(base + "/v1/admin/dead-letters", {headers:ownerHeaders});
    assert.equal(deadResponse.status, 200);
    const deadBody = await deadResponse.json() as {items:Array<{id:string;lastErrorCode:string|null}>};
    assert.equal(deadBody.items.length, 1);
    assert.equal(deadBody.items[0]?.id, queued.id);
    assert.equal(deadBody.items[0]?.lastErrorCode, "recipient_suppressed");

    const suppressionResponse = await fetch(base + "/v1/admin/suppressions", {headers:ownerHeaders});
    assert.equal(suppressionResponse.status, 200);
    const suppressionBody = await suppressionResponse.json() as {summary:{complaint:number};items:Array<{recipientRef:string;reason:string}>};
    assert.equal(suppressionBody.summary.complaint, 1);
    assert.equal(suppressionBody.items[0]?.reason, "complaint");
    assert.match(suppressionBody.items[0]?.recipientRef ?? "", /^[a-f0-9]{16}$/);
    assert.equal(JSON.stringify(suppressionBody).includes(destination), false);

    const missingConfirmation = await fetch(base + "/v1/admin/suppressions/release", {
      method:"POST",headers:{...ownerHeaders,"content-type":"application/json"},
      body:JSON.stringify({recipientRef:suppressionBody.items[0]!.recipientRef,reason:"Investigated source and confirmed recipient consent."}),
    });
    assert.equal(missingConfirmation.status, 400);
    const release = await fetch(base + "/v1/admin/suppressions/release", {
      method:"POST",headers:{...ownerHeaders,"content-type":"application/json"},
      body:JSON.stringify({recipientRef:suppressionBody.items[0]!.recipientRef,reason:"Investigated source and confirmed recipient consent.",confirm:"RELEASE_SUPPRESSION"}),
    });
    assert.equal(release.status, 200);
    assert.equal((await release.json() as {released:boolean}).released, true);
    assert.equal(queue.suppressionStats().total, 0);

    const replay = await fetch(base + "/v1/admin/dead-letters/" + queued.id + "/replay", {
      method:"POST",headers:{...ownerHeaders,"content-type":"application/json"},
      body:JSON.stringify({reason:"Original OTP was cleared and must not be reused.",confirm:"ACKNOWLEDGE_REPLAY_BLOCKED"}),
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json() as {replayed:boolean}).replayed, false);

    const auditResponse = await fetch(base + "/v1/admin/audit", {headers:ownerHeaders});
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json() as {items:Array<{operatorId:string;action:string;outcome:string}>};
    assert.equal(audit.items.length, 2);
    assert.ok(audit.items.every(entry => entry.operatorId === ownerSession.operator.id));
    assert.ok(audit.items.some(entry => entry.action === "suppression_release" && entry.outcome === "released"));
    assert.ok(audit.items.some(entry => entry.action === "dead_letter_replay" && entry.outcome.startsWith("blocked")));
    assert.equal(JSON.stringify(audit).includes(destination), false);

    const operatorsResponse = await fetch(base + "/v1/admin/operators", {headers:ownerHeaders});
    assert.equal(operatorsResponse.status, 200);
    const operators = await operatorsResponse.json() as {items:Array<{email:string;role:string}>};
    assert.ok(operators.items.some(entry => entry.email === "operator@luxora.test" && entry.role === "operator"));

    const invalid = await fetch(base + "/v1/admin/queue?limit=not-a-number", {headers:ownerHeaders});
    assert.equal(invalid.status, 400);
    const logout = await fetch(base + "/v1/auth/logout", {method:"POST",headers:ownerHeaders});
    assert.equal(logout.status, 200);
    const revoked = await fetch(base + "/v1/admin/queue", {headers:ownerHeaders});
    assert.equal(revoked.status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    queue.close();
    rmSync(directory, {recursive:true,force:true});
  }
});
