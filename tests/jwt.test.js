const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DISABLE_ENV_LOAD = "true";
process.env.NODE_ENV = "test";
process.env.SESSION_JWT_SECRET = "unit-test-secret-with-enough-entropy-123456";

const { signSessionToken, verifySessionToken } = require("../src/services/jwt");

test("signSessionToken / verifySessionToken roundtrip", () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const token = signSessionToken({
    sessionId: "session-1",
    tokenId: "token-1",
    expiresAt,
    formId: "form-1",
    schemaHash: "hash-1"
  });

  const payload = verifySessionToken(token);
  assert.equal(payload.sid, "session-1");
  assert.equal(payload.sub, "session-1");
  assert.equal(payload.jti, "token-1");
  assert.equal(payload.formId, "form-1");
  assert.equal(payload.schemaHash, "hash-1");
});

test("verifySessionToken rejects tampered tokens", () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const token = signSessionToken({
    sessionId: "session-1",
    tokenId: "token-1",
    expiresAt
  });
  const tampered = token.slice(0, -2) + "xx";
  assert.throws(() => verifySessionToken(tampered));
});

test("signSessionToken requires sessionId and tokenId", () => {
  assert.throws(() =>
    signSessionToken({ sessionId: "", tokenId: "", expiresAt: new Date() })
  );
});
