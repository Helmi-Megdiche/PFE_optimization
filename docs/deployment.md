# Deployment Guide — SafeGuard AI Parental Control Platform

**Author:** Helmi Megdiche — ESPRIT (5th-year PFE)
**Repository:** [github.com/Helmi-Megdiche/PFE_optimization](https://github.com/Helmi-Megdiche/PFE_optimization)
**Document version:** Current `main` (post-Phase B, September 2026). v1.0-final (5 June 2026, `59da85b`) was the pre-Phase-B release.
**Audience:** developers and operators deploying the backend, database, dashboard, and Android app.

> This guide covers both the **development** setup (the supported PFE demo path) and a **production-oriented** deployment (recommended hardening). Where the two differ, both are shown.

---

## Table of Contents

1. [Deployment Overview](#1-deployment-overview)
2. [Prerequisites](#2-prerequisites)
3. [Environment Configuration](#3-environment-configuration)
4. [Database Setup and Migrations](#4-database-setup-and-migrations)
5. [Backend Deployment](#5-backend-deployment)
6. [Parent Dashboard Deployment](#6-parent-dashboard-deployment)
7. [Android App Build and Distribution](#7-android-app-build-and-distribution)
8. [Networking, TLS, and Firewall](#8-networking-tls-and-firewall)
9. [Production Hardening Checklist](#9-production-hardening-checklist)
10. [Operations: Backups, Logs, Monitoring](#10-operations-backups-logs-monitoring)
11. [Troubleshooting](#11-troubleshooting)
12. [Release Procedure](#12-release-procedure)

---

## 1. Deployment Overview

| Component | Dev | Production (recommended) |
|-----------|-----|--------------------------|
| Database | PostgreSQL 16 in Docker (host :5433) | Managed PostgreSQL 14+ with backups |
| Backend | `tsx watch src/index.ts` (:3000) | `node dist/index.js` behind HTTPS proxy |
| Dashboard | Served at `/demo.html` from API | Same-origin static, HTTPS |
| Android app | Debug build via Metro | Signed release APK/AAB |
| Dev/debug routes | Enabled | **Disabled** (`NODE_ENV=production`) |

```mermaid
graph TB
    subgraph Prod["Production"]
        PROXY[HTTPS reverse proxy<br/>nginx / Caddy] --> API[Node API dist/]
        API --> DB[(Managed PostgreSQL)]
        PROXY --- DASH[/demo.html static/]
    end
    APK[Signed Android app] -- HTTPS --> PROXY
    PARENT[Parent browser] -- HTTPS --> PROXY
```

---

## 2. Prerequisites

| Tool | Version | Used for |
|------|---------|----------|
| Node.js | 18 or 20 | Backend runtime + build |
| npm | 8+ | Package management |
| PostgreSQL | 14+ (16 in Docker) | Data store |
| Docker Desktop | latest | Local DB (optional in prod) |
| Android Studio + SDK | API 29+ | App build |
| Java (JDK) | 17 | Gradle |
| Git | latest | Source control |

---

## 3. Environment Configuration

### 3.1 Backend `.env`

Copy `backend/.env.example` to `backend/.env` and edit:

```env
NODE_ENV=development                # set to "production" in prod (disables /dev + /debug)
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/pfe_parental_control
JWT_SECRET=change-me-in-production-use-long-random-string
JWT_ISSUER=pfe-parental-control
LOG_LEVEL=info
MISSION_RISK_COOLDOWN_MINUTES=2     # dev 2, prod 15
APP_TIMEZONE=Africa/Tunis           # day boundaries, night window, cron fire time
```

| Variable | Meaning | Production guidance |
|----------|---------|---------------------|
| `NODE_ENV` | Environment mode | **`production`** — removes dev token minting and debug image endpoints |
| `PORT` | API port | Bind behind a reverse proxy |
| `DATABASE_URL` | PostgreSQL DSN | Use managed DB credentials; require SSL |
| `JWT_SECRET` | Token signing key | Long, random, secret-managed (not committed) |
| `JWT_ISSUER` | Token issuer claim | Keep stable across restarts |
| `LOG_LEVEL` | Log verbosity | `info` or `warn` |
| `MISSION_RISK_COOLDOWN_MINUTES` | How long an escaped (abandoned) risky mission keeps blocking a new one: a new risky-content mission is blocked while a pending risky mission exists or one was escaped within this window, and a further risky capture re-surfaces the existing mission instead | **15** in production (2 min in development) |
| `APP_TIMEZONE` | IANA zone for score-day boundaries, the night-usage window and the 01:00 cron (default `Africa/Tunis`) | Validated at boot; an unknown zone name stops the server |

> Never commit `.env`. It is already covered by `.gitignore`.

### 3.2 Mobile `apiConfig.ts`

`MobileApp/src/config/apiConfig.ts` selects the API base URL:

```typescript
export const DEV_LAN_HOST = '192.168.x.x';  // your PC's Wi-Fi IPv4 (ipconfig)
```

`getApiBaseUrl()` returns `10.0.2.2:3000` on emulators, `DEV_LAN_HOST:3000` on physical devices. For production, point this at your HTTPS domain and rebuild the app.

---

## 4. Database Setup and Migrations

### 4.1 Docker (development)

```bash
cd backend
npm run db:up          # PostgreSQL 16 on host port 5433
npm run db:migrate     # apply all migrations 000..016 (ledger-tracked, safe to re-run)
```

`docker-compose.yml` provisions `pfe-postgres` with a healthcheck and a named volume `pfe_pg_data`.

### 4.2 Managed / local PostgreSQL (production)

1. Create database `pfe_parental_control`.
2. Set `DATABASE_URL` to the managed instance (with `sslmode=require` if applicable).
3. Run migrations:

```bash
cd backend
npm run db:migrate
```

The runner (`src/db/migrate.ts`) applies the SQL files in `src/db/migrations/` in lexical order, each in its own transaction, and records every applied file in a `schema_migrations` ledger it creates itself. Re-running is a safe no-op; a failed migration rolls back with no ledger row; editing an already-applied file is refused by checksum. A pre-existing database with no ledger is auto-detected — stamped without executing if it is already at head, otherwise the run aborts with a `MIGRATE_BASELINE_UPTO=<file>` resume hint. There are 16 files, `000`–`016`; there is no `004` (numbering skips it), which is expected. See [architecture.md](architecture.md) §5.2 for the full migration inventory and `backend/DATABASE.md` for the ledger details.

### 4.3 Seed data

Migrations `011` and `013` seed the quiz bank (22 questions: safety 5, conflict 5, empathy 4, media_violence 8), which is served from the database at mission-generation time. `002_dev_seed.sql` inserts a demo parent and child used by `/api/dev/*` token minting. In production you would replace this with a real provisioning flow (out of scope for v1.0-final).

---

## 5. Backend Deployment

### 5.1 Development

```bash
cd backend
npm install
npm run dev            # tsx watch, http://localhost:3000
```

### 5.2 Production build & run

```bash
cd backend
npm ci
npm run build          # tsc -> dist/
NODE_ENV=production node dist/index.js
```

Recommended process management: run under a supervisor (systemd, PM2, or a container) with automatic restart. Example systemd unit:

```ini
[Unit]
Description=SafeGuard API
After=network.target

[Service]
WorkingDirectory=/opt/safeguard/backend
Environment=NODE_ENV=production
EnvironmentFile=/opt/safeguard/backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=safeguard

[Install]
WantedBy=multi-user.target
```

The daily scoring cron is in-process (`node-cron`) and fires at 01:00 in `APP_TIMEZONE`, whatever the host's own time zone. Score-day boundaries and the night-usage window use the same zone; bedtime variance is computed in UTC on purpose (see [scoring_formulas.md](scoring_formulas.md)).

---

## 6. Parent Dashboard Deployment

The dashboard is `demo_dashboard.html` (repo root). The API serves it directly at `/demo.html` from that file — there is no copy under `backend/public/` and no sync step. A deploy must keep `demo_dashboard.html` one level above the backend directory (i.e. at the repo root, as checked out), or drop a copy at `backend/public/demo.html` — the `express.static` mount still serves that as a fallback. A missing file returns 404, not 500.

- Access: `https://<your-domain>/demo.html`.
- Use the backend URL (not `file://`) so browser notifications work.
- The page refreshes every 10 s while open. Browser pop-up notifications (polled every 30 s) fire only for missions awaiting approval and for escaped missions. There is no push, email or SMS notification to the parent; browser block incidents are stored and shown on the dashboard only.
- The dashboard authenticates with a parent JWT (from `/api/dev/parent-token` in dev). In production, wire it to a real login before exposing publicly.

---

## 7. Android App Build and Distribution

### 7.1 Debug (development)

```bash
cd MobileApp
npm install
npm start              # Metro (:8081)
npm run android        # build & install on device/emulator
```

On Windows with the repository under OneDrive, `npm run android` fails; see the OneDrive row in [§11 Troubleshooting](#11-troubleshooting).

### 7.2 Release build

1. Configure a signing key in `android/` (keystore + `gradle.properties`).
2. Set the production API host in `apiConfig.ts` and rebuild.
3. Build the artifact:

```bash
cd MobileApp/android
./gradlew assembleRelease     # APK
# or
./gradlew bundleRelease       # AAB for Play Store
```

Artifacts appear under `android/app/build/outputs/`.

> **Rebuild triggers:** any change to native modules (`ScreenCaptureModule`, `ForegroundAppModule`, overlay, the accessibility service and its browser blocker), the `nsfw.tflite` model, or the bundled `adult_domains.txt` list requires a native rebuild (`npm run android` / gradle), not just a Metro reload.

### 7.3 Required device permissions

| Permission | Why | Without it |
|------------|-----|-----------|
| MediaProjection consent | Screen capture | No capture at all |
| Foreground service notification | Android 14+ capture | Capture cannot run |
| Usage Access (optional) | Accurate `app_package` | Falls back to ActivityManager (less accurate) |
| Display over other apps | Mission overlay on third-party apps | Notification + in-app mission fallback |
| Accessibility service ("SafeGuard", enabled by hand in Settings → Accessibility) | Adult-site blocking in Chrome; instant app-switch and keyboard detection | No site blocking; app switches fall back to a 1 s UsageStats poll |
| Notifications (Android 13+) | Foreground-service and mission notifications | Notifications hidden |

**Accessibility service caveat.** On some Android ROMs, swiping SafeGuard away from Recents stops the Accessibility service, and reopening the app does not restore it. Re-enable it by hand in Settings → Accessibility. To check it's running, look for a live window-change event in the logs; `settings get … enabled_accessibility_services` is not a reliable check. The Monitor tab's **Accessibility service** card reads **Active** only after the service has actually delivered an event.

---

## 8. Networking, TLS, and Firewall

### 8.1 Development (LAN)

- Phone and PC on the **same Wi-Fi**.
- Allow inbound **TCP 3000** in the host firewall.
- Verify from the phone browser: `http://<PC-IP>:3000/api/health` → `{"status":"ok"}`.

### 8.2 Production

- Terminate **HTTPS** at a reverse proxy (nginx/Caddy); proxy to the Node port.
- Restrict database access to the app host; require SSL to the DB.
- Set CORS to the dashboard origin only.

Example nginx proxy:

```nginx
server {
    listen 443 ssl;
    server_name safeguard.example.com;
    # ssl_certificate / ssl_certificate_key ...
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 9. Production Hardening Checklist

- [ ] `NODE_ENV=production` (disables `/api/dev/*` and `/api/debug/*`).
- [ ] Strong, secret-managed `JWT_SECRET`; rotate periodically.
- [ ] `MISSION_RISK_COOLDOWN_MINUTES=15`.
- [ ] HTTPS everywhere; HSTS at the proxy.
- [ ] Managed PostgreSQL with automated backups + SSL.
- [ ] Replace dev seed + dev tokens with real **authentication** (registration / login / token issuance — none exists yet). Per-route parent–child **ownership** is already enforced (`backend/src/middleware/childAccess.ts` + `tests/routeAuthorization.test.ts`).
- [ ] Restrict CORS to the dashboard origin.
- [ ] App points at the HTTPS domain; signed release build.
- [ ] Log shipping and uptime monitoring on `/api/health`.
- [ ] Review privacy/consent copy and legal framing (GDPR/COPPA).

> These items reflect the limitations listed in [README.md — Known limitations / future work](../README.md#known-limitations--future-work); the current build is a demo-grade deployment.

---

## 10. Operations: Backups, Logs, Monitoring

| Concern | Approach |
|---------|----------|
| **Backups** | `pg_dump` on a schedule (or managed snapshots); test restores |
| **Logs** | Backend emits structured JSON logs to stdout — ship to your aggregator |
| **Health** | Poll `GET /api/health` for liveness |
| **Cron** | Daily job logs `Daily score cron scheduled`; verify `daily_scores` rows appear after 01:00 |
| **Metrics** | Track request errors, 401 rates, and mission generation reasons in logs |

Manual cron re-run (dev): call `runDailyScoreJob()` from `backend/src/jobs/dailyScoreJob.ts`.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Device "Network error" | Wrong `DEV_LAN_HOST`, firewall, different Wi-Fi | Fix host IP; open TCP 3000; same network |
| `MediaProjection denied` | Consent not granted / manifest issue | Re-grant; ensure foreground service in manifest |
| HTTP 400 on screen-events | Preview > 500 chars | Ensure preview truncated ≤ 500 |
| `cooldown_active` / `pending_limit_reached`, no overlay | Pending/limit reached | Expected; overlay should re-surface. If not, restart backend; clear old pending missions |
| Frames emit, no OCR / endless `OCR lock takeover` | Wedged foreground lookup | Self-heal added; reload JS or toggle monitoring |
| Gradle / OneDrive file locks | Syncing `android/build` via OneDrive | Clean `.gradle`; exclude build dirs from sync |
| Dev token 401 loop | Backend down during refresh | Keep API on :3000; token auto-refreshes |
| Empty OCR | Low-contrast/blank screen | Use screens with clear, larger text |
| Accessibility card not **Active**, or adult sites not blocked | The OS stopped the accessibility service (e.g. SafeGuard swiped from Recents on some ROMs) | Re-enable it by hand in Settings → Accessibility, switch apps once, and confirm the card reads **Active** (see §7.3) |
| Listed site opens for a moment after the service starts | The domain lists load in the background (under a second) | Expected; blocking starts once the lists are loaded |
| `'gradlew.bat' is not recognized` or `Could not move temporary workspace` on Windows | Repository under OneDrive: the RN CLI spawns Gradle without `.`, and OneDrive locks Gradle's cache | From `MobileApp/android`: `.gradlew.bat --stop`, delete `android/.gradle`, then `.gradlew.bat app:installDebug --project-cache-dir C:/gradlecache/mobileapp -PreactNativeDevServerPort=8081`. Moving the repo out of OneDrive is the permanent fix |

### 11.1 Reading the Metro logs

- `Risky capture — no mission overlay` + `cooldown_active` → detection worked; a pending risky mission already exists. The API should still return `newMission` with `reSurfaced: true` so the overlay reappears (look for `New mission from screen event`).
- `Risky capture — no mission overlay` + `pending_limit_reached` → 3 or more unfinished `pending` missions (`pending_approval` does not count). An existing pending mission should be re-surfaced; otherwise complete or expire old ones.
- `New mission from screen event` → a mission was created or the overlay path was taken.
- `Mission presentation skipped — post-mission grace` → a mission just ended; the resume frame may not stack another overlay for 10 s (the risk event is still stored).
- `Foreground lookup wedged — skipping await` → UsageStats hung while JS timers were frozen; the frame continues with `unknown` attribution and OCR still runs.
- Repeated `OCR lock takeover` with no OCR/risk lines after `Frame received` → the pipeline was stuck on a wedged lookup; toggle monitoring off/on.
- `Processing lock force-released after hung frame` with `cause: 'tick-liveness'` (`elapsed ≈ 60000`) or `cause: 'tick-phase-timeout:<phase>'` → a frame wedged and the native-tick backstop recovered it. `elapsed` far above 60 s (e.g. ~195000) means the screen was off and JS was frozen until it woke.
- `frame.phase {from, to, appState, prevPhaseMs}` → per-phase timing for each capture.
- `browser.block domain=… list=STATIC|DETECTED enforcement=…` (native tag) → a listed domain was blocked; `browser.add … reason=…` / `browser.leave …` → a screenshot-based add or Back-only leave.

More detail in [README.md](../README.md) and [architecture.md](architecture.md) (§8.5 timers, §10.1 wedged-frame recovery).

---

## 12. Release Procedure

1. Ensure all tests pass: mobile Jest `517/37 suites`, backend Jest `247/24 suites`, JVM `155` (11 test classes), and `tsc --noEmit` shows only the 2 known errors (see [testing_strategy.md](testing_strategy.md) §10).
2. Update `README.md` and `docs/` as needed.
3. Build backend (`npm run build`) and Android release artifact.
4. Apply DB migrations to the target database.
5. Deploy backend (`node dist/index.js`) behind HTTPS; ensure `demo_dashboard.html` is present at the repo root (served at `/demo.html`).
6. Smoke-test `GET /api/health` and one end-to-end capture → mission → approval.
7. Tag the release (e.g. `git tag v1.0-final`).

> Per project policy, commits/pushes/tags are performed **only when explicitly requested**.

---

*End of deployment guide — SafeGuard, current `main` (post-Phase B, September 2026).*
