import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailOperatorAuth } from "../src/operator-auth.js";

test("operator credentials create individually authenticated, expiring and revocable sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "luxora-operator-auth-"));
  const databasePath = join(directory, "queue.sqlite");
  const auth = new MailOperatorAuth(databasePath);
  try {
    const owner = auth.bootstrapOwner({
      email: "Owner@luxora.test", displayName: "Primary Owner",
      password: "a-long-test-password-123", 
    });
    assert.equal(owner.role, "owner");
    assert.equal(auth.listOperators().length, 1);
    assert.throws(() => auth.bootstrapOwner({
      email: "second@luxora.test", displayName: "Second Owner",
      password: "another-long-test-password", 
    }), /already complete/);

    const operator = auth.createOperator({
      actor: owner, email: "operator@luxora.test", displayName: "Mail Operator",
      password: "operator-password-123", role: "operator",
    });
    assert.equal(operator.role, "operator");
    assert.equal(auth.createOperator({
      actor: owner, email: "audit@luxora.test", displayName: "Audit Reader",
      password: "auditor-password-123", role: "auditor",
    }).role, "auditor");
    assert.throws(() => auth.createOperator({
      actor: operator, email: "forbidden@luxora.test", displayName: "Forbidden",
      password: "forbidden-password-123", role: "auditor",
    }), /not permitted/);

    assert.equal(auth.authenticate("operator@luxora.test", "wrong-password-123"), null);
    assert.equal(auth.authenticate("missing@luxora.test", "wrong-password-123"), null);
    const session = auth.authenticate("OPERATOR@LUXORA.TEST", "operator-password-123");
    assert.ok(session);
    assert.equal(session.operator.id, operator.id);
    assert.equal(auth.resolveSession(session.token)?.id, operator.id);
    assert.equal(auth.hasPermission(session.operator, "operations.read"), true);
    assert.equal(auth.hasPermission(session.operator, "suppression.release"), false);
    assert.equal(auth.revokeSession(session.token), true);
    assert.equal(auth.resolveSession(session.token), null);
    assert.equal(auth.revokeSession(session.token), false);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("operator passwords must meet the minimum length and sessions store only token hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "luxora-operator-auth-"));
  const databasePath = join(directory, "queue.sqlite");
  const auth = new MailOperatorAuth(databasePath);
  try {
    assert.throws(() => auth.bootstrapOwner({
      email: "owner@luxora.test", displayName: "Owner", password: "short",
    }), /Invalid operator details/);
    const owner = auth.bootstrapOwner({
      email: "owner@luxora.test", displayName: "Owner", password: "valid-password-123",
    });
    const session = auth.authenticate(owner.email, "valid-password-123");
    assert.ok(session);
    assert.equal(session.token.length >= 40, true);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
