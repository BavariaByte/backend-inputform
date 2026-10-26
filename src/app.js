const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const createError = require("http-errors");
const env = require("./config/env");
const { logger } = require("./logger");
const apiRoutes = require("./routes");

const app = express();

const isDev = env.nodeEnv !== 'production';
const corsOrigins = env.corsOrigins; // [] in prod when INPUTFORM_URL is unset

if (!isDev && corsOrigins.length === 0) {
  logger.warn(
    "[cors] WARNING: NODE_ENV=production but INPUTFORM_URL is empty. " +
    "Browser clients will be rejected by CORS. Set INPUTFORM_URL to a comma-separated list of allowed origins."
  );
}

if (!isDev && !env.inputFormAuthEnabled) {
  logger.warn(
    "[auth] WARNING: NODE_ENV=production but INPUTFORM_AUTH_ENABLED=false. " +
    "Session creation and playbook routes are publicly accessible. " +
    "Set INPUTFORM_AUTH_ENABLED=true to enforce authentication."
  );
}

const corsOptions = {
  origin: (origin, callback) => {
    // No origin = same-origin or server-to-server request
    if (!origin) return callback(null, true);
    // Dev: allow any localhost port automatically
    if (isDev && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
    // Explicit allowlist from CORS_ORIGINS env var
    if (corsOrigins.includes(origin)) return callback(null, true);
    return callback(createError(403, 'Origin not allowed by CORS policy'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Form-Schema', 'X-CSRF-Token'],
  maxAge: 600,
};

app.disable("x-powered-by");

// Security headers for this JSON API. The API never serves HTML documents, so a
// maximally restrictive CSP is safe and best practice: if an endpoint is ever opened
// directly in a browser it cannot load any sub-resource and cannot be framed. These
// headers do NOT affect the SPA's cross-origin fetch/XHR calls — those are governed by
// CORS (configured below), not by CSP.
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: env.bodyLimit || "1mb" }));

// Anonymize the IP in morgan's :remote-addr token to reduce PII exposure
// (DSGVO Art. 32). IPv4 (incl. IPv4-mapped IPv6): zero last octet.
// Pure IPv6: keep the /48 network prefix, drop the rest.
if (env.anonymizeIp) {
  morgan.token("remote-addr", (req) => {
    const ip = req.ip || req.socket?.remoteAddress || "";
    if (!ip) return "";
    if (/\d+\.\d+\.\d+\.\d+/.test(ip)) {
      return ip.replace(/\d+$/, "0");
    }
    if (ip.includes(":")) {
      const head = ip
        .split(":")
        .slice(0, 3)
        .filter((p) => p !== "")
        .join(":");
      return head ? `${head}::` : "::";
    }
    return ip;
  });
}

const morganFormat =
  env.logFormat || ((env.logLevel === "debug" || env.logLevel === "trace") ? "dev" : "combined");
app.use(
  morgan(morganFormat, {
    skip: (req, res) => env.nodeEnv === "test" || (res.statusCode < 400 && env.logLevel !== "debug" && env.logLevel !== "trace")
  })
);

app.get("/healthz", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.use("/api", apiRoutes);

app.use((req, res, next) => {
  next(createError(404, "Route not found"));
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  // 5xx: never leak internal error details (Mongoose messages, stack hints,
  // etc.) to clients — log the real error and respond generically.
  const message =
    status >= 500 ? "Internal server error" : error.message || "Request failed";
  if (status >= 500) {
    logger.error(error);
  }
  res.status(status).json({
    error: {
      message,
      status
    }
  });
});

module.exports = app;
