const test = require("node:test");
const { beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DISABLE_ENV_LOAD = "true";
process.env.NODE_ENV = "test";
process.env.SESSION_JWT_SECRET = "unit-test-secret-with-enough-entropy-123456";
process.env.SESSION_TTL_MINUTES = "120";
process.env.SESSION_TTL_MAX_MINUTES = "480";
process.env.SESSION_MAX_EVENTS_CAP = "10000";

// ── Model stub ────────────────────────────────────────────────────────────────
// The controller talks to Mongoose models from @girp/database-models. Each test
// file runs in its own process, so we can replace that module with plain
// recording stubs BEFORE the controller is required — no database, no mocking
// framework. Every stub only implements the exact call shapes the controller
// uses (create / findOne().lean().exec() / findOneAndUpdate().exec() / …).

const state = {
  formResultCreates: [],
  formResultUpdates: [],
  formResultDeletes: [],
  formResultFindOneCalls: 0,
  formResultFindOneResult: null,
  sessionCreates: [],
  sessionFindOneAndUpdateCalls: [],
  sessionFindOneAndUpdateResult: null,
  sessionDeletes: [],
  ticketCreates: [],
  ticketUpdates: [],
  failTicketCreate: false,
  formResultSeq: 0
};

const resetState = () => {
  state.formResultCreates = [];
  state.formResultUpdates = [];
  state.formResultDeletes = [];
  state.formResultFindOneCalls = 0;
  state.formResultFindOneResult = null;
  state.sessionCreates = [];
  state.sessionFindOneAndUpdateCalls = [];
  state.sessionFindOneAndUpdateResult = null;
  state.sessionDeletes = [];
  state.ticketCreates = [];
  state.ticketUpdates = [];
  state.failTicketCreate = false;
  state.formResultSeq = 0;
};

const modelStubs = {
  FormResult: {
    create: async (doc) => {
      state.formResultCreates.push(doc);
      state.formResultSeq += 1;
      return { _id: `fr-${state.formResultSeq}` };
    },
    findOne: () => {
      state.formResultFindOneCalls += 1;
      const chain = {
        lean: () => chain,
        exec: async () => state.formResultFindOneResult,
        then: (resolve) => resolve(state.formResultFindOneResult)
      };
      return chain;
    },
    findOneAndUpdate: () => ({ exec: async () => state.formResultFindOneResult }),
    updateOne: async (query, update) => {
      state.formResultUpdates.push({ query, update });
      return {};
    },
    findByIdAndUpdate: () => Promise.resolve(null),
    findByIdAndDelete: (id) => {
      state.formResultDeletes.push(id);
      return Promise.resolve(null);
    }
  },
  FormSession: {
    create: async (doc) => {
      state.sessionCreates.push(doc);
      return doc;
    },
    findOneAndUpdate: (filter, update, options) => {
      state.sessionFindOneAndUpdateCalls.push({ filter, update, options });
      return { exec: async () => state.sessionFindOneAndUpdateResult };
    },
    updateOne: async () => ({}),
    deleteOne: async (filter) => {
      state.sessionDeletes.push(filter);
      return { deletedCount: 1 };
    }
  },
  TicketModel: {
    create: async (doc) => {
      if (state.failTicketCreate) {
        throw new Error("ticket create failed (stub)");
      }
      state.ticketCreates.push(doc);
      return { _id: "ticket-1", project_id: doc.project_id };
    },
    findByIdAndUpdate: async (id, update) => {
      state.ticketUpdates.push({ id, update });
      return {};
    }
  },
  CounterModel: {
    findOneAndUpdate: async () => ({ value: 42 })
  }
};

const modelsId = require.resolve("@girp/database-models");
require.cache[modelsId] = {
  id: modelsId,
  filename: modelsId,
  loaded: true,
  exports: modelStubs
};

const {
  createSession,
  getCurrentSession,
  submitResponse,
  completeSession,
  resetSession,
  purgeResponses
} = require("../src/controllers/sessionController");

beforeEach(resetState);

// ── Test helpers ──────────────────────────────────────────────────────────────

const mockReq = ({ body = {}, session = null } = {}) => ({
  body,
  session,
  ip: "203.0.113.7",
  get: (name) =>
    ({ "user-agent": "node-test-agent", "accept-language": "en-US" })[
      String(name).toLowerCase()
    ]
});

const mockRes = () => ({
  statusCode: 200,
  body: undefined,
  cookies: {},
  clearedCookies: [],
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  send(payload) {
    this.body = payload;
    return this;
  },
  cookie(name, value, options) {
    this.cookies[name] = { value, options };
    return this;
  },
  clearCookie(name, options) {
    this.clearedCookies.push({ name, options });
    return this;
  }
});

const rejectsWithStatus = (promise, status, messagePattern) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  });

// ── createSession ─────────────────────────────────────────────────────────────

test("createSession rejects a missing or too-short formId with 400", async () => {
  await rejectsWithStatus(
    createSession(mockReq({ body: {} }), mockRes()),
    400,
    /formId must be a string/
  );
  await rejectsWithStatus(
    createSession(mockReq({ body: { formId: "x" } }), mockRes()),
    400,
    /at least 2 characters/
  );
  assert.equal(state.formResultCreates.length, 0);
});

test("createSession creates result, ticket and session and sets the cookie", async () => {
  const res = mockRes();
  const before = Date.now();
  await createSession(
    mockReq({ body: { formId: "phishing-intake", name: "Alice", ticketTitle: "Phishing" } }),
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ticketSubject, "Phishing | Alice");
  assert.equal(res.body.ticketId, "ticket-1");
  assert.equal(res.body.formResultId, "fr-1");
  assert.equal(res.body.resumeWindowMinutes, 120);
  assert.match(res.body.sessionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(res.body.csrfToken, res.body.sessionId);

  const expiresIn = new Date(res.body.expiresAt).getTime() - before;
  assert.ok(expiresIn > 119 * 60_000 && expiresIn <= 121 * 60_000);

  const cookie = res.cookies.inputform_session;
  assert.ok(cookie, "session cookie must be set");
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.sameSite, "lax");
  assert.equal(cookie.options.maxAge, 120 * 60 * 1000);

  assert.equal(state.sessionCreates.length, 1);
  assert.equal(state.sessionCreates[0].identityName, "Alice");
  assert.equal(state.ticketCreates[0].ticket_subject, "Phishing | Alice");
  assert.equal(state.ticketCreates[0].ticket_id, 42);
});

test("createSession clamps the requested TTL into [1, max]", async () => {
  const overMax = mockRes();
  await createSession(
    mockReq({ body: { formId: "form-1", sessionTtlMinutes: 99999 } }),
    overMax
  );
  assert.equal(overMax.body.resumeWindowMinutes, 480);
  assert.equal(overMax.cookies.inputform_session.options.maxAge, 480 * 60 * 1000);

  const underMin = mockRes();
  await createSession(
    mockReq({ body: { formId: "form-1", sessionTtlMinutes: 0 } }),
    underMin
  );
  assert.equal(underMin.body.resumeWindowMinutes, 1);

  const nonNumeric = mockRes();
  await createSession(
    mockReq({ body: { formId: "form-1", sessionTtlMinutes: "soon" } }),
    nonNumeric
  );
  assert.equal(nonNumeric.body.resumeWindowMinutes, 120);
});

test("createSession derives maxEvents from questionCount within the hard cap", async () => {
  await createSession(
    mockReq({ body: { formId: "form-1", questionCount: 5 } }),
    mockRes()
  );
  assert.equal(state.sessionCreates[0].maxEvents, 50);

  await createSession(
    mockReq({ body: { formId: "form-1", questionCount: 2000 } }),
    mockRes()
  );
  assert.equal(state.sessionCreates[1].maxEvents, 10000);

  await createSession(mockReq({ body: { formId: "form-1" } }), mockRes());
  assert.equal(state.sessionCreates[2].maxEvents, 200);
});

test("createSession rolls back the FormResult when ticket creation fails", async () => {
  state.failTicketCreate = true;
  await assert.rejects(
    createSession(mockReq({ body: { formId: "form-1" } }), mockRes()),
    /ticket create failed/
  );
  assert.deepEqual(state.formResultDeletes, ["fr-1"]);
  assert.equal(state.sessionCreates.length, 0);
});

// ── submitResponse ────────────────────────────────────────────────────────────

const activeSession = (overrides = {}) => ({
  sessionId: "s-1",
  status: "active",
  formId: "form-1",
  formVersion: 1,
  schemaHash: "h-1",
  identityName: "Alice",
  ticketSubject: "Phishing | Alice",
  variablesSnapshot: {},
  clientMeta: {},
  maxEvents: 3,
  ...overrides
});

test("submitResponse rejects a foreign sessionId with 400", async () => {
  await rejectsWithStatus(
    submitResponse(
      mockReq({ body: { sessionId: "other", questionId: "q1" }, session: activeSession() }),
      mockRes()
    ),
    400,
    /sessionId mismatch/
  );
});

test("submitResponse rejects a missing questionId with 400", async () => {
  await rejectsWithStatus(
    submitResponse(mockReq({ body: {}, session: activeSession() }), mockRes()),
    400,
    /questionId must be a string/
  );
});

test("submitResponse rejects a schemaHash conflict with 409", async () => {
  await rejectsWithStatus(
    submitResponse(
      mockReq({ body: { questionId: "q1", schemaHash: "h-2" }, session: activeSession() }),
      mockRes()
    ),
    409,
    /schemaHash does not match/
  );
});

test("submitResponse rejects an invalid timestamp with 400", async () => {
  await rejectsWithStatus(
    submitResponse(
      mockReq({
        body: { questionId: "q1", timestamp: "not-a-date" },
        session: activeSession()
      }),
      mockRes()
    ),
    400,
    /ISO-8601/
  );
});

test("submitResponse appends the event capped at maxEvents and answers 202", async () => {
  state.sessionFindOneAndUpdateResult = activeSession({
    formResultId: "fr-9",
    ticketId: null,
    getLastQuestionId: () => "q1"
  });
  state.formResultFindOneResult = { answers: [] };

  const res = mockRes();
  await submitResponse(
    mockReq({
      body: {
        questionId: "q1",
        value: 42,
        valueLabel: "  Forty-two  ",
        questionLabel: "  Q One ",
        timestamp: "2026-01-01T00:00:00.000Z"
      },
      session: activeSession()
    }),
    res
  );

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "accepted");
  assert.equal(res.body.lastQuestionId, "q1");

  const { update } = state.sessionFindOneAndUpdateCalls[0];
  assert.equal(update.$push.events.$slice, -3);
  const event = update.$push.events.$each[0];
  assert.equal(event.questionId, "q1");
  assert.equal(event.valueLabel, "Forty-two");
  assert.equal(event.questionLabel, "Q One");
  assert.equal(event.timestamp.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(event.clientMeta.userAgent, "node-test-agent");

  // The answer is merged into the FormResult atomically.
  assert.equal(state.formResultUpdates.length, 1);
});

test("submitResponse falls back to an event cap of 200 without maxEvents", async () => {
  state.sessionFindOneAndUpdateResult = activeSession({
    formResultId: "fr-9",
    ticketId: null,
    maxEvents: undefined
  });
  state.formResultFindOneResult = { answers: [] };

  await submitResponse(
    mockReq({
      body: { questionId: "q1", value: 1 },
      session: activeSession({ maxEvents: undefined })
    }),
    mockRes()
  );
  assert.equal(state.sessionFindOneAndUpdateCalls[0].update.$push.events.$slice, -200);
});

test("submitResponse renames the ticket subject when identityName changes", async () => {
  state.sessionFindOneAndUpdateResult = activeSession({
    formResultId: "fr-9",
    ticketId: "ticket-1"
  });
  state.formResultFindOneResult = { answers: [] };

  await submitResponse(
    mockReq({
      body: { questionId: "q1", value: 1, identityName: "  Bob  " },
      session: activeSession()
    }),
    mockRes()
  );

  const { update } = state.sessionFindOneAndUpdateCalls[0];
  assert.equal(update.$set.identityName, "Bob");
  assert.equal(update.$set.ticketSubject, "Phishing | Bob");
  const subjectSync = state.ticketUpdates.find((u) => u.update.$set?.ticket_subject);
  assert.ok(subjectSync, "ticket subject must be synced to the Ticket document");
  assert.equal(subjectSync.update.$set.ticket_subject, "Phishing | Bob");
});

// ── completeSession ───────────────────────────────────────────────────────────

test("completeSession rejects a foreign sessionId with 400", async () => {
  await rejectsWithStatus(
    completeSession(
      mockReq({ body: { sessionId: "other" }, session: activeSession() }),
      mockRes()
    ),
    400,
    /sessionId mismatch/
  );
});

test("completeSession rejects an already completed session with 409", async () => {
  await rejectsWithStatus(
    completeSession(
      mockReq({ body: {}, session: activeSession({ status: "completed" }) }),
      mockRes()
    ),
    409,
    /already completed/
  );
});

test("completeSession rejects a schemaHash conflict with 409", async () => {
  await rejectsWithStatus(
    completeSession(
      mockReq({
        body: { schemaHash: "h-2" },
        session: activeSession({ getLatestAnswers: () => [{ q: "q1", value: 1 }] })
      }),
      mockRes()
    ),
    409,
    /schemaHash does not match/
  );
});

test("completeSession rejects a session without answers with 400", async () => {
  await rejectsWithStatus(
    completeSession(
      mockReq({ body: {}, session: activeSession({ getLatestAnswers: () => [] }) }),
      mockRes()
    ),
    400,
    /No answers recorded/
  );
});

// ── getCurrentSession ─────────────────────────────────────────────────────────

test("getCurrentSession falls back to req.session and derives lastQuestionId from events", async () => {
  state.sessionFindOneAndUpdateResult = null; // refresh finds nothing persisted
  const expiresAt = new Date("2026-01-01T12:00:00.000Z");
  const res = mockRes();
  await getCurrentSession(
    mockReq({
      session: activeSession({
        tokenId: "csrf-1",
        events: [{ questionId: "a" }, { questionId: "b" }],
        expiresAt
      })
    }),
    res
  );

  assert.equal(res.body.sessionId, "s-1");
  assert.equal(res.body.csrfToken, "csrf-1");
  assert.equal(res.body.lastQuestionId, "b");
  assert.deepEqual(res.body.answers, []);
  assert.equal(res.body.expiresAt, expiresAt.toISOString());
});

// ── purgeResponses ────────────────────────────────────────────────────────────

test("purgeResponses rejects a foreign sessionId with 400", async () => {
  await rejectsWithStatus(
    purgeResponses(
      mockReq({ body: { sessionId: "other", questionIds: ["a"] }, session: activeSession() }),
      mockRes()
    ),
    400,
    /sessionId mismatch/
  );
});

test("purgeResponses is a no-op for empty or invalid questionIds", async () => {
  for (const questionIds of [undefined, [], ["   ", 7]]) {
    const res = mockRes();
    await purgeResponses(
      mockReq({ body: { questionIds }, session: activeSession() }),
      res
    );
    assert.deepEqual(res.body, { status: "ok", removed: 0 });
  }
  assert.equal(state.formResultFindOneCalls, 0);
  assert.equal(state.formResultUpdates.length, 0);
});

test("purgeResponses pulls only existing answers matching trimmed string ids", async () => {
  state.formResultFindOneResult = {
    answers: [
      { q: "a", value: 1 },
      { q: "b", value: 2 }
    ]
  };
  const res = mockRes();
  await purgeResponses(
    mockReq({
      body: { questionIds: ["a", "  ", 42, "zz"] },
      session: activeSession({ formResultId: "fr-9", ticketId: null })
    }),
    res
  );

  assert.deepEqual(res.body, { status: "ok", removed: 1 });
  assert.deepEqual(state.formResultUpdates[0].update, {
    $pull: { answers: { q: { $in: ["a", "zz"] } } }
  });
});

// ── resetSession ──────────────────────────────────────────────────────────────

test("resetSession deletes the session, clears the cookie and answers 204", async () => {
  const res = mockRes();
  await resetSession(mockReq({ session: activeSession() }), res);

  assert.deepEqual(state.sessionDeletes, [{ sessionId: "s-1" }]);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(res.clearedCookies, [
    { name: "inputform_session", options: { path: "/" } }
  ]);
});
