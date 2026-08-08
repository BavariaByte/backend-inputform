const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ENV_MODULE = path.resolve(__dirname, "../src/config/env.js");

const freshEnv = (overrides = {}) => {
  const saved = { ...process.env };
  process.env.DISABLE_ENV_LOAD = "true";
  process.env.NODE_ENV = "test";
  delete process.env.INPUTFORM_AUTH_ENABLED;
  Object.assign(process.env, overrides);
  delete require.cache[ENV_MODULE];
  const env = require(ENV_MODULE);
  process.env = saved;
  return env;
};

test("auth is enabled by default (secure by default)", () => {
  const env = freshEnv();
  assert.equal(env.inputFormAuthEnabled, true);
});

test("auth can be explicitly disabled for demos", () => {
  const env = freshEnv({ INPUTFORM_AUTH_ENABLED: "false" });
  assert.equal(env.inputFormAuthEnabled, false);
});

test("auth stays enabled for any value other than 'false'", () => {
  const env = freshEnv({ INPUTFORM_AUTH_ENABLED: "no" });
  assert.equal(env.inputFormAuthEnabled, true);
});

test("session TTL defaults are applied", () => {
  const env = freshEnv();
  assert.equal(env.sessionTtlDefaultMinutes, 120);
  assert.equal(env.sessionTtlMaxMinutes, 480);
  assert.equal(env.maxEventsHardCap, 10000);
});
