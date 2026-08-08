const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { logger } = require("../logger");

const normalizeKey = (value) => (value ? value.replace(/\\n/g, "\n") : value);

const hasAsymmetricKeys = Boolean(env.jwt.privateKey);
const hmacSecret =
  env.jwt.secret || (env.nodeEnv === "development" ? "dev-session-secret" : "");

// Known example/placeholder values that must never sign production tokens.
const PLACEHOLDER_SECRETS = new Set([
  "dev-session-secret",
  "change-me",
  "change_me",
  "changeme",
  "secret",
  "password",
]);
const MIN_SECRET_LENGTH = 32;

if (env.nodeEnv === "production" && !hasAsymmetricKeys) {
  if (
    !hmacSecret ||
    PLACEHOLDER_SECRETS.has(hmacSecret.trim().toLowerCase()) ||
    hmacSecret.trim().length < MIN_SECRET_LENGTH
  ) {
    logger.error(
      "[jwt] FATAL: NODE_ENV=production requires a strong SESSION_JWT_SECRET " +
      "(or SESSION_JWT_PRIVATE_KEY/PUBLIC_KEY for RS256). Placeholder values " +
      `and secrets shorter than ${MIN_SECRET_LENGTH} characters are rejected. ` +
      "Generate ≥32 random bytes (e.g. `openssl rand -base64 48`) and set " +
      "SESSION_JWT_SECRET."
    );
    process.exit(1);
  }
}

function getSignKey() {
  if (hasAsymmetricKeys) {
    return normalizeKey(env.jwt.privateKey);
  }
  if (!hmacSecret) {
    throw new Error(
      "SESSION_JWT_SECRET or SESSION_JWT_PRIVATE_KEY must be provided to sign tokens"
    );
  }
  return hmacSecret;
}

function getVerifyKey() {
  if (hasAsymmetricKeys) {
    return normalizeKey(env.jwt.publicKey || env.jwt.privateKey);
  }
  if (!hmacSecret) {
    throw new Error(
      "SESSION_JWT_SECRET or SESSION_JWT_PUBLIC_KEY must be provided to verify tokens"
    );
  }
  return hmacSecret;
}

function signSessionToken({ sessionId, tokenId, expiresAt, formId, schemaHash }) {
  if (!sessionId || !tokenId) {
    throw new Error("sessionId and tokenId are required to sign a session token");
  }
  const key = getSignKey();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Math.floor(expiresAt.getTime() / 1000);
  const payload = {
    sid: sessionId,
    sub: sessionId,
    jti: tokenId,
    formId,
    schemaHash,
    iat: nowSeconds
  };
  return jwt.sign(payload, key, {
    algorithm: hasAsymmetricKeys ? "RS256" : "HS256",
    expiresIn: Math.max(expSeconds - nowSeconds, 60),
    issuer: env.jwt.issuer,
    audience: env.jwt.audience
  });
}

function verifySessionToken(token) {
  const key = getVerifyKey();
  return jwt.verify(token, key, {
    algorithms: hasAsymmetricKeys ? ["RS256"] : ["HS256"],
    issuer: env.jwt.issuer,
    audience: env.jwt.audience
  });
}

module.exports = { signSessionToken, verifySessionToken };
