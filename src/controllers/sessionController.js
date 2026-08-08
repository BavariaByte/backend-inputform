const { randomUUID } = require("node:crypto");
const createError = require("http-errors");
const {
  FormResult,
  FormSession,
  TicketModel,
  CounterModel
} = require("@girp/database-models");
const env = require("../config/env");
const { logger } = require("../logger");
const { signSessionToken } = require("../services/jwt");

const parseNumber = (value, fallback = null) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseTimestamp = (value) => {
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError(400, "timestamp must be a valid ISO-8601 date string");
  }
  return date;
};

const ensureString = (value, field, { min = 1 } = {}) => {
  if (typeof value !== "string") {
    throw createError(400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw createError(400, `${field} must be at least ${min} characters long`);
  }
  return trimmed;
};

const getClientMeta = (req) => ({
  ip: req.ip,
  userAgent: req.get("user-agent"),
  acceptLanguage: req.get("accept-language")
});

// Server-managed meta fields that clients must never overwrite via the
// custom `meta` object on /api/complete.
const RESERVED_META_KEYS = new Set([
  "identityName",
  "clientMeta",
  "ticketId",
  "ticketSubject",
  "playbookId",
  "playbookVersion",
  "supportedLocales",
  "lastEventAt",
  "completedAt"
]);

const CUSTOM_META_MAX_KEYS = 20;
const CUSTOM_META_MAX_KEY_LENGTH = 64;
const CUSTOM_META_MAX_VALUE_LENGTH = 2000;

// Restricts client-supplied meta to a bounded set of flat primitive values so
// the FormResult document cannot be polluted or bloated by arbitrary payloads.
const sanitizeCustomMeta = (meta) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const sanitized = {};
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (count >= CUSTOM_META_MAX_KEYS) break;
    if (key.length > CUSTOM_META_MAX_KEY_LENGTH) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    if (RESERVED_META_KEYS.has(key)) continue;
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, CUSTOM_META_MAX_VALUE_LENGTH);
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else {
      continue;
    }
    count += 1;
  }
  return sanitized;
};

const encodeVal = (val, label) => {
  if (label != null && label !== "" && !Array.isArray(val)) {
    return { v: val, l: label };
  }
  return val;
};

const buildAnswerEntry = (event) => {
  const entry = {
    q: event.questionId,
    q_name: event.questionLabel || event.questionId,
    value: event.value
  };
  if (event.valueLabel) entry.valueLabel = event.valueLabel;
  return entry;
};

// Atomic refresh of session activity (and optional additional fields). Returns
// the freshly persisted document so callers can read consistent state.
// Race-safe: a concurrent writer's $set wins last-write — but no field is ever
// stomped by an in-memory snapshot from a stale read.
const refreshSessionActivity = async (sessionId, additionalSet = {}) => {
  return FormSession.findOneAndUpdate(
    { sessionId },
    { $set: { lastActivityAt: new Date(), updatedAt: new Date(), ...additionalSet } },
    { new: true }
  ).exec();
};

// Pipeline-form update: atomically replace OR append the matching answer in
// FormResult.answers. Single round-trip, no read-modify-write window.
const buildAnswerUpsertPipeline = (session, event, answerEntry) => {
  const metaSet = {
    "meta.identityName": session.identityName,
    "meta.clientMeta": session.clientMeta,
    "meta.lastEventAt": event.timestamp || new Date()
  };
  if (session.ticketId) metaSet["meta.ticketId"] = session.ticketId;
  if (session.ticketSubject) metaSet["meta.ticketSubject"] = session.ticketSubject;

  const baseSet = {
    answers: {
      $cond: [
        { $in: [event.questionId, { $ifNull: ["$answers.q", []] }] },
        {
          $map: {
            input: "$answers",
            as: "a",
            in: {
              $cond: [
                { $eq: ["$$a.q", event.questionId] },
                answerEntry,
                "$$a"
              ]
            }
          }
        },
        { $concatArrays: [{ $ifNull: ["$answers", []] }, [answerEntry]] }
      ]
    },
    formKey: session.formId,
    formVersion: session.formVersion || 1,
    "scoreMeta.status": "in-progress",
    "scoreMeta.variablesSnapshot":
      event.variablesSnapshot || session.variablesSnapshot || {},
    submittedAt: event.timestamp || new Date(),
    ...metaSet
  };
  if (session.schemaHash) {
    baseSet.formHash = session.schemaHash;
  }
  return [{ $set: baseSet }];
};

// upsertPartialResult — atomically merges a single event's answer into the
// FormResult, then pushes a changelog entry to the linked Ticket if the
// answer is new or changed. The diff is computed against a pre-update read,
// which is a best-effort snapshot only used for the changelog (not for data
// integrity).
const upsertPartialResult = async (session, event, oldVariables = null) => {
  const query = session.formResultId
    ? { _id: session.formResultId }
    : { "actor.sessionId": session.sessionId };

  const answerEntry = buildAnswerEntry(event);

  // Read current answers for changelog diff (best-effort).
  const before = await FormResult.findOne(query, { answers: 1 }).lean().exec();

  // First-write path: FormResult doesn't exist yet (createSession should have
  // made one — but stay defensive for legacy/migrated sessions).
  if (!before) {
    await FormResult.create({
      formKey: session.formId,
      formVersion: session.formVersion || 1,
      formHash: session.schemaHash,
      endScore: 0,
      answers: [answerEntry],
      actor: { userId: null, sessionId: session.sessionId },
      scoreMeta: {
        status: "in-progress",
        variablesSnapshot: session.variablesSnapshot || {}
      },
      submittedAt: event.timestamp || new Date(),
      meta: {
        identityName: session.identityName,
        clientMeta: session.clientMeta,
        playbookId: session.playbookId || null,
        playbookVersion: session.playbookVersion || null,
        supportedLocales: session.supportedLocales || null,
        ticketId: session.ticketId || null,
        ticketSubject: session.ticketSubject || null,
        lastEventAt: event.timestamp || new Date()
      }
    });

    if (!session.formResultId) {
      await FormSession.updateOne(
        { sessionId: session.sessionId },
        { $set: { formResultId: (await FormResult.findOne({ "actor.sessionId": session.sessionId }, { _id: 1 }).lean())?._id } }
      );
    }
    return;
  }

  const existingAnswers = Array.isArray(before.answers) ? before.answers : [];
  const oldAnswerEntry = existingAnswers.find((a) => a?.q === event.questionId) || null;
  const isNew = !oldAnswerEntry;
  const isChanged =
    oldAnswerEntry &&
    JSON.stringify(oldAnswerEntry.value) !== JSON.stringify(event.value);

  // Atomic answer upsert — single pipeline update, race-safe.
  await FormResult.updateOne(query, buildAnswerUpsertPipeline(session, event, answerEntry));

  // Changelog push for the answer (atomic on TicketModel — independent collection).
  if ((isNew || isChanged) && session.ticketId) {
    try {
      const changeEntry = {
        action: isNew ? "new" : "update",
        changed_field: "formResult.answers",
        changed_question: event.questionId,
        old_value: oldAnswerEntry
          ? encodeVal(oldAnswerEntry.value, oldAnswerEntry.valueLabel)
          : undefined,
        new_value: encodeVal(event.value, event.valueLabel),
        user: null,
        at: new Date()
      };
      await TicketModel.findByIdAndUpdate(session.ticketId, {
        $push: { changelog: changeEntry }
      });
      logger.debug(
        { action: changeEntry.action, questionId: event.questionId },
        `[upsertPartialResult] Synced change to Ticket ${session.ticketId}`
      );
    } catch (err) {
      logger.error({ err }, "[upsertPartialResult] Failed to sync changelog to ticket");
    }
  }

  // Variable changelog push.
  if (oldVariables && session.ticketId) {
    const newVariables = event.variablesSnapshot || {};
    const allKeys = new Set([
      ...Object.keys(oldVariables),
      ...Object.keys(newVariables)
    ]);
    const varChanges = [];
    for (const key of allKeys) {
      if (!(key in oldVariables)) continue;
      if (oldVariables[key] === newVariables[key]) continue;
      varChanges.push({
        action: "update",
        changed_field: `variables.${key}`,
        changed_question: event.questionId,
        old_value: oldVariables[key],
        new_value: newVariables[key] ?? 0,
        user: null,
        at: new Date()
      });
    }
    if (varChanges.length > 0) {
      try {
        await TicketModel.findByIdAndUpdate(session.ticketId, {
          $push: { changelog: { $each: varChanges } }
        });
      } catch (err) {
        logger.error({ err }, "[upsertPartialResult] Failed to sync variable changelog to ticket");
      }
    }
  }
};

const createSession = async (req, res) => {
  const name =
    typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : null;
  const formId = ensureString(req.body?.formId, "formId", { min: 2 });
  const schemaHash =
    typeof req.body?.schemaHash === "string" ? req.body.schemaHash : undefined;
  const schemaVersion =
    typeof req.body?.schemaVersion === "string"
      ? req.body.schemaVersion
      : undefined;
  const rawTicketTitle =
    typeof req.body?.ticketTitle === "string" ? req.body.ticketTitle.trim() : "";
  const ticketTitle = rawTicketTitle || formId;

  const playbookId =
    typeof req.body?.playbookId === "string" ? req.body.playbookId.trim() : null;
  const playbookVersion = parseNumber(req.body?.playbookVersion, null);
  const formVersion =
    parseNumber(req.body?.formVersion, null) ?? playbookVersion ?? 1;
  const supportedLocales = Array.isArray(req.body?.supportedLocales)
    ? req.body.supportedLocales.filter((l) => typeof l === "string")
    : null;
  const initialVariablesSnapshot =
    req.body?.variablesSnapshot &&
    typeof req.body.variablesSnapshot === "object" &&
    !Array.isArray(req.body.variablesSnapshot)
      ? req.body.variablesSnapshot
      : {};

  const requestedTtl = parseNumber(
    req.body?.sessionTtlMinutes,
    env.sessionTtlDefaultMinutes
  );
  const sessionTtlMinutes = Math.max(
    1,
    Math.min(requestedTtl, env.sessionTtlMaxMinutes)
  );
  const questionCount = parseNumber(req.body?.questionCount, null);
  const rawMaxEvents = questionCount ? questionCount * 10 : 200;
  const maxEvents = Math.min(Math.max(rawMaxEvents, 1), env.maxEventsHardCap);
  const now = new Date();
  const sessionId = randomUUID();
  const tokenId = randomUUID();
  const expiresAt = new Date(now.getTime() + sessionTtlMinutes * 60_000);
  const clientMeta = getClientMeta(req);
  const ticketSubject = name ? `${ticketTitle} | ${name}` : ticketTitle;

  let formResultDoc;
  let ticketDoc;
  try {
    formResultDoc = await FormResult.create({
      formKey: formId,
      formVersion,
      formHash: schemaHash,
      endScore: 0,
      answers: [],
      actor: { userId: null, sessionId },
      scoreMeta: { status: "in-progress", variablesSnapshot: {} },
      meta: {
        identityName: name,
        clientMeta,
        ticketSubject,
        ticketId: null,
        lastEventAt: null,
        playbookId: playbookId || null,
        playbookVersion: playbookVersion || null,
        supportedLocales: supportedLocales || null
      }
    });

    const counter = await CounterModel.findOneAndUpdate(
      { name: "ticket_id" },
      { $inc: { value: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const nextTicketId = counter.value;

    logger.debug(
      `[SessionController] Creating ticket with ID: ${nextTicketId}, Subject: ${ticketSubject}`
    );

    ticketDoc = await TicketModel.create({
      ticket_subject: ticketSubject,
      project_id: String(nextTicketId),
      formResult: formResultDoc._id,
      state: "open",
      ticket_id: nextTicketId
    });

    logger.debug(
      `[SessionController] Ticket created successfully: ${ticketDoc._id}, ProjectID: ${ticketDoc.project_id}`
    );

    await FormResult.findByIdAndUpdate(formResultDoc._id, {
      $set: { "meta.ticketId": ticketDoc._id }
    }).catch(() => {});
  } catch (error) {
    if (formResultDoc?._id) {
      await FormResult.findByIdAndDelete(formResultDoc._id).catch(() => {});
    }
    throw error;
  }

  await FormSession.create({
    sessionId,
    tokenId,
    formId,
    formVersion,
    schemaHash,
    schemaVersion,
    identityName: name,
    variablesSnapshot: initialVariablesSnapshot,
    clientMeta,
    expiresAt,
    lastActivityAt: now,
    formResultId: formResultDoc?._id || null,
    ticketId: ticketDoc?._id || null,
    ticketSubject,
    playbookId: playbookId || null,
    playbookVersion: playbookVersion || null,
    supportedLocales: supportedLocales || null,
    maxEvents,
    resumeWindowMinutes: sessionTtlMinutes
  });

  const sessionJwt = signSessionToken({
    sessionId,
    tokenId,
    expiresAt,
    formId,
    schemaHash
  });

  const isSecure = env.nodeEnv !== "development";
  res.cookie("inputform_session", sessionJwt, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: sessionTtlMinutes * 60 * 1000
  });

  res.status(201).json({
    sessionId,
    csrfToken: tokenId,
    expiresAt: expiresAt.toISOString(),
    resumeWindowMinutes: sessionTtlMinutes,
    ticketId: ticketDoc?._id || null,
    formResultId: formResultDoc?._id || null,
    ticketSubject
  });
};

const getCurrentSession = async (req, res) => {
  const session =
    (await refreshSessionActivity(req.session.sessionId)) || req.session;

  res.json({
    sessionId: session.sessionId,
    csrfToken: session.tokenId,
    formId: session.formId,
    formVersion: session.formVersion,
    schemaHash: session.schemaHash,
    schemaVersion: session.schemaVersion,
    status: session.status,
    identityName: session.identityName,
    variablesSnapshot: session.variablesSnapshot || {},
    lastActivityAt: session.lastActivityAt?.toISOString() || null,
    expiresAt: session.expiresAt?.toISOString() || null,
    lastQuestionId: session.getLastQuestionId
      ? session.getLastQuestionId()
      : (session.events?.length
          ? session.events[session.events.length - 1].questionId
          : null),
    answers: session.getLatestAnswers ? session.getLatestAnswers() : [],
    formResultId: session.formResultId || null,
    ticketId: session.ticketId || null,
    ticketSubject: session.ticketSubject || null
  });
};

const submitResponse = async (req, res) => {
  const session = req.session;
  const {
    sessionId,
    questionId,
    questionLabel,
    value,
    valueLabel,
    variablesSnapshot,
    schemaHash,
    timestamp,
    identityName
  } = req.body || {};

  if (sessionId && sessionId !== session.sessionId) {
    throw createError(400, "sessionId mismatch");
  }

  const validatedQuestionId = ensureString(questionId, "questionId");

  if (schemaHash && session.schemaHash && schemaHash !== session.schemaHash) {
    throw createError(409, "schemaHash does not match the active session");
  }

  const event = {
    questionId: validatedQuestionId,
    value,
    valueLabel:
      typeof valueLabel === "string" && valueLabel.trim().length
        ? valueLabel.trim()
        : undefined,
    questionLabel:
      typeof questionLabel === "string" && questionLabel.trim().length
        ? questionLabel.trim()
        : undefined,
    variablesSnapshot: variablesSnapshot || undefined,
    schemaHash: schemaHash || session.schemaHash,
    timestamp: parseTimestamp(timestamp),
    receivedAt: new Date(),
    clientMeta: getClientMeta(req)
  };

  // Variable change baseline — must be captured BEFORE the atomic update so we
  // can build the changelog from the old state.
  const prevVarsFromEvent = req.body?.prevVariablesSnapshot;
  const oldVariables =
    prevVarsFromEvent &&
    typeof prevVarsFromEvent === "object" &&
    !Array.isArray(prevVarsFromEvent)
      ? { ...prevVarsFromEvent }
      : { ...(session.variablesSnapshot || {}) };

  // Compose all session-level mutations into one atomic update.
  const sliceN = Math.max(session.maxEvents || 200, 1);
  const setOps = {
    lastActivityAt: new Date(),
    updatedAt: new Date()
  };
  if (!session.schemaHash && schemaHash) setOps.schemaHash = schemaHash;
  if (variablesSnapshot && typeof variablesSnapshot === "object") {
    setOps.variablesSnapshot = variablesSnapshot;
  }

  let newTicketSubject = null;
  if (
    typeof identityName === "string" &&
    identityName.trim() &&
    identityName.trim() !== session.identityName
  ) {
    const trimmedName = identityName.trim();
    setOps.identityName = trimmedName;
    const lastPipe = (session.ticketSubject || "").lastIndexOf(" | ");
    newTicketSubject =
      lastPipe !== -1
        ? session.ticketSubject.substring(0, lastPipe) + " | " + trimmedName
        : `${session.ticketSubject || session.formId} | ${trimmedName}`;
    setOps.ticketSubject = newTicketSubject;
  }

  const updatedSession = await FormSession.findOneAndUpdate(
    { sessionId: session.sessionId },
    {
      $push: { events: { $each: [event], $slice: -sliceN } },
      $set: setOps
    },
    { new: true }
  ).exec();

  if (!updatedSession) {
    throw createError(404, "Session vanished during update");
  }

  // Ticket subject sync (TicketModel — independent collection, safe to fire after).
  if (newTicketSubject && updatedSession.ticketId) {
    try {
      await TicketModel.findByIdAndUpdate(updatedSession.ticketId, {
        $set: { ticket_subject: newTicketSubject }
      });
    } catch (err) {
      logger.error({ err }, "[SessionController] Failed to update ticket subject");
    }
  }

  await upsertPartialResult(updatedSession, event, oldVariables);

  res.status(202).json({
    status: "accepted",
    sessionId: updatedSession.sessionId,
    lastQuestionId: updatedSession.getLastQuestionId
      ? updatedSession.getLastQuestionId()
      : event.questionId,
    receivedAt: event.receivedAt.toISOString()
  });
};

const completeSession = async (req, res) => {
  const session = req.session;
  const { sessionId, variablesSnapshot, schemaHash, formVersion, meta } =
    req.body || {};

  if (sessionId && sessionId !== session.sessionId) {
    throw createError(400, "sessionId mismatch");
  }

  if (session.status === "completed") {
    throw createError(409, "Session already completed");
  }

  if (schemaHash && session.schemaHash && schemaHash !== session.schemaHash) {
    throw createError(409, "schemaHash does not match the active session");
  }

  const answers = session.getLatestAnswers();
  if (!answers.length) {
    throw createError(400, "No answers recorded for this session");
  }

  const finalVariables = variablesSnapshot || session.variablesSnapshot || {};
  const completedAt = new Date();

  // Pre-existing FormResult (for valueLabel preservation).
  const query = session.formResultId
    ? { _id: session.formResultId }
    : { "actor.sessionId": session.sessionId };
  const existingResult = await FormResult.findOne(query).lean().exec();

  // Preserve valueLabel from any previously-stored partial answer that the
  // session-event-derived view doesn't carry.
  if (existingResult) {
    const existingAnswersMap = new Map();
    for (const ans of existingResult.answers || []) {
      existingAnswersMap.set(ans.q, ans);
    }
    for (const ans of answers) {
      if (!ans.valueLabel && existingAnswersMap.has(ans.q)) {
        const existing = existingAnswersMap.get(ans.q);
        if (existing.valueLabel) ans.valueLabel = existing.valueLabel;
      }
    }
  }

  const finalFormVersion =
    parseNumber(formVersion, session.formVersion) ||
    existingResult?.formVersion ||
    1;
  const customMeta = sanitizeCustomMeta(meta);

  let result;
  if (existingResult) {
    const setOps = {
      formKey: session.formId,
      formVersion: finalFormVersion,
      answers,
      "scoreMeta.status": "completed",
      "scoreMeta.variablesSnapshot": finalVariables,
      "meta.identityName": session.identityName,
      "meta.clientMeta": session.clientMeta,
      "meta.playbookId": session.playbookId || null,
      "meta.playbookVersion": session.playbookVersion || null,
      "meta.completedAt": completedAt,
      submittedAt: completedAt
    };
    if (session.schemaHash) setOps.formHash = session.schemaHash;
    for (const [k, v] of Object.entries(customMeta)) {
      setOps[`meta.${k}`] = v;
    }

    result = await FormResult.findOneAndUpdate(query, { $set: setOps }, { new: true }).exec();
  } else {
    result = await FormResult.create({
      formKey: session.formId,
      formVersion: finalFormVersion,
      formHash: session.schemaHash,
      endScore: 0,
      answers,
      actor: { userId: null, sessionId: session.sessionId },
      scoreMeta: { status: "completed", variablesSnapshot: finalVariables },
      meta: {
        identityName: session.identityName,
        clientMeta: session.clientMeta,
        playbookId: session.playbookId || null,
        playbookVersion: session.playbookVersion || null,
        supportedLocales: session.supportedLocales || null,
        ...customMeta,
        completedAt
      }
    });
  }

  // Atomically flip session status — only if not already completed.
  const finalSession = await FormSession.findOneAndUpdate(
    { sessionId: session.sessionId, status: { $ne: "completed" } },
    {
      $set: {
        status: "completed",
        completedAt,
        lastActivityAt: completedAt,
        updatedAt: completedAt,
        ...(variablesSnapshot && typeof variablesSnapshot === "object"
          ? { variablesSnapshot }
          : {}),
        ...(result && !session.formResultId ? { formResultId: result._id } : {})
      }
    },
    { new: true }
  ).exec();

  if (!finalSession) {
    throw createError(409, "Session already completed");
  }

  res.json({
    status: "completed",
    sessionId: finalSession.sessionId,
    resultId: result?._id
  });
};

const resetSession = async (req, res) => {
  const session = req.session;
  await FormSession.deleteOne({ sessionId: session.sessionId });
  res.clearCookie("inputform_session", { path: "/" });
  res.status(204).send();
};

const purgeResponses = async (req, res) => {
  const session = req.session;
  const { sessionId, questionIds, timestamp } = req.body || {};

  if (sessionId && sessionId !== session.sessionId) {
    throw createError(400, "sessionId mismatch");
  }

  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    return res.json({ status: "ok", removed: 0 });
  }

  const validIds = questionIds
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim());

  if (validIds.length === 0) {
    return res.json({ status: "ok", removed: 0 });
  }

  const query = session.formResultId
    ? { _id: session.formResultId }
    : { "actor.sessionId": session.sessionId };

  // Read removed entries first (for changelog) — best-effort snapshot.
  const before = await FormResult.findOne(query, { answers: 1 }).lean().exec();
  if (!before) {
    return res.json({ status: "ok", removed: 0 });
  }

  const removedAnswers = (before.answers || []).filter((a) =>
    validIds.includes(a.q)
  );
  if (removedAnswers.length === 0) {
    return res.json({ status: "ok", removed: 0 });
  }

  // Atomic pull of all matching answers in one update.
  await FormResult.updateOne(query, {
    $pull: { answers: { q: { $in: validIds } } }
  });

  if (session.ticketId) {
    const at = parseTimestamp(timestamp);
    const changeEntries = removedAnswers.map((ans) => ({
      action: "delete",
      changed_field: "formResult.answers",
      changed_question: ans.q,
      old_value: encodeVal(ans.value, ans.valueLabel),
      new_value: undefined,
      user: null,
      at
    }));
    try {
      await TicketModel.findByIdAndUpdate(session.ticketId, {
        $push: { changelog: { $each: changeEntries } }
      });
    } catch (err) {
      logger.error({ err }, "[purgeResponses] Failed to sync deletions to ticket");
    }
  }

  await refreshSessionActivity(session.sessionId);

  res.json({ status: "ok", removed: removedAnswers.length });
};

module.exports = {
  createSession,
  getCurrentSession,
  submitResponse,
  completeSession,
  resetSession,
  purgeResponses,
  // Exported for unit tests.
  sanitizeCustomMeta
};
