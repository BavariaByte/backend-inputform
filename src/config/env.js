const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");

const DEFAULT_ENV_FILE = ".env";

if (process.env.DISABLE_ENV_LOAD !== "true") {
  const explicitPath = process.env.ENV_FILE;
  const envPath = explicitPath
    ? path.resolve(process.cwd(), explicitPath)
    : path.resolve(process.cwd(), DEFAULT_ENV_FILE);

  // dotenv >= 17 logs an injection banner by default; quiet keeps stdout
  // reserved for the structured pino/morgan logs.
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  } else if (explicitPath) {
    throw new Error(`Environment file not found at ${envPath}`);
  } else {
    dotenv.config({ quiet: true });
  }
}

const isTrue = (value) => {
  const v = (value || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
};

const parseNumber = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseList = (value, fallback) => {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseNumber(process.env.PORT, 4000),
  mongodbUri: process.env.MONGODB_URI || "",
  corsOrigins: parseList(process.env.INPUTFORM_URL, []),
  bodyLimit: process.env.BODY_LIMIT || "1mb",
  logLevel: process.env.LOG_LEVEL || "info",
  // Secure by default: authentication is enabled unless explicitly disabled.
  // Set INPUTFORM_AUTH_ENABLED=false only for local demos (e.g. the GIRP
  // Launcher) or isolated test setups — never in production.
  inputFormAuthEnabled: process.env.INPUTFORM_AUTH_ENABLED !== 'false',
  logFormat: process.env.LOG_FORMAT || "",
  anonymizeIp: isTrue(process.env.LOG_ANONYMIZE_IP),
  sessionResumeMaxMinutes: parseNumber(process.env.SESSION_RESUME_MAX_MINUTES, 30),
  sessionTtlDefaultMinutes: parseNumber(process.env.SESSION_TTL_MINUTES, 120),
  sessionTtlMaxMinutes: parseNumber(process.env.SESSION_TTL_MAX_MINUTES, 480),
  maxEventsHardCap: parseNumber(process.env.SESSION_MAX_EVENTS_CAP, 10000),
  sessionCreateRateLimitPerMin: parseNumber(process.env.SESSION_CREATE_RATE_LIMIT_PER_MIN, 30),
  betterAuthCookieNames: parseList(
    process.env.BETTERAUTH_COOKIE_NAMES,
    ['better-auth.session_token', '__Secure-better-auth.session_token']
  ),
  // Auth mode is derived from the same vars as Backend-SoCView (shared combined .env)
  authAzureEnabled: isTrue(process.env.AUTH_AZURE_ENABLED) && Boolean(process.env.AZURE_CLIENT_ID),
  authBetterAuthEnabled: isTrue(process.env.AUTH_BETTERAUTH_ENABLED),
  socviewApiUrl: (process.env.SOCVIEW_API_URL || 'http://localhost:3000').replace(/\/$/, ''),
  azure: {
    tenantId: process.env.AZURE_TENANT_ID || 'common',
    clientId: process.env.AZURE_CLIENT_ID || '',
    authority: process.env.AZURE_AUTHORITY || process.env.OIDC_ISSUER || '',
    jwksUri: process.env.OIDC_JWKS_URI || '',
    allowedTenants: parseList(process.env.ALLOWED_TENANTS, []),
  },
  jwt: {
    secret: process.env.SESSION_JWT_SECRET || "",
    privateKey: process.env.SESSION_JWT_PRIVATE_KEY || "",
    publicKey: process.env.SESSION_JWT_PUBLIC_KEY || "",
    issuer: process.env.SESSION_JWT_ISSUER || "incident-intake-backend",
    audience: process.env.SESSION_JWT_AUDIENCE || "incident-intake-client"
  }
};

if (!env.mongodbUri) {
  console.warn(
    "[config] MONGODB_URI is not set. The application will fail to connect until it is provided."
  );
}

module.exports = env;
