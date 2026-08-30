# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI parental-control platform (ESPRIT PFE / internship project). Two independent apps in one repo:

- **`backend/`** — Node.js + Express + PostgreSQL API (TypeScript, ESM). Stores usage/screen metadata, computes daily scores, generates gamified missions.
- **`MobileApp/`** — React Native 0.74 Android app (TypeScript) with custom Java/Kotlin native modules. Does all sensitive processing (OCR, NSFW, keyword filtering) **on-device**; only extracted text + risk metadata leave the phone.

The privacy model is central: **no screenshot ever reaches the backend.** The device captures a screen, runs ML Kit OCR + `nsfwjs`/TFLite + a multilingual keyword filter, deletes the image, and POSTs only text (≤500 chars) + risk flags to `POST /api/screen-events`. Preserve this invariant when touching the capture pipeline.

## Commands

The two apps have separate toolchains — always `cd` into the right one. The shell is PowerShell on Windows.

### backend/
```powershell
npm run dev            # tsx watch src/index.ts (hot reload)
npm run build          # tsc -> dist/
npm start              # node dist/index.js
npm run db:up          # docker compose up -d (Postgres on :5432)
npm run db:migrate     # tsx src/db/migrate.ts (runs src/db/migrations/*.sql in order)
npm run db:setup       # db:up + db:migrate
npm test               # jest (ts-jest, tests live in backend/tests/**.test.ts)
npm run test:watch
npx jest tests/scoringEngine.test.ts   # run one test file
```
See `backend/DATABASE.md` for the Postgres setup — note port 5432 conflicts with a local PostgreSQL 18 service on this machine; either point `DATABASE_URL` at it or stop the Windows service before `db:up`.

### MobileApp/
```powershell
npm start              # react-native start (Metro)
npm run android        # react-native run-android
npm run lint           # eslint .
npm test               # jest (preset: react-native, tests in MobileApp/__tests__/)
npx jest __tests__/keywordFilter.test.ts   # run one test file
npm run download-nsfw-model   # fetch the on-device NSFW TFLite model (needed before NSFW works)
```
Native Android changes (Java/Kotlin under `android/app/src/main/java/com/mobileapp/`) require a full `run-android` rebuild — Metro fast-refresh does not pick them up.

## Configuration you'll hit immediately

- **Backend env** (`backend/src/config/env.ts`): `DATABASE_URL` and `JWT_SECRET` are **required** (app throws on boot if missing). Others optional: `PORT` (3000), `NODE_ENV`, `JWT_ISSUER`.
- **Mobile → backend URL** (`MobileApp/src/config/apiConfig.ts`): hardcoded `DEV_LAN_HOST` = your PC's Wi-Fi IPv4. Update it when your IP changes or a physical device can't reach the API. Android emulator auto-uses `10.0.2.2`. `__DEV__` builds hit `http://<host>:3000`.
- **Auth in dev**: the app mints a child JWT via `/api/dev/*` routes (see `useDevChildToken`). Those `/dev` and `/debug` routes are registered **only when `NODE_ENV !== production`** (`routes/index.ts`).

## Backend architecture

Entry: `src/index.ts` → `createApp()` (`src/app.ts`) → `src/routes/index.ts`.

- **Auth boundary**: `routes/index.ts` mounts `/health` and (non-prod) `/dev`, `/debug` publicly, then applies `verifyToken` middleware — **every route below that line requires `Authorization: Bearer <JWT>`**. JWT payload = `{ sub, role: 'parent'|'child', childId? }`.
- **Routes** (`src/routes/*.routes.ts`): `screen-events`, `usage`, `scores`, `missions`, `rewards`, `badges`, `bonus`, `custom-missions`, `child`.
- **Scoring** (`src/scoring/`): pure functions. `scoringEngine.ts` computes an **addiction risk score** (higher = worse; weighted intensity/compulsivity/night-usage/escalation/real-imbalance) and a **well-being score** (higher = better). `aggregateUsage.ts` turns raw `usage_sessions` rows into the daily stats those functions consume; `wellbeingProxies.ts` fetches DB-backed inputs (physical activity, bedtime variance, family interaction). Keep scoring functions pure and covered by `tests/scoringEngine.test.ts` / `wellbeingProxies.test.ts`.
- **Cron** (`src/jobs/dailyScoreJob.ts`): scheduled on server start (`node-cron`). Per child per day, aggregates sessions → computes both scores → writes `daily_scores` → may generate a mission from high addiction / low well-being.
- **Missions** (`src/services/`): `missionGenerator` (rule-based generation), `missionCompletion`, `gamificationService` (points/badges), `quizService`, `customMissionService`. Mission "risk cooldown" is now "a pending risky mission exists" — see `hasRecentRiskyMission`, not the legacy env var.
- **DB**: plain SQL migrations in `src/db/migrations/NNN_*.sql`, applied in filename order by `db/migrate.ts`. `db/pool.ts` exports the `pg` pool + `query`. No ORM. Add schema changes as a new numbered migration; never edit an applied one.

## Mobile architecture

Entry: `App.tsx` → dev JWT bootstrap (`useDevChildToken`) → `NavigationContainer` → `AppNavigator` (`src/navigation/`). `RealUsageTracker` runs alongside the UI to report usage.

- **Native modules** (`src/native/*.ts` bridge to `android/.../com/mobileapp/`): `ScreenCapture` (MediaProjection foreground service), `ForegroundApp` (UsageStats — which app is in front), `NsfwTflite` (on-device NSFW), `OverlayMission` (draws a mission overlay over other apps), `overlayPermission`.
- **On-device analysis pipeline** (`src/services/`): OCR via `mixedScriptOcr.ts` / `mobileArabicOcr.ts` (ML Kit + UI-noise filter + Arabizi/Derja normalization), `nsfwClassifier.ts` + `imageClassifier.ts` (image risk), `keywordFilter.ts` (EN/FR/AR/Tunisian-Derja multilingual). Results combine into a `combinedRiskScore` that drives capture cadence and mission triggering.
- **Adaptive capture** (documented in `README.md`): capture frequency is risk-based, not fixed — app-switch triggers + a follow-up + a periodic interval that shortens as the rolling average risk rises. Invariant: **higher risk must scan at least as often as lower risk** (HIGH ≤ MEDIUM ≤ LOW interval).
- **API layer** (`src/services/apiClient.ts` + `*Api.ts`): all backend calls go through `apiClient`, which attaches the JWT from `tokenStorage`.

Tests (`MobileApp/__tests__/`) heavily cover the risk logic (keyword filter, OCR normalization, adaptive capture, risk combination/mapping) as pure TS — no device needed.

## Working across both apps

- API contract changes touch **both** sides: a backend route/shape change needs the matching `MobileApp/src/services/*Api.ts` update. There is no shared/generated type package — types are duplicated by hand.
- The mobile app assumes the backend is reachable at the configured LAN IP on port 3000. "JWT error / start backend" on the app's loading screen means the backend isn't up or the IP is wrong.

## Docs worth reading before large changes

`docs/` holds the formal project docs: `architecture.md`, `SRS.md`, `scoring_formulas.md` (the exact score weights/formulas), `testing_strategy.md`, `deployment.md`. `backend/DATABASE.md` and `MobileApp/PROJECT_SETUP.md` cover environment setup. The root `README.md` is the fullest architecture reference (with mermaid diagrams and the adaptive-capture tables).
