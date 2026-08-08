const createError = require("http-errors");
const env = require("../config/env");
const { logger } = require("../logger");
const { verifySessionToken } = require("../services/jwt");
const { FormSession } = require("@girp/database-models");
const asyncHandler = require("./asyncHandler");

const MAX_CLOCK_SKEW_MS = 15_000;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_COOKIE = "inputform_session";

const parseAuthorizationHeader = (headerValue) => {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token;
};

const requireSession = asyncHandler(async (req, res, next) => {
  // Prefer HttpOnly cookie; fall back to Authorization header (deprecated).
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  const bearerToken = parseAuthorizationHeader(req.get("authorization"));

  const rawToken = cookieToken || bearerToken;

  if (!rawToken) {
    throw createError(401, "Authorization token missing");
  }

  if (!cookieToken && bearerToken) {
    logger.warn(
      "[sessionAuth] Deprecated: session authenticated via Authorization header. " +
      "Migrate to HttpOnly cookie (inputform_session)."
    );
  }

  let payload;
  try {
    payload = verifySessionToken(rawToken);
  } catch (error) {
    // Keep the response generic — JWT library internals stay in the server log.
    logger.debug(`[sessionAuth] Session token verification failed: ${error.message}`);
    throw createError(401, "Invalid session token");
  }

  const sessionId = payload.sid || payload.sub;
  if (!sessionId) {
    throw createError(401, "Session token payload missing session id");
  }

  const session = await FormSession.findOne({ sessionId }).exec();
  if (!session) {
    throw createError(401, "Session not found");
  }

  if (session.tokenId !== payload.jti) {
    throw createError(401, "Session token no longer valid");
  }

  const now = Date.now();

  if (session.expiresAt && session.expiresAt.getTime() + MAX_CLOCK_SKEW_MS < now) {
    await FormSession.updateOne(
      { sessionId, status: { $ne: "expired" } },
      { $set: { status: "expired", updatedAt: new Date() } }
    );
    throw createError(401, "Session expired");
  }

  const resumeMaxMinutes = env.sessionResumeMaxMinutes || 60;
  if (
    session.lastActivityAt &&
    now - session.lastActivityAt.getTime() >
    resumeMaxMinutes * 60_000 + MAX_CLOCK_SKEW_MS
  ) {
    await FormSession.updateOne(
      { sessionId, status: { $ne: "expired" } },
      { $set: { status: "expired", updatedAt: new Date() } }
    );
    throw createError(401, "Session resume window exceeded");
  }

  if (session.status === "completed") {
    throw createError(409, "Session already completed");
  }

  if (session.status === "expired") {
    throw createError(401, "Session expired");
  }

  // CSRF protection for state-changing requests authenticated via cookie.
  // Bearer-based sessions skip CSRF (token itself is the proof of possession).
  if (cookieToken && !SAFE_METHODS.has(req.method)) {
    const csrfHeader = req.headers["x-csrf-token"];
    if (!csrfHeader || csrfHeader !== payload.jti) {
      throw createError(403, "CSRF token missing or invalid");
    }
  }

  req.sessionToken = payload;
  req.session = session;
  next();
});

module.exports = { requireSession };
