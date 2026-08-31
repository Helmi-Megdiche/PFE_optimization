# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI parental-control platform (ESPRIT PFE / internship project). Two independent apps in one repo:

- **`backend/`** — Node.js + Express + PostgreSQL API (TypeScript, ESM). Stores usage/screen metadata, computes daily scores, generates gamified missions.
- **`MobileApp/`** — React Native 0.74 Android app (TypeScript) with custom Java/Kotlin native modules. Does all sensitive processing (OCR, NSFW, keyword filtering) **on-device**; only extracted text + risk metadata leave the phone.

The privacy model is central: **no screenshot ever reaches the backend.** The device captures a screen, runs ML Kit OCR + `nsfwjs`/TFLite + a multilingual keyword filter, deletes the image, and POSTs only text (≤500 chars) + risk flags to `POST /api/screen-events`. Preserve this invariant when touching the capture pipeline.

## Working rule

**After finishing any task, update this CLAUDE.md file.** Fold in whatever changed that a future session would need — new/renamed commands, added routes or modules, architectural shifts, new conventions, or gotchas discovered. Keep it accurate and concise; remove anything the change made stale. Skip only trivial edits that alter nothing documented here.

This is enforced by a **Stop hook** in `.claude/settings.json`: if you changed source (`MobileApp/`, `backend/`, `scripts/`, `docs/`, or `demo_dashboard.html`) without touching CLAUDE.md, it blocks the turn from ending until you update CLAUDE.md (or state in one line that nothing needs documenting).

## Commands

The two apps have separate toolchains — always `cd` into the right one. The shell is PowerShell on Windows.

### backend/
```powershell
npm run dev            # tsx watch src/index.ts (hot reload)
npm run build          # tsc -> dist/
npm start              # node dist/index.js
npm run db:up          # docker compose up -d (Postgres on host :5433 → container 5432)
npm run db:migrate     # tsx src/db/migrate.ts (runs src/db/migrations/*.sql in order)
npm run db:setup       # db:up + db:migrate
npm test               # jest (ts-jest, tests live in backend/tests/**.test.ts)
npm run test:watch
npx jest tests/scoringEngine.test.ts   # run one test file
```
`docker-compose.yml` maps host port **5433**→5432 specifically to avoid the local PostgreSQL 18 service on 5432; `.env.example` already points `DATABASE_URL` at 5433, so `npm run db:setup` works without stopping that service. `db/migrate.ts` re-runs **every** migration each time and relies on `IF NOT EXISTS` — a few (e.g. `011_quiz_questions.sql`) are **not** idempotent, so migrating against a DB that already has the schema errors. On a stale Docker volume, reset with `cd backend && docker compose down -v && docker compose up -d` then `npm run db:migrate`. See `backend/DATABASE.md` for more.

### MobileApp/
```powershell
npm start              # react-native start (Metro)
npm run android        # react-native run-android
npm run lint           # eslint .
npm test               # jest (preset: react-native, tests in MobileApp/__tests__/)
npx jest __tests__/keywordFilter.test.ts   # run one test file
npm run download-nsfw-model   # fetch the on-device NSFW TFLite model (needed before NSFW works)
```
Native Android changes (Java/Kotlin under `android/app/src/main/java/com/mobileapp/`) require a full `run-android` rebuild — Metro fast-refresh does not pick them up. **JS-only** changes need no rebuild: `adb shell am force-stop com.mobileapp` then relaunch re-pulls the bundle from Metro.

**Building on this Windows + OneDrive machine — two blockers** (`react-native run-android` fails here):
1. `'gradlew.bat' is not recognized` — the RN CLI spawns it without a `.\` prefix. Build directly from `MobileApp/android` in PowerShell: `.\gradlew.bat app:installDebug -PreactNativeDevServerPort=8081`.
2. `Could not move temporary workspace … to immutable location` — Gradle × OneDrive file-lock (project lives under `C:\Users\…\OneDrive\`). Redirect the project cache off OneDrive: append `--project-cache-dir C:\gradlecache\mobileapp`. First clear the corrupt cache (`.\gradlew.bat --stop`, delete `android/.gradle`).

Full working install: `.\gradlew.bat app:installDebug --project-cache-dir C:\gradlecache\mobileapp -PreactNativeDevServerPort=8081`, then launch via `adb`. `adb reverse tcp:3000 tcp:3000` + `tcp:8081 tcp:8081` tunnels a USB device to the backend + Metro. Permanent fix: move the repo out of OneDrive.

## Configuration you'll hit immediately

- **Backend env** (`backend/src/config/env.ts`): `DATABASE_URL` and `JWT_SECRET` are **required** (app throws on boot if missing). Others optional: `PORT` (3000), `NODE_ENV`, `JWT_ISSUER`.
- **Mobile → backend URL** (`MobileApp/src/config/apiConfig.ts`): `DEV_LAN_HOST` is currently `127.0.0.1` for a **USB device via `adb reverse`** (see build note above). For a phone on the same Wi-Fi instead, set it to your PC's Wi-Fi IPv4. Android emulator auto-uses `10.0.2.2`. `__DEV__` builds hit `http://<host>:3000`.
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

- **Native modules** (`src/native/*.ts` bridge to `android/.../com/mobileapp/`): `ScreenCapture` (MediaProjection foreground service), `ForegroundApp` (UsageStats — which app is in front), `NsfwTflite` (on-device NSFW), `OverlayMission` (draws a mission overlay over other apps), `overlayPermission`, `SafeGuardAccessibility` (AccessibilityService window/IME/scroll events — see below).
- **On-device analysis pipeline** (`src/services/`): OCR via `mixedScriptOcr.ts` / `mobileArabicOcr.ts` (ML Kit + UI-noise filter + Arabizi/Derja normalization), `nsfwClassifier.ts` + `imageClassifier.ts` (image risk), `keywordFilter.ts` (EN/FR/AR/Tunisian-Derja multilingual). Results combine into a `combinedRiskScore` that drives capture cadence and mission triggering.
- **Adaptive capture** (documented in `README.md`): capture frequency is risk-based, not fixed — app-switch triggers + a follow-up + a periodic interval that shortens as the rolling average risk rises. App-switch triggers are **accessibility-window-driven** when the SafeGuard accessibility service is connected (near-instant), falling back to the 1s UsageStats poll otherwise (see the accessibility bullet below). Invariant: **higher risk must scan at least as often as lower risk** (HIGH ≤ MEDIUM ≤ LOW interval).
- **Capture coordinator** (`src/capture/captureCoordinator.ts`): every capture trigger in `useScreenshotCapture.ts` (`tryCaptureNow`, `triggerAppSwitchCapture`, follow-up, periodic tick, deferred re-issue) **must call `coordinatorRef.current.requestCapture(reason: CaptureReason)` before invoking native `captureNow`**, and route coalesced retries via `takePendingReason()`. The coordinator is a pure factory (`createCaptureCoordinator(deps)`, no React/native imports, injected clock) owning: request debounce (`CAPTURE_DEBOUNCE_MS` 5s, `FOLLOW_UP_MIN_GAP_MS` 2s for `APP_SWITCH_FOLLOW_UP` — both now live only here), mission-pause gating **for requests**, keyboard-suppression gating **for requests** (`setKeyboardVisible(bool)`; while true, `requestCapture` drops **only** the four `isKeyboardSuppressibleReason` reasons — `PERIODIC_ADAPTIVE`, `PERIODIC_FALLBACK`, `CONTENT_CHANGE`, `SCROLL_SETTLED` — returning `CaptureSkipReason.KEYBOARD_SUPPRESSED`; every app-switch reason, `BROWSER_NAVIGATION`, `RISK_FOLLOW_UP` and `APP_SWITCH_FOLLOW_UP` still pass so safety monitoring never stops while typing), and priority-based coalescing of one pending reason while OCR is busy (`requestCapture` decision order: `NOT_MONITORING` → `MISSION_PAUSED` → `KEYBOARD_SUPPRESSED` → `BUSY_DEFERRED`/`SUPERSEDED` → `DEBOUNCED` → allowed). `isKeyboardSuppressibleReason` is the **only** place that four-reason list is written (unit-tested over all 12 members); `reset()` also clears `keyboardVisible`. `CaptureReason` has 12 members; 6 (`MISSION_RESUME`, `PERIODIC_FALLBACK`, `RISK_FOLLOW_UP`, `CONTENT_CHANGE`, `SCROLL_SETTLED`, `BROWSER_NAVIGATION`) are declared for later wiring. **Inbound-frame guards stay in `processCapturedFrame`** — the OCR lock (`isProcessingRef`), generation token / `isActive()`, `OCR_LOCK_TAKEOVER_MS`, both watchdogs, and the inbound `isMissionCapturePaused()` check are NOT the coordinator's job (the native 20s loop pushes frames with no JS request). Pure logic covered by `__tests__/captureCoordinator.test.ts`.
- **Native frame-skip gate** (`android/.../screencapture/FrameHasher.java` + `ScreenCaptureModule.captureSingleFrame`): before any JPEG write / bridge crossing / OCR, the module computes a 64-bit perceptual difference hash (dHash) directly from the acquired `Image`'s plane-0 `ByteBuffer` (absolute reads only — no Bitmap, no buffer copy; uses `image.getWidth()/getHeight()`, not the module's `screenWidth/Height` fields) and compares it to the last **processed** frame. A frame is **processed** iff: `forceNextCapture` flag was set (one-shot, consumed via `getAndSet(false)`) **OR** no prior hash **OR** `now - lastProcessedAtMs >= HASH_STALENESS_MS` (90s) **OR** `hammingDistance > HASH_CHANGE_THRESHOLD` (3). Otherwise the frame is dropped: no JPEG, no `onScreenCaptured`, `lastCaptureEmittedAtMs` untouched — only a `frame.skipped.unchanged hamming=<n>` debug log (an `onScreenCaptureLog` bridge event, string only). The hash lives in native memory **only** — never filed, never in the screen-event payload, never sent to the backend. Hash state is reset in `releaseProjectionSession()` so every new monitoring session processes its first frame. `@ReactMethod forceNextCapture()` (bridged in `native/ScreenCapture.ts`) sets the one-shot bypass flag; `useScreenshotCapture.tryCaptureNow` calls it fire-and-forget **before** `captureNow()` whenever `isForceCaptureReason(decision.reason)` is true. **Tier-0 (force-capture) reasons** — `APP_SWITCH`, `APP_SWITCH_LAUNCHER_RETURN`, `APP_SWITCH_DEFERRED`, `BROWSER_NAVIGATION` — always bypass the hash check; `isForceCaptureReason` in `captureCoordinator.ts` is the single source of that list (explicit literal, not derived from `CAPTURE_REASON_PRIORITY`), unit-tested for all 12 `CaptureReason` members. Known gap: if native `captureNow` rejects on its own `MIN_CAPTURE_INTERVAL_MS` debounce, no frame consumes the flag, so it persists until the next (likely periodic) frame, which then bypasses the gate — accepted until the JS/native debounce split is unified.
- **Accessibility event source** (`android/.../com/mobileapp/accessibility/` + `src/native/SafeGuardAccessibility.ts` + `src/hooks/useAccessibilityEvents.ts`): `SafeGuardAccessibilityService` (an `AccessibilityService`, `AccessibilityServiceInfo`: `eventTypes = TYPE_WINDOW_STATE_CHANGED | TYPE_WINDOWS_CHANGED | TYPE_VIEW_SCROLLED`, `feedbackType = FEEDBACK_GENERIC`, `flags = FLAG_RETRIEVE_INTERACTIVE_WINDOWS | FLAG_REPORT_VIEW_IDS`, `notificationTimeout = 100`, no `packageNames`) emits three RN `DeviceEventEmitter` events: `onAccessibilityWindowChanged {packageName, timestamp}` (on foreground package change), `onAccessibilityKeyboardChanged {visible, timestamp}` (IME window appears/disappears — checked via a single `getWindows()` scan for `TYPE_INPUT_METHOD`, run **only** on window events, never on scroll, with a 300 ms min-interval backstop), `onAccessibilityScroll {packageName, timestamp}` (throttled to ≤1/500 ms). `timestamp` is wall-clock ms; all throttling uses `SystemClock.uptimeMillis()`. `AccessibilityEventBridge` mirrors `OverlayEventBridge` — buffers events (bounded `ArrayDeque`, max 20, drop-oldest) when the JS context is dead and flushes on module `attach` / `flushPendingEvents(...)`. `SafeGuardAccessibilityModule` (`SafeGuardAccessibility`) exposes `isEnabled()` (service instance non-null AND listed in `ENABLED_ACCESSIBILITY_SERVICES`), `openAccessibilitySettings()`, `flushPendingEvents()`; registered via `AccessibilityPackage` in `MainApplication.kt`. **Manual enable required** — the user must turn on "SafeGuard" in system Settings → Accessibility. `useAccessibilityEvents(opts)` now returns `{ connected }` (via `isEnabled()`, refreshed on mount + every `AppState → active`) and is mounted **inside `useScreenshotCapture`** (removed from `ScreenMonitor.tsx` to avoid a double subscription; `ScreenMonitor` keeps only its own `isAccessibilityServiceEnabled` check for the settings card). **Window events drive app-switch captures when the a11y path is *driving*** — `connected` AND a window event seen within `A11Y_STALE_MS` (60s). While driving, the 1s UsageStats poll's own `triggerAppSwitchCapture` calls are suppressed (the poll keeps running for its foreground-cache writes, which OCR attribution depends on; the a11y handler mirrors those same `lastAppPackageRef` writes before it triggers). If the service is off, or connected but silent for 60s (crashed/unbound), the poll is the **unchanged fallback**. **`src/capture/windowEventFilter.ts`** (pure, injected clock, no RN imports) filters the raw window feed: `createWindowEventFilter().accept(pkg)` rejects `OWN_PACKAGE` → `IME` → `SAME_PACKAGE` → `LAUNCHER_SETTLING` (in that order; `LAUNCHER_SETTLE_MS` 1500, treats `com.google.android.googlequicksearchbox` as a launcher surface alongside `isLauncherPackage`), else accepts and records; `isImePackage` is a heuristic (substrings `inputmethod`/`latin`/`swiftkey`/`gboard`/`.ime` + exact `com.google.android.inputmethod.latin`) — the authoritative IME signal is the keyboard event. The filter is `reset()` on monitoring start **and** stop (next to `coordinatorRef.reset()`); on start `lastA11yWindowEventAtMs` is seeded to now. Keyboard events call `coordinator.setKeyboardVisible(e.visible)`; the latch is force-cleared on a11y disconnect and on `stopMonitoring` so a dead service with the keyboard open can't suppress routine captures forever (no capture is fired on keyboard-close — that's left for the scroll-settle task). `onAccessibilityScroll` stays **log-only** — `SCROLL_SETTLED` is still unemitted. **Privacy**: no `getRootInActiveWindow()`, no `AccessibilityNodeInfo` content, no node text, no URLs, no field values — package names and booleans only (URL reading is a later task with its own privacy review). The unused `FOREGROUND_SERVICE_SPECIAL_USE` permission was removed from the manifest.
- **API layer** (`src/services/apiClient.ts` + `*Api.ts`): all backend calls go through `apiClient`, which attaches the JWT from `tokenStorage`.
- **Design system** ("Calm Guardian" — warm sand + deep teal, coral for alerts). Tokens live in `src/theme/index.ts` (`colors`, `spacing`, `radius`, `type`, `shadow`, plus a dark `focus` palette for the immersive mission/game screens). Shared primitives are in `src/components/ui/index.tsx` (`Screen`, `Card`, `Button`, `Pill`, `SectionLabel`, `Meter`, `StatTile`, `PulseDot`, `EmptyState`). **Never hardcode hex in screens — import from the theme.** The parent dashboard (`demo_dashboard.html`) carries the same identity via a `tailwind.config` palette remap in its `<head>`; edit it then `cd backend && npm run sync:demo` to publish to `backend/public/demo.html`.

Tests (`MobileApp/__tests__/`) heavily cover the risk logic (keyword filter, OCR normalization, adaptive capture, risk combination/mapping) as pure TS — no device needed.

## Working across both apps

- API contract changes touch **both** sides: a backend route/shape change needs the matching `MobileApp/src/services/*Api.ts` update. There is no shared/generated type package — types are duplicated by hand.
- The mobile app assumes the backend is reachable at the configured LAN IP on port 3000. "JWT error / start backend" on the app's loading screen means the backend isn't up or the IP is wrong.

## Docs worth reading before large changes

`docs/` holds the formal project docs: `architecture.md`, `SRS.md`, `scoring_formulas.md` (the exact score weights/formulas), `testing_strategy.md`, `deployment.md`. `backend/DATABASE.md` and `MobileApp/PROJECT_SETUP.md` cover environment setup. The root `README.md` is the fullest architecture reference (with mermaid diagrams and the adaptive-capture tables).
