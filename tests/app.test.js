const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DISABLE_ENV_LOAD = "true";
process.env.NODE_ENV = "test";
process.env.SESSION_JWT_SECRET = "unit-test-secret-with-enough-entropy-123456";
process.env.MONGODB_URI = "mongodb://localhost:27017/girp-test";

const app = require("../src/app");

const withServer = async (fn) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test("GET /healthz responds with status ok", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
  });
});

test("responses carry restrictive security headers", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(
      res.headers.get("content-security-policy"),
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});

test("unknown routes return a structured 404 error", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.status, 404);
  });
});

test("playbook route rejects unauthenticated requests (auth enabled by default)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/playbooks/some-playbook`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.message, "Unauthorized");
  });
});

test("session creation rejects unauthenticated requests (auth enabled by default)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formId: "unit-test" })
    });
    assert.equal(res.status, 401);
  });
});
