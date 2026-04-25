# Secure Credential Drop

**Self-Destructing Password Sharer — S&S Tech Services Technical Assessment**

---

## Table of Contents

1. [Candidate Info](#1-candidate-info)
2. [Project Overview](#2-project-overview)
3. [Tech Stack & Decisions](#3-tech-stack--decisions)
4. [Project Structure](#4-project-structure)
5. [Setup & Run](#5-setup--run)
6. [Environment Variables](#6-environment-variables)
7. [API Reference](#7-api-reference)
8. [Challenge 1 — Race Condition Prevention](#8-challenge-1--race-condition-prevention)
9. [Challenge 2 — Crawler / Bot Protection](#9-challenge-2--crawler--bot-protection)
10. [Challenge 3 — Resilient Cleanup](#10-challenge-3--resilient-cleanup)
11. [Trade-offs & What I'd Do Differently](#11-trade-offs--what-id-do-differently)

---

## 1. Candidate Info

| | |
|---|---|
| **Name** | Nischal Silwal |
| **Email** | <nischalsilwalhtd@gmail.com> |
| **Submission date** | 2026-04-24 |
| **Time taken** | ~4 hours |

---

## 2. Project Overview

Secure Credential Drop is a micro-service that lets users share sensitive data — passwords, API keys, tokens — via a **one-time, self-destructing link**. The sender pastes a secret, chooses an expiry window, and receives a unique URL. When the recipient clicks the link and deliberately presses **"Reveal Secret"**, the plaintext is decrypted, displayed, and **permanently deleted** from the database in a single atomic operation. If nobody opens the link before the TTL expires, the secret becomes inaccessible and is eventually purged by a background cleanup job. The secret is encrypted at rest using AES-256-GCM, so even database access does not expose plaintext.

---

## 3. Tech Stack & Decisions

| Layer | Technology | Why chosen |
|-------|-----------|------------|
| Runtime | **Node.js 20** | Non-blocking I/O is ideal for this request-heavy micro-service; large ecosystem, easy deployment. |
| Framework | **Express 4** | Minimal, unopinionated, battle-tested HTTP framework. Middleware architecture makes it easy to compose rate limiting, CORS, and helmet (with CSP configured to allow inline scripts for SPA). |
| Database | **PostgreSQL 16** | ACID-compliant, supports atomic `DELETE … RETURNING`, row-level locking guarantees race-condition safety, and partial indexes for efficient queries on unviewed secrets. |
| Encryption | **Node.js `crypto` (AES-256-GCM)** | Built-in, no external dependency; GCM provides authenticated encryption ensuring both confidentiality and integrity of stored secrets. |
| Containerisation | **Docker Compose** | One-command setup for PostgreSQL + API; reproducible across environments. |

---

## 4. Project Structure

```
/project-root
  ├── /api
  │    ├── server.js              Express entry point, DB pool, cleanup job
  │    ├── /routes/secrets.js     POST (Create) & POST (Burn — bot-protected)
  │    └── /utils/crypto.js       AES-256-GCM encrypt / decrypt
  ├── /db
  │    └── schema.sql             Table: id, encrypted_body, expires_at, is_viewed
  ├── /scripts
  │    ├── verify.js              End-to-end verification (5 tests)
  │    └── test-race.js           Concurrent race-condition stress test
  ├── /web
  │    └── index.html             Single-page UI — create form and reveal page
  ├── package.json
  ├── docker-compose.yml
  ├── Dockerfile
  └── .env.example
```

---

## 5. Setup & Run

**Prerequisites:** Node.js 18+, PostgreSQL 14+ (or Docker)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL and MASTER_KEY — see Section 6

# 3a. Start PostgreSQL via Docker (recommended)
docker-compose up -d db

# 3b. Or point DATABASE_URL to an existing PostgreSQL instance,
#     then initialize the schema:
npm run db:init

# 4. Start the server
npm run dev       # development (nodemon, auto-restart)
npm start         # production
```

Open `http://localhost:3000` in a browser — the server serves the web UI directly.

**Full Docker setup (API + DB):**

```bash
docker-compose up -d
```

**Run tests (server must be running):**

```bash
npm run verify        # End-to-end functional tests
npm run test:race     # Race condition stress test
```

---

## 6. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string — `postgresql://user:pass@localhost:5432/secret_drop` |
| `MASTER_KEY` | Yes | 64-char hex string (32 bytes) for AES-256-GCM. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | No | Server port (default: `3000`) |
| `FRONTEND_ORIGIN` | No | Override the generated link origin (default: auto-detected from request) |

---

## 7. API Reference

### `POST /api/secrets` — Create a secret

**Request body**

```json
{ "secret": "my-password", "ttl": 3600 }
```

| Field | Type | Description |
|-------|------|-------------|
| `secret` | string | Plaintext to store (max 10 KB) |
| `ttl` | number | Expiry in seconds from now (min 1, max 604800) |

**Response `201 Created`**

```json
{
  "id": "<uuid>",
  "link": "http://…/?id=<uuid>",
  "expiresAt": "2026-04-25T14:53:24.000Z"
}
```

---

### `POST /api/secrets/:id/burn` — Retrieve and burn (bot-protected)

**Required header:** `X-Burn-Token: confirm`

**Response `200 OK`** — secret returned, permanently deleted from the database

```json
{ "secret": "my-password" }
```

**Response `403 Forbidden`** — missing or invalid `X-Burn-Token` header

```json
{ "error": "Missing or invalid burn token." }
```

**Response `404 Not Found`** — does not exist, already viewed, or expired

```json
{ "error": "Secret not found, already viewed, or expired." }
```

---

## 8. Challenge 1 — Race Condition Prevention

> **Requirement:** If two requests hit the same link at the exact same millisecond, only one must receive the secret. The other must get a 404.

### Strategy

**Atomic `DELETE … RETURNING`** — a single SQL statement that finds the unviewed, non-expired secret, deletes it, and returns the encrypted body in one atomic operation.

### Implementation

**File:** [`api/routes/secrets.js`](api/routes/secrets.js) — `POST /:id/burn` handler.

```sql
DELETE FROM secrets
WHERE id = $1
  AND is_viewed = FALSE
  AND expires_at > NOW()
RETURNING encrypted_body;
```

This is a single SQL statement, not a `SELECT` followed by a `DELETE`. PostgreSQL executes it as one atomic unit with an implicit exclusive row lock.

### Why this works under concurrency

PostgreSQL acquires an **exclusive row-level lock** when executing `DELETE`. When two transactions target the same row simultaneously:

1. **Transaction A** acquires the lock first, deletes the row, and returns the `encrypted_body`.
2. **Transaction B** waits for the lock. When it acquires it, the row no longer exists → zero rows returned → 404 response.

There is no window between "check" and "delete" — both happen in a single atomic statement. This guarantee holds even under thousands of concurrent requests.

---

## 9. Challenge 2 — Crawler / Bot Protection

> **Requirement:** Automated crawlers (Slack previews, WhatsApp link cards, search bots) must not accidentally burn the secret by fetching the share URL.

### Strategy

**POST-only burn endpoint with custom header verification.**

Three layers of protection:

1. The burn endpoint uses **`POST`** instead of `GET` — crawlers only issue GET/HEAD requests.
2. A **custom header** `X-Burn-Token: confirm` is required — crawlers never send custom headers.
3. The frontend uses a **two-step reveal flow** — the secret is not fetched on page load; the user must click "Reveal Secret."

### Implementation

**Server side** ([`api/routes/secrets.js`](api/routes/secrets.js)):

- The endpoint is `POST /api/secrets/:id/burn` (not GET).
- The handler validates `req.headers['x-burn-token'] === 'confirm'` before proceeding. Missing or incorrect values return `403 Forbidden`.

**Client side** ([`web/index.html`](web/index.html)):

- When a user visits `?id=<uuid>`, the page shows a "Reveal Secret" button but does **not** fetch the secret.
- Only when the user clicks the button does the frontend fire a `POST` request with the `X-Burn-Token: confirm` header.

### Why bots cannot trigger the burn

| Bot behavior | Why it fails |
|---|---|
| GET request to the page URL | The page loads but no API call is made (two-step reveal). |
| GET request to the API | There is no `GET /api/secrets/:id` endpoint. Only `POST /:id/burn` exists. Returns 404. |
| HEAD request | Same as above — no matching route. |
| POST without header | Returns `403 Forbidden` because `X-Burn-Token` is missing. |

**Can this be spoofed?** Yes — any client that sends `POST` with the correct header can burn the secret. But this requires deliberate, targeted action, not accidental crawling. For higher assurance, a CAPTCHA (e.g. hCaptcha) could be added to the reveal step.

---

## 10. Challenge 3 — Resilient Cleanup

> **Requirement:** A secret must be inaccessible after `expires_at` even if the server was offline when it expired. Storage should eventually be reclaimed.

### Strategy

**Two-layer defense:**

| Layer | Purpose | Location |
|---|---|---|
| **Query-time guard** | Ensures expired secrets are **never returned**, regardless of cleanup state | `DELETE … WHERE expires_at > NOW()` in the burn handler |
| **Periodic cleanup** | Physically deletes expired rows to **reclaim storage** | Background job in `server.js` |

### Implementation

**1. Query-time guard** ([`api/routes/secrets.js`](api/routes/secrets.js)):

```sql
DELETE FROM secrets
WHERE id = $1
  AND is_viewed = FALSE
  AND expires_at > NOW()       -- ← expired secrets are excluded
RETURNING encrypted_body;
```

Even if the cleanup job hasn't run, an expired secret cannot be returned because `expires_at > NOW()` fails.

**2. Periodic cleanup** ([`api/server.js`](api/server.js)):

```sql
DELETE FROM secrets WHERE expires_at <= NOW();
```

This runs:

- **On server startup** — catches anything that expired while the server was down.
- **Every 10 minutes** — continuously reclaims storage.

### Why this survives server restarts

Correctness does **not** depend on the server being continuously running:

1. **During downtime:** Secrets that expire sit in the database, but the `expires_at > NOW()` clause in the burn query prevents them from ever being returned. They are effectively dead.
2. **On restart:** `cleanupExpired()` runs immediately, deleting all rows where `expires_at <= NOW()`. This catches the entire backlog.
3. **Ongoing:** The 10-minute interval handles any future expirations.

The database column `expires_at` is the single source of truth — no in-memory timers are relied upon.

---

## 11. Trade-offs & What I'd Do Differently

### What I chose and why

- **`DELETE … RETURNING` over `SELECT FOR UPDATE` + `UPDATE`:** Simpler, fewer round trips, impossible to have a gap between check and burn. Trade-off: we lose the row immediately, so there is no audit trail.
- **Custom header over CAPTCHA:** Much simpler to implement, zero UX friction. Trade-off: a determined attacker could spoof the header.
- **Periodic cleanup over TTL-based auto-expiry (e.g. Redis TTL):** PostgreSQL is already in the stack; adding Redis would increase operational complexity for a micro-service.

### What I'd improve with more time

1. **CAPTCHA on reveal:** Add hCaptcha or Cloudflare Turnstile to the reveal page for stronger bot protection.
2. **Client-side encryption:** Encrypt in the browser with a key embedded in the URL fragment (`#key=…`). The server never sees the plaintext, achieving true zero-knowledge.
3. **Audit logging:** Log secret creation and burn events (without the plaintext) for operational observability.
4. **Health check with DB ping:** The `/health` endpoint should verify the database connection, not just return 200.
5. **Configurable cleanup interval:** Allow the cleanup interval to be set via environment variable.
6. **Production hardening:** Add structured logging (pino/winston)
