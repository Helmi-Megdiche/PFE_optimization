# Scoring Formulas – Per-Capture Risk, Addiction Risk & Digital Well-Being

This document defines every score in SafeGuard:

1. **Per-capture combined risk** (on-device, real-time) — `MobileApp/src/utils/riskCombination.ts`.
2. **Daily addiction risk** and **daily wellbeing** (backend cron) — `backend/src/scoring/scoringEngine.ts`.

All scores are integers from **0 to 100**. See [architecture.md](architecture.md) §7 for where these fit in the pipeline.

---

## Per-Capture Combined Risk (on-device)

Computed for every processed frame before posting to `POST /api/screen-events`.

### Component weights

| Component | Weight | Source |
|-----------|--------|--------|
| OCR risk | **30%** | keyword hits + category (`computeOcrRiskScore`) |
| Vision risk | **70%** | TFLite NSFW + ML Kit labels (`computeImageRiskScore`) |

```
combinedRiskScore = round( clamp( ocrRisk × 0.3 + imageRisk × 0.7 , 0, 100 ) )
```

### OCR risk score (`computeOcrRiskScore`)

| Condition | Value |
|-----------|-------|
| category `adult` | `min(100, max(70, 50 + matchedCount × 12))` |
| category `violent` | `min(100, max(70, 50 + matchedCount × 12))` |
| other, `riskFlag` set | `min(100, 50 + matchedCount × 12)` |
| category `educational` | `15` |
| otherwise | `5` |

### Vision risk score (`computeImageRiskScore`)

```
raw = (violence × 0.4 + adult × 0.3 + gore × 0.2 + dangerousChallenge × 0.1) × 100
imageRisk = round( clamp(raw, 0, 100) )
```

### Explicit OCR boost (`applyExplicitOcrBoost`)

Prevents a timid image model from diluting a clear keyword hit:

| Rule | Effect |
|------|--------|
| `ocrCategory = adult` **and** `ocrRisk > 50` **and** `imageAdultScore < 0.3` | floor `imageRisk` to **70** |
| `ocrCategory = adult` | floor `combined` to **70** |
| `ocrCategory = violent` **and** `ocrRisk > 50` | floor `combined` to **80** |

> This is why an adult keyword on a visually harmless screenshot (e.g. a chat) can still score 70 combined even when TFLite reports `neutral`.

### Category resolution and consistency

- `resolveCombinedCategory` picks the dominant category from image axes (threshold 0.35), then falls back to explicit >0.5 axes, mapped label, and finally the OCR category.
- `enforceCategoryConsistency` forbids a `neutral` category when `combined ≥ 50` or `riskFlag` is set.

### Context correctors (applied after combination)

| Corrector | Module | Effect |
|-----------|--------|--------|
| Filtered SERP cap | `riskySearchContext.ts` | Cap (~24) on SafeSearch / Mode IA pages unless an explicit **search-box** query is present |
| Benign context | `benignRiskContext.ts` | Neutralise social inbox / known false-positive patterns |
| Launcher recents | `launcherCaptureContext.ts` | Neutralise recents-widget-only thumbnails |

---

## Input: Daily Usage Statistics

Aggregated per child per calendar day (UTC) from `usage_sessions`:

| Field | Description |
|-------|-------------|
| `totalScreenMinutes` | Sum of session durations |
| `sessionCount` | Number of sessions |
| `nightMinutes` | Minutes in 22:00–06:00 UTC |
| `weekOverWeekChangePercent` | Change vs. same weekday 7 days earlier |
| `physicalActivityMinutes` | Completed real-world physical missions on score date × 10 min (max 60) |
| `educationalScreenMinutes` | Time in `educational` or `creative` categories |
| `bedtimeVarianceMinutes` | Stddev of daily last `usage_sessions.end_time` over prior 7 days (fallback 30) |
| `familyCallsMessages` | Count of completed family-interaction missions on score date |
| `recommendedScreenMinutes` | Age-based cap from `children.birth_year` (<10 → 120, 10–12 → 150, 13+ → 180) |

---

## Addiction Risk Score (higher = worse)

Weighted sum of five components:

| Component | Weight | Formula (0–100 each) |
|-----------|--------|----------------------|
| **Intensity** | 30% | `min(totalMinutes / 480, 1) × 100` (8h cap) |
| **Compulsivity** | 20% | `min((sessionsPerHour / 6) × 100, 100)` where `sessionsPerHour = sessionCount / 16` |
| **Night usage** | 25% | `(nightMinutes / totalScreenMinutes) × 100` (0 if no screen time) |
| **Escalation** | 15% | 100 if WoW change > 20%; linear 0–100 if 0–20%; else 0 |
| **Real imbalance** | 10% | Penalty if physical activity < `totalMinutes / 10` |

**Base score:** `round(clamp(weighted sum, 0, 100))`

### Exposure frequency adjustment (daily cron)

After the base addiction score is computed, the daily job counts risky `screen_events` in the **last 7 days** (`risk_flag = true`) and adds an exposure penalty:

| Term | Formula |
|------|---------|
| **Exposure penalty** | `min(20, weeklyRiskyCount × 2)` |
| **Stored addiction score** | `min(100, baseAddictionScore + exposurePenalty)` |

Component columns (`intensity`, `compulsivity`, etc.) still reflect the **base** score only; the penalty is applied only to `addiction_score` in `daily_scores`.

### Example – low risk

- 90 min screen, 4 sessions, 0 night min, 0% WoW change, 30 min activity  
- **Result:** ~15–25 addiction score

### Example – high risk

- 720 min screen, 80 sessions, 360 night min, +25% WoW, 0 activity  
- **Result:** ≥ 85 addiction score

---

## Digital Well-Being Score (higher = better)

| Component | Weight | Formula (0–100 each) |
|-----------|--------|----------------------|
| **Screen balance** | 30% | 100 if under recommended cap (default 180 min); linear drop with excess up to 4h over |
| **Content quality** | 25% | `(educationalMinutes / totalMinutes) × 100` |
| **Real activity** | 20% | `min(100, (physicalMinutes / 60) × 100)` |
| **Sleep consistency** | 15% | 100 if variance ≤ 30 min; 0 if > 120 min; linear between |
| **Family interaction** | 10% | `min(100, familyCallsMessages × 10)` |

**Final score:** `round(clamp(weighted sum, 0, 100))`

---

## Daily Cron Job

- **Schedule:** `01:00` every day (server local time) via `node-cron`
- **Process:** For each row in `children`, aggregate yesterday’s sessions, compute both scores, upsert `daily_scores`
- **Manual re-run:** Call `runDailyScoreJob()` from `backend/src/jobs/dailyScoreJob.ts` in a REPL or add a dev script

---

## API Access

| Role | Endpoint |
|------|----------|
| Child | `POST /api/usage` |
| Parent | `GET /api/usage/:childId?date=` |
| Parent | `GET /api/scores/:childId?date=` |
| Parent | `GET /api/scores/:childId/trend?days=7` |

---

## Dynamic Wellbeing Proxies (Sprint 5.8)

Implemented in `backend/src/scoring/wellbeingProxies.ts` and wired in `dailyScoreJob.ts`:

| Proxy | Source | Notes |
|-------|--------|-------|
| **Physical activity** | `missions` where `status = 'completed'`, `metadata.type = 'real_world'`, `templateKey = 'physical_activity'` or `action IN ('jumping_jacks', …)` | 10 min per mission, capped at 60 |
| **Bedtime variance** | Max daily `usage_sessions.end_time` over 7-day window | `STDDEV` of time-of-day; fallback 30 min if insufficient data |
| **Family interaction** | Completed missions with family-related `templateKey` or `action` | Count feeds `familyInteraction` component (`× 10`, max 100) |

Real-world missions count only after **parent approval** (`status = 'completed'`, `completed_at` set).

---

## Child Interests And Mission Personalization

Parents manage `children.interests` (JSONB array) via `PUT /api/child/interests`. Allowed tags: `sports`, `art`, `reading`, `family`, `brain`.

Mission selection (`pickMissionTemplate`) keeps existing priority (addiction > wellbeing > risk > default). Interests act as a **tie-breaker** inside `pickCandidate()` — when multiple fresh candidates exist, prefer those matching the child's interests.

---

## Future Enhancements

- Circular-time bedtime variance (midnight wrap-around)
- Custom mission interest tags for parent-defined real-world missions
- TFLite content quality signal from `screen_events` categories
