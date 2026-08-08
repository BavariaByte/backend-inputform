# GIRP — Backend-Inputform

Express/Mongoose backend for the GIRP incident intake pipeline. Manages form
sessions, persists intermediate answers, and materialises completed submissions
as tickets via the shared `@girp/database-models` package.

Part of the **GIRP (Guided Incident Response Platform)** — see the other
repositories: Formbuilder, Frontend-Inputform, Frontend-SOCView,
Backend-SOCView and Launcher.

## Technology Stack

- **Runtime**: Node.js >= 22.16
- **Framework**: Express 4
- **Database**: MongoDB via Mongoose 8
- **Authentication**: Anonymous session JWTs (HS256 or RS256) + optional SSO
  (Entra ID via JWKS, or Better-Auth session validation through Backend-SOCView)
- **Shared Models**: `@girp/database-models` (npm package)

## Prerequisites

- Node.js >= 22.16 and npm
- A running MongoDB instance (replica set required for change streams in the
  full platform setup)

## Setup for Development

```bash
cp .env.example .env
npm install
npm run dev
```

The server listens on `http://localhost:4000` by default.

## Environment Variables

`.env.example` is the authoritative, fully commented reference. The most
important variables:

| Variable | Description | Default |
|---|---|---|
| `MONGODB_URI` | MongoDB connection string | — |
| `PORT` | HTTP port | `4000` |
| `NODE_ENV` | Must be `production` in production deployments | `development` |
| `INPUTFORM_URL` | Comma-separated list of allowed browser origins (CORS). Localhost is auto-allowed in development; an empty value blocks all browser requests in production. | — |
| `INPUTFORM_AUTH_ENABLED` | Require SSO login before form access. **Defaults to `true` (secure by default).** Set `false` only for local demos/tests. | `true` |
| `AUTH_AZURE_ENABLED` / `AUTH_BETTERAUTH_ENABLED` | Which SSO provider verifies tokens (shared with Backend-SOCView) | `false` / `true` |
| `SOCVIEW_API_URL` | Backend-SOCView URL for Better-Auth session validation | `http://localhost:3000` |
| `BETTERAUTH_COOKIE_NAMES` | Comma-separated cookie names checked for a Better-Auth session | `better-auth.session_token,__Secure-better-auth.session_token` |
| `SESSION_JWT_SECRET` | HMAC secret for HS256 session tokens. **Required in production**; the development fallback value is rejected at startup. Generate with `openssl rand -base64 48`. | — |
| `SESSION_JWT_PRIVATE_KEY` / `SESSION_JWT_PUBLIC_KEY` | PEM key pair for RS256 signing. Setting the private key switches signing to RS256 and overrides `SESSION_JWT_SECRET` (HS256); the matching public key must be set too. | — |
| `SESSION_TTL_MINUTES` | Default session lifetime | `120` |
| `SESSION_TTL_MAX_MINUTES` | Upper bound for client-requested lifetimes | `480` |
| `SESSION_RESUME_MAX_MINUTES` | Maximum inactivity window before session expiry | `30` |
| `SESSION_MAX_EVENTS_CAP` | Hard cap on stored events per session (DoS backstop) | `10000` |
| `SESSION_CREATE_RATE_LIMIT_PER_MIN` | Rate limit for `POST /api/sessions` per IP | `30` |
| `LOG_LEVEL` / `LOG_FORMAT` / `LOG_ANONYMIZE_IP` | Logging behaviour and GDPR-friendly IP anonymisation | `info` / — / `false` |

## Operating Modes & Abuse Protection

- **Authenticated mode (default)** — `INPUTFORM_AUTH_ENABLED=true`: creating
  sessions and fetching playbooks requires a valid SSO identity (Entra ID JWT
  or Better-Auth session). Playbook definitions cannot be retrieved
  anonymously.
- **Anonymous/demo mode** — `INPUTFORM_AUTH_ENABLED=false`: intended **only**
  for local demos (e.g. the GIRP Launcher) and isolated test environments. In
  this mode `POST /api/sessions` and the playbook routes are publicly
  reachable; the service logs a prominent warning when this is combined with
  `NODE_ENV=production`.
- Regardless of mode: session creation is rate-limited per IP, per-session
  event counts are capped, CORS uses a strict allowlist, and completed-session
  metadata from clients is sanitised.

## API Reference

Session-scoped routes are authenticated with a short-lived session JWT set as
an HttpOnly cookie (`inputform_session`); state-changing requests additionally
require the `X-CSRF-Token` header (double-submit, value returned as
`csrfToken` on session creation).

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sessions` | Creates a new intake session (SSO-protected unless auth is disabled). Body: `{ name?, formId, formVersion?, schemaHash?, ticketTitle?, playbookId?, ... }`. Sets the session cookie and returns `{ sessionId, csrfToken, expiresAt, resumeWindowMinutes, ticketId, formResultId, ticketSubject }`. A ticket linked to the new `FormResult` is created automatically. |
| `GET` | `/api/sessions/current` | Returns the authenticated session's status, last question and stored answers. |
| `POST` | `/api/responses` | Stores a single question response and updates scoring metadata. |
| `POST` | `/api/responses/purge` | Removes answers for the given question IDs (e.g. when a branch becomes unreachable). |
| `POST` | `/api/complete` | Finalises the session and writes the completed `FormResult`. |
| `DELETE` | `/api/sessions/current` | Resets/abandons the current session. |
| `GET` | `/api/playbooks/:id` | Returns the active playbook definition (SSO-protected unless auth is disabled). |
| `GET` | `/api/playbooks/:id/status` | Returns the playbook status. |
| `GET` | `/healthz` | Liveness probe. |

Error responses follow the structure:

```json
{
  "error": {
    "message": "Descriptive message",
    "status": 400
  }
}
```

## Session Lifecycle

1. A session is created via `POST /api/sessions`. A ticket and a `FormResult`
   document are created simultaneously.
2. Each `POST /api/responses` call appends a bounded event entry with the raw
   answer and score metadata and syncs the change into the ticket changelog.
3. `POST /api/complete` aggregates the latest answer per question and
   finalises the `FormResult`.
4. Sessions transition to `completed` or `expired`, after which no further
   writes are accepted.

Sessions are stored in the `FormSession` model from the shared
`@girp/database-models` package. Hot reload is available via `npm run dev`
(Node `--watch`). By default only responses with status >= 400 are logged; set
`LOG_LEVEL=debug` for verbose output.

## Development

```bash
npm run lint   # ESLint
npm test       # Node.js built-in test runner
```

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

Licensed under the [Sustainable Use License](LICENSE.md) (source-available).
