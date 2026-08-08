const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DISABLE_ENV_LOAD = "true";
process.env.NODE_ENV = "test";
process.env.SESSION_JWT_SECRET = "unit-test-secret-with-enough-entropy-123456";

const { sanitizeCustomMeta } = require("../src/controllers/sessionController");

test("returns empty object for non-object input", () => {
  assert.deepEqual(sanitizeCustomMeta(null), {});
  assert.deepEqual(sanitizeCustomMeta("string"), {});
  assert.deepEqual(sanitizeCustomMeta([1, 2]), {});
});

test("keeps flat primitive values", () => {
  const result = sanitizeCustomMeta({ locale: "de", retries: 2, flagged: true });
  assert.deepEqual(result, { locale: "de", retries: 2, flagged: true });
});

test("drops reserved server-managed keys", () => {
  const result = sanitizeCustomMeta({
    identityName: "attacker",
    clientMeta: "spoofed",
    ticketId: "someid",
    completedAt: "1970-01-01",
    safe: "value"
  });
  assert.deepEqual(result, { safe: "value" });
});

test("drops nested objects and arrays", () => {
  const result = sanitizeCustomMeta({ nested: { a: 1 }, list: [1], ok: "x" });
  assert.deepEqual(result, { ok: "x" });
});

test("drops keys with invalid characters or excessive length", () => {
  const longKey = "k".repeat(65);
  const result = sanitizeCustomMeta({
    "bad key!": "x",
    "$where": "1==1",
    [longKey]: "x",
    good_key: "x"
  });
  assert.deepEqual(result, { good_key: "x" });
});

test("caps the number of keys and string value length", () => {
  const input = {};
  for (let i = 0; i < 30; i += 1) input[`key${i}`] = "v";
  input.long = "x".repeat(5000);
  const result = sanitizeCustomMeta(input);
  assert.ok(Object.keys(result).length <= 20);
  const long = sanitizeCustomMeta({ long: "x".repeat(5000) });
  assert.equal(long.long.length, 2000);
});
