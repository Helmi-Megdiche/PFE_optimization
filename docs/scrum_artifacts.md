# Scrum Artefacts — SafeGuard AI Parental Control Platform

**Author:** Helmi Megdiche — ESPRIT (5th-year PFE)
**Repository:** [github.com/Helmi-Megdiche/PFE_optimization](https://github.com/Helmi-Megdiche/PFE_optimization)
**Document version:** Current `main` (post-Phase B, September 2026). v1.0-final (5 June 2026, `59da85b`) was the pre-Phase-B release.
**Method:** solo-Scrum (single developer + academic/host supervisors as Product Owner proxies).

> This document records the agile process actually followed during the internship. Sprint boundaries, deliverables, and dates are cross-referenced with the Git commit history and the sprint table in [README.md](../README.md). It is written for the PFE jury as evidence of a disciplined, iterative delivery.

---

## Table of Contents

1. [Scrum Setup and Roles](#1-scrum-setup-and-roles)
2. [Product Vision and Goals](#2-product-vision-and-goals)
3. [Product Backlog (Epics)](#3-product-backlog-epics)
4. [Release Plan and Sprint Map](#4-release-plan-and-sprint-map)
5. [Sprint Details, Reviews, and Retrospectives](#5-sprint-details-reviews-and-retrospectives)
6. [Definition of Done](#6-definition-of-done)
7. [Metrics and Velocity](#7-metrics-and-velocity)
8. [Risk and Impediment Log](#8-risk-and-impediment-log)
9. [Overall Retrospective](#9-overall-retrospective)

---

## 1. Scrum Setup and Roles

| Role | Held by | Responsibility |
|------|---------|----------------|
| Product Owner (proxy) | Academic + host supervisors | Prioritise backlog from the two *cahiers des charges*, validate demos |
| Scrum Master (self) | Helmi Megdiche | Facilitate the process, remove impediments |
| Development Team | Helmi Megdiche | Design, implement, test, document |

- **Sprint length:** ~2 weeks for major sprints, with shorter interstitial "point" sprints (3.5, 4.5, 5.5, …) for focused hardening.
- **Ceremonies:** planning at sprint start, demo/review at sprint end (to supervisors), retrospective captured as notes, daily self-standup.
- **Artefacts:** product backlog (epics below), sprint backlogs (per-sprint scope), increment (working software each sprint), and this document.
- **Source of truth for "done":** the Git history — each sprint corresponds to one or more `feat(...)`/`fix(...)` commits.

---

## 2. Product Vision and Goals

> *For parents of children who face smartphone addiction and exposure to harmful content, SafeGuard is an intelligent parental-control layer that understands on-device screen activity, scores behavioural risk and wellbeing, and responds with gamified educational missions — without sending screenshots to the cloud.*

**Success criteria (PFE):**

1. A demonstrable end-to-end pipeline: capture → on-device AI → risk → mission → parent approval.
2. Privacy-preserving by construction (metadata-only API).
3. Multilingual detection (EN/FR/AR/Derja).
4. A tested, documented, reproducible milestone (`v1.0-final`).

---

## 3. Product Backlog (Epics)

| Epic | Description | Priority | Status |
|------|-------------|----------|--------|
| E1 — Screen capture & OCR | On-device capture, multilingual OCR, keyword filter | Must | Done |
| E2 — Usage scoring | Addiction + wellbeing daily scores, cron | Must | Done |
| E3 — Vision & combined risk | TFLite NSFW + ML Kit labels, combined risk | Must | Done |
| E4 — Foreground accuracy | UsageStats attribution + OCR override (MIUI) | Must | Done |
| E5 — Missions & gamification | Generation, games, points, badges, rewards | Must | Done |
| E6 — Smart missions | Adaptive threshold, burst, category mapping, escalation | Should | Done |
| E7 — Parent dashboard | Monitoring + parent control web UI | Must | Done (web) |
| E8 — Wellbeing proxies & interests | Dynamic proxies, interest personalization | Should | Done |
| E9 — Hardening & docs | Stability fixes, tests, final documentation | Must | Done |
| E10 — Integration/native parent app | Host-app integration, native parent app | Could | Not done (future work) |
| E11 — Adult-site blocking (Chrome) | Block known and learned adult domains in Chrome; parent-side history | Must | Done |

---

## 4. Release Plan and Sprint Map

Two milestones: **`v1.0-final`** (feature-complete prototype, tag reference commit `59da85b`, 5 June 2026) and subsequent **pre-integration hardening** (through August 2026).

> **What shipped after:** two further increments landed in September 2026, after the official internship period — **Pre-defence hardening** and **Phase B — adult-site blocking** (see §5).

```mermaid
gantt
    dateFormat  YYYY-MM-DD
    title SafeGuard sprint timeline
    section Foundations
    Sprint 1 OCR+JWT          :2026-05-18, 2026-05-31
    Sprint 2 Usage scoring    :2026-05-17, 2026-06-14
    section Vision & OCR
    Sprint 3 Vision           :2026-05-17, 2026-05-20
    Sprint 3.5-3.14 OCR/FG    :2026-05-18, 2026-05-30
    section Gamification
    Sprint 4 Missions         :2026-05-30, 2026-07-12
    Sprint 4.5 Smart missions :2026-05-30, 2026-05-31
    Sprint 5 Gamification UI  :2026-06-01, 2026-06-05
    Sprint 5.5-5.9 Proxies    :2026-06-01, 2026-06-05
    section Hardening
    Sprint 6 Hardening+docs   :2026-06-11, 2026-08-10
    section September 2026
    Pre-defence hardening     :2026-09-01, 2026-09-20
    Phase B blocking          :2026-09-15, 2026-09-27
```

> Dates are approximate windows aligned with commit dates; interstitial sprints landed within the major windows.

---

## 5. Sprint Details, Reviews, and Retrospectives

Each sprint lists its **goal**, **key increment** (with representative commits), **review outcome**, and a short **retrospective** (Keep / Improve).

### Sprint 1 — Screen monitoring foundation (18–31 May 2026)

- **Goal:** on-device capture + OCR + JWT backend ingestion.
- **Increment:** MediaProjection capture, ML Kit OCR, keyword filter, `POST /api/screen-events`, JWT, `screen_events` table. Commits: `2373744` (sprint-1), `bb0c919` (README).
- **Review:** end-to-end capture → stored event demonstrated.
- **Retro:** *Keep* — on-device-first decision. *Improve* — background capture reliability (addressed in `e76399a`).

### Sprint 2 — Usage-based scoring + cron (1–14 June window; core `344fbcf`)

- **Goal:** behavioural scoring from real usage.
- **Increment:** `usage_sessions`, `daily_scores`, scoring engine (5+5 components), `node-cron` daily job, scores/trend APIs.
- **Review:** addiction/wellbeing scores computed and retrievable.
- **Retro:** *Keep* — pure, testable scoring functions. *Improve* — UTC vs local date boundaries (logged as limitation).

### Sprint 3 → 3.14 — Vision, OCR accuracy, foreground (17–30 May 2026)

- **Goal:** combined risk + multilingual OCR + accurate foreground attribution.
- **Increment (highlights):**
  - Vision + combined risk `OCR×0.3 + vision×0.7` (`e1aefcd`, `9201720`).
  - Yahoo Open NSFW TFLite on-device (`9d17a75`, `ef30544`).
  - Multilingual FR/AR/Derja + Arabizi normalization (`61ad486`, `69a0a55`).
  - On-device Arabic Tesseract with English-page skip and hallucination guard (`1e197c6`, `454e6b0`).
  - Foreground UsageStats window/retry/cache fixes (`cddf628`, `a38049e`).
- **Review:** demonstrated adult/violent detection across languages; MIUI attribution improved.
- **Retro:** *Keep* — sequential ML Kit→Tesseract to avoid concurrency. *Improve* — false positives on filtered SERP (addressed in Sprint 6 hardening).

### Sprint 3.7 — Adaptive capture (20 May 2026)

- **Goal:** replace fixed interval with risk-based scheduling.
- **Increment:** app-switch immediate capture, 5 s follow-up, 10/15/20 s tiers, debounce (`a468b76`, `c0115c2`).
- **Review:** faster reaction after risky browsing, lower idle cost.
- **Retro:** *Keep* — adaptive intervals. *Improve* — native-vs-JS timer interplay (documented; tuned later).

### Sprint 4 + 4.5 — Missions & gamification backend (30 May – 12 July window)

- **Goal:** generate missions and reward completion.
- **Increment:** mission generation, points, badges, rewards, cognitive validation (`4c630ce`, `0026532`); smart generation — adaptive threshold, cumulative burst, category mapping, escalation, cooldown (`22c316e`).
- **Review:** risky content and score triggers produce appropriate missions.
- **Retro:** *Keep* — decision tree + adaptive threshold. *Improve* — cooldown UX repetitiveness (revisited in hardening).

### Sprint 5 + 5.5 — Gamification UI, overlay, dashboard, custom content (1–5 June 2026)

- **Goal:** playable missions, enforcement overlay, and parent control surface.
- **Increment:** React Navigation UI, minigames/quiz, parent approval/reject/bonus, escape penalty, `SYSTEM_ALERT_WINDOW` overlay + notification fallback, dashboard at `/demo.html` (`020d627`, `8b4168f`); dynamic quiz bank + custom missions + native overlay launch (`4cb1052`, `55e3323`).
- **Review:** full loop demonstrated on device with overlay blocking.
- **Retro:** *Keep* — overlay-first enforcement. *Improve* — force-close escape gap (logged as limitation).

### Sprint 5.6 → 5.9 — Exposure penalty, dashboard, proxies, interests (5 June 2026)

- **Goal:** connect events to scores and personalise missions.
- **Increment:** exposure penalty + player levels (`f86d9fb`), comprehensive parent dashboard (`766f81d`), dynamic wellbeing proxies + interest tie-breaker (`790a5f6`), badge ranks + editable birth year (`96c7e99`), single age-badge enforcement + cleanup (`a41a7a2`).
- **Review:** wellbeing responds to approved missions; interests bias selection.
- **Retro:** *Keep* — proxy approach without new hardware. *Improve* — proxies are not ground truth (documented).

### Sprint 6 — Hardening, tests, documentation (11 June – 10 August 2026)

- **Goal:** production-blocking stability, honest limitations, and full documentation.
- **Increment:**
  - MIUI attribution, stall recovery, cooldown resurface (`59da85b`); pre-final report (`2b2eefd`).
  - Critical pre-integration fixes: 409 handling, watchdog heartbeat, cache staleness, resurface dismissal (`8c63329`, `48aec96`, `668314d`, `74223a5`, `5a58587`).
  - JWT expiry auto-refresh, keep `Q`-keyword SERP hits, unblock hung OCR (`02ddd5b`).
  - Capture-timer tuning, foreground self-heal, post-mission grace, mission-helper fixes (`f40aab5`).
- **Review:** healthy Metro/backend logs verified; **310** automated tests passing.
- **Retro:** *Keep* — log-driven debugging on real devices. *Improve* — automated device E2E (future work).

### Pre-defence hardening (September 2026)

- **Goal:** make the capture → mission loop dependable for a live defence and close the gaps between documentation and behaviour.
- **What shipped:**
  - Capture pipeline: a single native 5 s tick with JS subsampling, a capture coordinator (debounce, priority coalescing, keyboard suppression), a native perceptual-hash frame-skip gate, accessibility-driven app-switch and scroll-settle captures, MediaProjection revoke and stale-token recovery, and layered recovery of a wedged frame (60 s tick backstop, per-phase deadlines, generation guard).
  - An Accessibility-service health card on the Monitor tab (Active / Enabled / Not responding / off).
  - A mission capture lease (heartbeat, overlay-still-showing check, 1 h ceiling) so capture pauses exactly while a mission is shown.
  - Overlay games: Quiz and Tic-Tac-Toe played inside the overlay, with per-answer feedback, full-screen layout in the app's design system, and a server-side replay of every Tic-Tac-Toe board.
  - Mission completion that never traps the child on a failed request (retry / close).
  - Time-zone-aware scoring and cron (`APP_TIMEZONE`), per-route parent→child ownership checks, and a migration ledger (`schema_migrations`).
- **Test counts at close:** not recorded as a single figure; see Phase B for the counts at the latest close.
- **Review:** each capability demonstrated on a physical device (Xiaomi/HyperOS).
- **Retro:** *Keep* — device verification alongside unit tests. *Improve* — a hook-level test harness for `useScreenshotCapture`.

### Phase B — adult-site blocking (15–27 September 2026)

- **Goal:** block adult websites in Chrome, learn new ones from what the vision model sees, and show the parent what was blocked.
- **What shipped:** an Accessibility-service address-bar watcher that keeps only the host and matches it against a bundled list (76,774 domains) and a learned on-device list; Back + a full-screen block screen whose OK opens a fresh Chrome tab; learning a domain when a Chrome screenshot scores raw NSFW ≥ 0.7; Back only (no list write) for text-only adult results; `blocked_domains` and `browser_block_incidents` tables (migration `016`); an offline queue, backfill and reconciliation between device and backend; read-only dashboard panels; a development-only unblock endpoint.
- **Test counts at close (merge `34d59b7`):** 517 mobile Jest (37 suites), 247 backend Jest (24 suites), 155 JVM (11 test classes).
- **Review:** known-domain block in about 130 ms; repeat visit to a learned domain blocked in 117–160 ms; unblock → sync → revisit shown not blocked (device-observed).
- **Retro:** *Keep* — a pure-Java core that can be unit-tested off the device. *Improve* — thumbnail-grid pages score low on whole-screen vision; tiled inference is future work.

### Sprint table (moved from README)

| Sprint | Dates | Status | Summary |
|--------|-------|--------|---------|
| **1** | 18 – 31 May 2026 | Complete | **OCR + JWT backend** — MediaProjection capture, on-device ML Kit OCR, keyword filter, `POST /api/screen-events`, JWT auth, `screen_events` storage |
| **2** | 1 – 14 June 2026 | Complete | **Usage-based scoring + cron** — real foreground app sessions (`POST /api/usage`, JS poll 5 s while monitoring), addiction & well-being scoring engine, `node-cron` daily aggregation, score & trend APIs |
| **3** | 15 – 28 June 2026 | Complete | **Vision model + combined risk** — ML Kit image labeling + nsfwjs-style proxy on device, `combinedRiskScore = OCR×0.3 + vision×0.7`, extended `screen_events` fields |
| **3.5** | — | Complete | **Debug & foreground** — `POST /api/debug/classify` (backend nsfwjs + Tesseract OCR), `demo_dashboard.html`, `ForegroundAppModule` (UsageStats), shared `riskMapping.ts` (mobile + backend), `app_label` migration |
| **3.6** | — | Complete | **Accuracy improvements** — expanded ML Kit mapping (weapons, drugs, gore, adult, hentai proxy), `enforceCategoryConsistency`, explicit OCR boosts & overrides, `nsfwClassifier` proxy (no tfjs on device) |
| **3.7** | — | Complete | **Adaptive capture** — immediate capture on app switch, follow-up after 5 s, risk-based dynamic intervals (10 / 15 / 20 s from the rolling average of the last 3 scores), 5 s debounce |
| **3.8** | — | Explored, not shipped | **NSFW model training** — an EfficientNetV2B0 fine-tune on the NSFW Data Scraper dataset (5 classes) was planned and a quantized `.tflite` exported. What ships is Yahoo Open NSFW (Sprint 3.9) |
| **3.9** | — | Complete | **On-device NSFW TFLite** — Yahoo Open NSFW `nsfw.tflite` via native `NsfwTflite` module (RN 0.74–compatible), replaces the ML Kit heuristic proxy for the adult score |
| **3.10** | — | Complete | **Multilingual OCR (FR / AR / Derja)** — French + Arabic + Tunisian Derja Arabizi keyword lists, `normalizeArabizi.ts`, `mixedScriptOcr.ts` (ML Kit primary + Tesseract `ara+fra+eng` fallback), normalized-text channel in `keywordFilter` |
| **3.11** | — | Complete | **Foreground app accuracy** — UsageEvents window 15 s → 120 s, UsageStats recency filter (5 s), capture-time 3× retry (200 ms), cache TTL, skip System UI / launcher |
| **3.12** | — | Complete | **OCR noise reduction** — `cleanOcrText` strips UI timestamps/counts/phrases; stricter Arabizi gating; documented ML Kit Arabic limitation |
| **3.13** | — | Complete | **Debug Arabic OCR** — `POST /api/debug/arabic-ocr` (server Tesseract `ara`); backend keyword lists synced with mobile |
| **3.14** | — | Complete | **On-device Arabic OCR (Android)** — `@devinikhiya/react-native-tesseractocr` with lazy initialization, sequential ML Kit → Tesseract fallback, `ara.traineddata` assets |
| **4** | 29 June – 12 July 2026 | Complete | **Missions & gamification (backend)** — mission generation from risk/scores, points, badges, parent rewards, cognitive remediation validation |
| **4.5** | — | Complete | **Smart mission generation** — adaptive risk threshold, cumulative burst detection, category-specific templates, escalation points, cooldown |
| **5** | — | Complete | **Gamification frontend** — React Navigation UI, parent approval / reject / bonus, escape penalty, `SYSTEM_ALERT_WINDOW` mission overlay + notification fallback, dashboard at `/demo.html` |
| **5.5** | — | Complete | **Dynamic quiz bank & custom missions** — `quiz_questions` table, parent custom real-world missions, OCR false-positive filters, risky web-search boost |
| **5.6** | — | Complete | **Exposure penalty + player levels** — weekly risky-event count adds up to +20 to the daily addiction score; `GET /api/scores/:childId` returns `level` |
| **5.7** | — | Complete | **Parent dashboard enhancement** — Monitoring vs Parent tabs; child profile, scores/level/points, badges, mission history, claimed rewards, toasts |
| **5.8** | — | Complete | **Dynamic wellbeing proxies + interests** — physical activity / bedtime / family interaction from missions & usage; age-based screen cap; `children.interests`; interest tie-breaker |
| **6** | 13 – 31 July 2026 | Complete | Hardening, tests, final demo & report |
| **6.1** | — | Complete | **Capture-pipeline hardening** — single native 5 s tick + JS subsample, capture coordinator, perceptual-hash frame-skip gate, accessibility-driven capture, MediaProjection recovery, layered wedged-frame recovery (330 mobile unit tests at the time) |
| **Pre-defence hardening** | September 2026 | Complete | See above |
| **Phase B** | 15 – 27 Sept 2026 | Complete | Adult-site blocking in Chrome — see above |

---

## 6. Definition of Done

A backlog item is **Done** when:

1. Code implemented and integrated on `main`.
2. Pure logic covered by unit tests; suite green (`npm test`).
3. Behaviour demonstrated on a real device or via smoke script.
4. Relevant docs updated (README and/or `docs/`).
5. No known regression in the capture → mission → approval loop.
6. Limitations, if any, recorded honestly (today in [README.md — Known limitations / future work](../README.md#known-limitations--future-work)).

---

## 7. Metrics and Velocity

| Dimension | Value (current `main`) |
|-----------|----------------|
| Major sprints | 6 (plus ~14 interstitial point sprints), then Pre-defence hardening and Phase B |
| Automated tests | **919** (517 mobile Jest / 247 backend Jest / 155 JVM) |
| DB migrations | 16 (`000`–`016`, no `004`) + `schema_migrations` ledger |
| Smoke/integration scripts | 3 (`smoke-missions`, `smoke-sprint58`, `test-sprint59`) |
| Tracked epics | 11 (10 Done, 1 future work) |

Velocity was measured qualitatively (epics/features per sprint) rather than in story points, appropriate for a solo PFE. The interstitial "point" sprints show a healthy pattern of shipping a feature then immediately hardening it.

---

## 8. Risk and Impediment Log

| # | Risk / impediment | Impact | Resolution |
|---|-------------------|--------|------------|
| R1 | RN 0.74 incompatibility with heavy TFLite libs | Blocked vision | Switched to Yahoo Open NSFW TFLite + ML Kit (`1c566cb`, `9d17a75`) |
| R2 | ML Kit weak on Arabic | Missed detections | Added Tesseract `ara` fallback with gating (`1e197c6`) |
| R3 | MIUI foreground mis-attribution | Wrong app / missed overlays | UsageStats tuning + OCR override (`cddf628`, `59da85b`) |
| R4 | Background JS timers frozen → wedged lookups / hung frames | Capture stall (silent) | Self-heal + generation token (`f40aab5`); native 5 s-tick liveness backstop + per-phase deadlines + generation-guarded `finally`. Residual: screen-off freezes the JS thread, recovery on screen wake. |
| R5 | Mission spam / bypass | Poor UX / weak enforcement | Cooldown + resurface + grace guards |
| R6 | False positives on filtered SERP / inbox | Wrong missions | Context correctors (SERP cap, benign, launcher) |
| R7 | OneDrive/Gradle file locks on Windows | Build failures | Exclude build dirs from sync; clean `.gradle`; Gradle project cache outside OneDrive |
| R8 | The OS can stop the Accessibility service (e.g. SafeGuard swiped from Recents on some ROMs) | No site blocking; slower app-switch detection | Health card on the Monitor tab; manual re-enable in Settings → Accessibility |

---

## 9. Overall Retrospective

**What went well**

- On-device-first architecture held from Sprint 1 to final; the privacy invariant was never compromised.
- Pure, testable domain logic enabled 919 automated tests (517 mobile Jest, 247 backend Jest, 155 JVM) and confident refactors.
- Real-device, log-driven debugging (Metro + backend logs) caught subtle production issues (MIUI, frozen timers) that unit tests could not.

**What was hard**

- OEM (MIUI) behaviour and React Native background timer throttling caused the most difficult, non-obvious bugs.
- Balancing sensitivity vs false positives in risk scoring required repeated context correctors.

**What to do next time / future work**

- Introduce automated device E2E early (Detox/Appium).
- Replace proxy-based wellbeing with sensor ground truth.
- Build a native parent app with push notifications, and add real authentication (registration / login / token issuance) for production — per-route parent–child ownership is now enforced (`backend/src/middleware/childAccess.ts`).

These align with [README.md — Known limitations / future work](../README.md#known-limitations--future-work).

---

*End of Scrum artefacts — SafeGuard, Current `main` (post-Phase B, September 2026).*
