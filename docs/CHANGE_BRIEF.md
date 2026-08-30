# Change Brief — pre-defence revision round

The academic expert asked for a set of changes. Known so far: **UI rework**, **+18 site
blacklist**, **behaviour detection**, plus others still to be specified. Some features
will also be **removed** — that list is not yet defined.

This brief is the starting point for a Claude Code session. Phase 1 is investigation:
answer the questions below by reading the code, and produce a written findings document
before any implementation. Do not start editing until the scoping decisions at the bottom
are settled.

---

## Phase 1 — investigation

### A. UI rework

1. Inventory every file that renders UI, split into three groups: RN screens/components,
   the native overlay (`res/layout/overlay_mission.xml`, `OverlayQuizHelper.java`,
   `OverlayWindowHelper.java`), and `demo_dashboard.html`. For each, estimate styling vs
   logic lines.
2. List every distinct color, font size, spacing value and border radius currently used
   across `MobileApp/src`. This becomes the input to a design-token file.
3. Determine whether the overlay renders natively in Java or can host React Native views.
   This decides whether a redesign is one job or two.
4. Identify which screens can be restyled without touching logic, and which hold state,
   timers or API calls inline — specifically `ScreenMonitor.tsx` (311 lines),
   `MissionScreen.tsx`, and the six game screens.
5. Check which UI libraries actually install cleanly on RN 0.74.5 alongside the existing
   native modules (`@react-native-ml-kit/*`, the Tesseract module): candidates are
   `react-native-svg`, `react-native-vector-icons`, `reanimated`, `nativewind`,
   `react-native-paper`. Report peer-dependency conflicts, don't guess.
6. List which of the 181 mobile tests touch rendering and would break under
   restructuring.
7. Find the hardcoded values in the UI layer that should be real state — starting with
   `MonitorScreen`'s `intervalMs={20000}` and `consentGranted=true`.

### B. +18 site blacklist

8. Trace the full path from OCR text → `findAdultSiteMatches` → `riskySearchContext` →
   `riskCombination` → posted event. Identify exactly where an adult-site hit changes the
   score and by how much.
9. Diff `MobileApp/src/utils/adultSiteContext.ts` against `backend/src/utils/adultSiteContext.ts`.
   Determine which one runs in the production child path and whether the other is dead code.
10. Establish whether the browser URL is obtainable by any means other than OCR of the
    address bar. Check `ForegroundAppModule.java` and `inferAppPackageFromOcr.ts`. Report
    what happens with a collapsed omnibox, incognito, and in-app WebViews.
11. Specify what a parent-editable, DB-backed blacklist would require: tables, migrations,
    routes, validators, the mobile sync path, and offline behaviour on the device.
12. Determine what `OverlayService` / `OverlayMissionModule` can do today — can it cover
    the screen until dismissed, or return the user to home? What happens if the child
    simply ignores the overlay?
13. Cost out real blocking. For each of `AccessibilityService`, `VpnService` (local
    DNS/host filtering), and any alternative: manifest changes, new permissions, conflicts
    with existing modules, Play-policy exposure, and the impact on the privacy claim.
14. Produce a full inventory of every risk list across mobile and backend
    (`riskKeywords.ts`, `keywordFilter.ts`, `adultSiteContext.ts`, `riskMapping.ts`) and
    note which pairs are kept in sync by hand.

### C. Behaviour detection

15. Document the full `usage_session` lifecycle: creation on device, flush timing, what
    ends a session, server-side validation. Identify what signal is lost to the 60s
    batching and the 3s minimum-session filter.
16. List every column in `usage_sessions`, `screen_events` and `missions` that no scoring
    or mission code currently reads.
17. Identify the smallest change that lets a behaviour rule fire in near-real-time —
    on `POST /api/usage`, on `POST /api/screen-events`, or via a new endpoint. Show where
    the hook belongs.
18. Determine whether a behaviour detector can reuse `generateMissionFromRisk` as its
    entry point, or whether `pickMissionTemplate` assumes a risk score is present.
19. Separate the behaviour patterns computable from existing data with no schema change
    (night usage now, binge session length, app-switch frequency, escalating risky-event
    rate, first-unlock time) from those needing new columns or tables.
20. Assess whether the `getCumulativeRisk` query shape (last 5 events / 30 min) is
    reusable as a generic sliding-window rule, and how it behaves as `screen_events` grows.

### D. Regression safety — do this before editing anything

21. Produce a dependency map of `useScreenshotCapture.ts`: every import, every native call,
    every timer/lock/watchdog it owns. Mark what is safe to touch and what is load-bearing
    for the MIUI and stall fixes.
22. Identify what the 310 tests do **not** cover — behaviours that could break silently.
23. Confirm whether `demo_dashboard.html` and `backend/public/demo.html` are identical,
    and which is newer.

### E. Housekeeping worth folding in

24. Add a jest setup file so `cd backend && npm test` runs green from a clean clone
    without a `.env` (currently 2 of 17 suites fail on `requireEnv`).
25. Fix the doc drift listed at the end of `CLAUDE.md` — the capture-interval numbers in
    `PREFINAL_REPORT.md` §3.1 and the JPEG-deletion claim in `SRS.md` FR-CAP-6 are both
    contradicted by the code, and both are the kind of thing a jury checks.

---

## Scoping decisions needed before implementation

These cannot be answered from the code. Helmi must confirm with the academic expert.

**Blacklist — detect or block?**
*Detect and intervene* (fire a mission/alert when an adult domain is recognised) fits the
existing architecture and is a small change. *Actually prevent access* requires an
`AccessibilityService` or `VpnService`, new permissions, and partly undermines the privacy
invariant — a VPN sees all traffic, which contradicts "nothing leaves the device
unprocessed." These are different projects with different risk profiles. This is the
single biggest open question.

**Behaviour detection — what latency?**
A daily pattern report for the parent is a query against existing data. A live trigger
("90 minutes straight on TikTok") means moving detection out of the nightly cron and into
the ingest path. Decide before designing.

**UI — how far does it reach?**
Child RN screens only, or also the native overlay and the parent dashboard? The overlay is
separate Android XML and the dashboard is a standalone HTML file; including them roughly
triples the work.

**What gets removed?**
Cutting features is what makes room for the new work. The removal list should be settled
alongside the addition list, not after.
