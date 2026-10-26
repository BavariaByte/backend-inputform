'use strict';

const env = require('../config/env');
const { logger } = require('../logger');

// ── Azure JWKS cache ─────────────────────────────────────────────────────────

let _azureCache = { jwks: null, issuer: null };

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : url + '/';
}

async function getAzureJwks() {
  if (_azureCache.jwks && _azureCache.issuer) return _azureCache;

  const { createRemoteJWKSet } = await import('jose');

  if (env.azure.jwksUri) {
    _azureCache.jwks = createRemoteJWKSet(new URL(env.azure.jwksUri));
    const issuerBase = env.azure.authority ||
      `https://login.microsoftonline.com/${env.azure.tenantId}/v2.0/`;
    _azureCache.issuer = ensureTrailingSlash(issuerBase);
    return _azureCache;
  }

  const issuerBase = env.azure.authority ||
    `https://login.microsoftonline.com/${env.azure.tenantId}/v2.0/`;
  const wellKnown = new URL('.well-known/openid-configuration', ensureTrailingSlash(issuerBase));
  const res = await fetch(wellKnown, { redirect: 'follow' });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const cfg = await res.json();
  _azureCache.jwks = createRemoteJWKSet(new URL(cfg.jwks_uri));
  _azureCache.issuer = cfg.issuer;
  return _azureCache;
}

// ── Main middleware ───────────────────────────────────────────────────────────

/**
 * authVerify — validates the Bearer token based on which providers are enabled
 * in the shared combined .env (AUTH_AZURE_ENABLED / AUTH_BETTERAUTH_ENABLED).
 *
 * If Azure is enabled: verify as Entra ID JWT via JWKS.
 * Otherwise: forward to SoCView /api/auth/get-session (Better-Auth).
 */
// Filter to the Better-Auth session cookies only — never forward the entire
// browser cookie jar (which may contain unrelated third-party cookies) to
// the auth backend.
function filterBetterAuthCookies(cookieHeader) {
  if (!cookieHeader) return '';
  const allowed = env.betterAuthCookieNames;
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => {
      const eq = c.indexOf('=');
      if (eq < 0) return false;
      return allowed.includes(c.slice(0, eq));
    })
    .join('; ');
}

let _validatedAuthUrl;
function getValidatedAuthUrl() {
  if (_validatedAuthUrl !== undefined) return _validatedAuthUrl;
  try {
    const parsed = new URL(env.socviewApiUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      _validatedAuthUrl = '';
    } else {
      _validatedAuthUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    }
  } catch {
    _validatedAuthUrl = '';
  }
  return _validatedAuthUrl;
}

async function authVerify(req, res, next) {
  if (!env.inputFormAuthEnabled) return next();

  const authHeader = req.headers.authorization;

  if (env.authAzureEnabled && authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
    }

    let payload;
    try {
      const { decodeJwt } = await import('jose');
      payload = decodeJwt(token);
    } catch {
      // Bearer header sent but token is not a valid JWT — reject rather than
      // silently falling through to cookie auth.
      return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
    }

    const issuer = (payload.iss || '').replace(/\/?$/, '/');
    const azureIssuer = (
      env.azure.authority ||
      `https://login.microsoftonline.com/${env.azure.tenantId}/v2.0/`
    ).replace(/\/?$/, '/');
    if (issuer === azureIssuer) {
      return verifyAzureToken(token, req, res, next);
    }
    // Parseable JWT, but not Azure-issued — fall through to Better-Auth.
  }

  return verifyBetterAuthToken(req, res, next);
}

async function verifyBetterAuthToken(req, res, next) {
  const baseUrl = getValidatedAuthUrl();
  if (!baseUrl) {
    logger.error({ socviewApiUrl: env.socviewApiUrl }, '[authVerify] SOCVIEW_API_URL is not a valid URL');
    return res.status(503).json({ error: { message: 'Auth service misconfigured', status: 503 } });
  }

  const filteredCookies = filterBetterAuthCookies(req.headers.cookie);
  if (!filteredCookies) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Cookie: filteredCookies },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
    }
    const data = await response.json();
    if (!data?.session) {
      return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
    }
    req.authUser = data.user;
    next();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(503).json({ error: { message: 'Auth service unavailable', status: 503 } });
    }
    logger.error({ err }, '[authVerify] Error verifying session');
    return res.status(503).json({ error: { message: 'Auth service unavailable', status: 503 } });
  }
}

async function verifyAzureToken(token, req, res, next) {
  try {
    const { jwtVerify } = await import('jose');
    const { jwks, issuer } = await getAzureJwks();
    const clientId = env.azure.clientId;
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: [clientId, `api://${clientId}`],
    });

    if (env.azure.allowedTenants.length && !env.azure.allowedTenants.includes(payload.tid)) {
      return res.status(403).json({ error: { message: 'Tenant not allowed', status: 403 } });
    }

    req.authUser = {
      id: payload.sub,
      email: payload.preferred_username || payload.upn || payload.email,
      name: payload.name,
    };
    next();
  } catch (err) {
    logger.error({ err }, '[authVerify] Azure token verification failed');
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }
}

module.exports = { authVerify };
