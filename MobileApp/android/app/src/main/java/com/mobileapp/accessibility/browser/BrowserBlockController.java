package com.mobileapp.accessibility.browser;

import java.util.HashMap;
import java.util.Map;

/**
 * Decides what to do when Chrome shows a listed domain, and whether a screenshot detection may add
 * a domain to the blacklist. Pure logic: it performs no Back/HOME press and shows no screen, it
 * returns {@link Decision}s and {@link SequenceStep}s for the accessibility service to carry out.
 * Times are {@code SystemClock.uptimeMillis()} values supplied by the caller (deterministic in
 * tests). All public methods are {@code synchronized}: the accessibility thread and the RN bridge
 * thread both call in.
 *
 * <p>Rules this class owns (Phase B review):
 * <ul>
 *   <li><b>A1</b> A match found by the URL watcher may show the block screen; an add from a
 *       screenshot detection is always Back only (the mission overlay is about to arrive).
 *   <li><b>A2</b> "Chrome left the foreground" is recorded, so a frame taken elsewhere can never be
 *       blamed on the last Chrome host.
 *   <li><b>A3</b> The same-host dedupe key resets when Chrome leaves the foreground, so a blocked
 *       page still open in the background is blocked again on reopen.
 *   <li><b>A4</b> An add needs a real capture time, at most {@link #MAX_CAPTURE_AGE_MS} old, with
 *       no host change and no left-Chrome entry between the capture and now.
 *   <li><b>A5/B8</b> One enforcement sequence at a time; it expires after
 *       {@link #SEQUENCE_CEILING_MS} even if its callback is lost.
 *   <li><b>B2</b> The first detection emits an incident too.
 * </ul>
 *
 * <p>Pure Java, no {@code android.*} imports.
 */
public final class BrowserBlockController {

    public static final String CHROME_PACKAGE = "com.android.chrome";

    /**
     * A screenshot may be up to this old when the add arrives. Covers the 25 s vision budget plus
     * the POST. The no-change rule (not a second window) does the real attribution work.
     */
    public static final long MAX_CAPTURE_AGE_MS = 30_000L;

    /** Back, re-read, Back, re-read, HOME must all fit in this; the flag then clears by itself. */
    public static final long SEQUENCE_CEILING_MS = 3_000L;

    /** At most one incident per domain per this window. */
    public static final long INCIDENT_COOLDOWN_MS = 10_000L;

    public enum OverlayKind {
        NONE,
        MISSION,
        BLOCK
    }

    /** Supplies what overlay is showing right now (wired to OverlayService in a later task). */
    public interface OverlayKindSource {
        OverlayKind current();
    }

    public enum Enforcement {
        NONE,
        BACK_ONLY,
        BACK_AND_BLOCK_SCREEN
    }

    public enum SequenceStep {
        BACK_AGAIN,
        HOME,
        DONE
    }

    public static final class Decision {
        public final Enforcement enforcement;
        /** The listed domain that matched (never a path or URL); null when {@code NONE}. */
        public final String incidentDomain;

        public final DomainMatcher.ListSource source;
        public final boolean emitIncident;

        Decision(
                Enforcement enforcement,
                String incidentDomain,
                DomainMatcher.ListSource source,
                boolean emitIncident) {
            this.enforcement = enforcement;
            this.incidentDomain = incidentDomain;
            this.source = source;
            this.emitIncident = emitIncident;
        }

        static final Decision NONE = new Decision(Enforcement.NONE, null, null, false);
    }

    public static final class AddOutcome {
        /** The domain was newly added to the dynamic list. */
        public final boolean added;
        /** The domain is on the dynamic list now (newly added, or already there). */
        public final boolean listed;

        public final String reason;
        /** The host as it was on screen (host only). Null when refused before a host was known. */
        public final String host;

        public final Decision decision;

        AddOutcome(boolean added, boolean listed, String reason, String host, Decision decision) {
            this.added = added;
            this.listed = listed;
            this.reason = reason;
            this.host = host;
            this.decision = decision;
        }

        static AddOutcome refused(String reason) {
            return new AddOutcome(false, false, reason, null, Decision.NONE);
        }
    }

    public static final class LeaveOutcome {
        /** An enforcement sequence was started (or one was already running) for this host. */
        public final boolean left;

        public final String reason;
        /** The host as it was on screen (host only). Null when refused before a host was known. */
        public final String host;

        public final Decision decision;

        LeaveOutcome(boolean left, String reason, String host, Decision decision) {
            this.left = left;
            this.reason = reason;
            this.host = host;
            this.decision = decision;
        }

        static LeaveOutcome refused(String reason) {
            return new LeaveOutcome(false, reason, null, Decision.NONE);
        }
    }

    private final DomainLists lists;
    private final HostHistory history;
    private final OverlayKindSource overlay;

    private String lastCheckedHost;
    private final Map<String, Long> lastIncidentMs = new HashMap<>();

    /** 0 = no sequence; 1 = first Back pressed; 2 = second Back pressed; 3 = HOME pressed. */
    private int sequenceStep;

    private long sequenceStartMs;

    public BrowserBlockController(
            DomainLists lists, HostHistory history, OverlayKindSource overlay) {
        this.lists = lists;
        this.history = history;
        this.overlay = overlay;
    }

    // ---- foreground tracking --------------------------------------------------------------------

    /**
     * A window-state change reported the foreground package. Anything other than Chrome records
     * "left Chrome", resets the dedupe key (A3) and ends any running sequence (nothing left to
     * enforce outside Chrome).
     */
    public synchronized void onForegroundPackage(String pkg, long nowUptime) {
        if (CHROME_PACKAGE.equals(pkg)) {
            return;
        }
        history.recordLeftChrome(nowUptime);
        lastCheckedHost = null;
        endSequence();
    }

    // ---- URL watcher path -----------------------------------------------------------------------

    /**
     * Chrome's address bar read as {@code host} (already normalised). A null host is "no change":
     * nothing is recorded and nothing is matched. {@code force} bypasses the same-host dedupe (a
     * Chrome window-state change).
     */
    public synchronized Decision onUrlRead(String host, long nowUptime, boolean force) {
        if (host == null) {
            return Decision.NONE;
        }
        history.recordHost(host, nowUptime);
        if (!force && host.equals(lastCheckedHost)) {
            return Decision.NONE;
        }
        lastCheckedHost = host;

        DomainMatcher.Match match = lists.match(host);
        if (match == null) {
            return Decision.NONE;
        }
        if (sequenceActive(nowUptime)) {
            return Decision.NONE; // A5: one sequence, one incident
        }
        Enforcement e =
                overlay.current() == OverlayKind.MISSION
                        ? Enforcement.BACK_ONLY
                        : Enforcement.BACK_AND_BLOCK_SCREEN;
        return startEnforcement(e, match.domain, match.source, nowUptime);
    }

    // ---- enforcement sequence -----------------------------------------------------------------

    /** Whether an enforcement sequence is running (auto-expires after the ceiling: B8). */
    public synchronized boolean sequenceActive(long nowUptime) {
        return sequenceStep > 0 && nowUptime - sequenceStartMs < SEQUENCE_CEILING_MS;
    }

    /**
     * The service re-read the address bar after acting. Returns the next action, or DONE when the
     * host is no longer blocked, could not be read, or the sequence is over or expired.
     */
    public synchronized SequenceStep onReRead(String hostNow, long nowUptime) {
        if (!sequenceActive(nowUptime)) {
            endSequence();
            return SequenceStep.DONE;
        }
        if (hostNow == null || lists.match(hostNow) == null) {
            endSequence();
            return SequenceStep.DONE;
        }
        if (sequenceStep == 1) {
            sequenceStep = 2;
            return SequenceStep.BACK_AGAIN;
        }
        if (sequenceStep == 2) {
            sequenceStep = 3;
            return SequenceStep.HOME;
        }
        endSequence();
        return SequenceStep.DONE;
    }

    // ---- screenshot detection path ---------------------------------------------------------------

    /**
     * JS reports a confident adult detection for the frame captured at {@code captureTsWallMs}. The
     * host is resolved HERE from the history, never supplied by JS. Every refusal carries a
     * machine-readable reason for the log.
     */
    public synchronized AddOutcome addDetectedDomain(
            long captureTsWallMs, long nowWallMs, long nowUptimeMs) {
        if (captureTsWallMs <= 0) {
            return AddOutcome.refused("no_capture_ts"); // never fall back to "now"
        }
        long age = Math.max(0L, nowWallMs - captureTsWallMs);
        if (age > MAX_CAPTURE_AGE_MS) {
            return AddOutcome.refused("capture_too_old");
        }
        long captureUptime = nowUptimeMs - age;

        HostHistory.Entry cover = history.entryCoveringAt(captureUptime);
        if (cover == null) {
            return AddOutcome.refused("no_host");
        }
        if (cover.host == null) {
            return AddOutcome.refused("left_chrome");
        }
        if (history.anyEntryAfter(captureUptime, nowUptimeMs)) {
            return AddOutcome.refused("host_changed_since_capture");
        }

        String host = cover.host;
        DomainLists.AddResult result = lists.addDetected(host);
        switch (result) {
            case REFUSED_NEVER_BLOCK:
                return AddOutcome.refused("never_block");
            case REFUSED_INVALID:
                return AddOutcome.refused("invalid_host");
            case NOT_LOADED:
                return AddOutcome.refused("lists_not_loaded");
            default:
                break;
        }
        boolean added = result == DomainLists.AddResult.ADDED;
        lastCheckedHost = host;

        Decision decision = Decision.NONE;
        if (!sequenceActive(nowUptimeMs)) {
            // A1: Back only. JS decides whether the block screen is needed once it knows whether a
            // mission was presented.
            decision =
                    startEnforcement(
                            Enforcement.BACK_ONLY,
                            DomainMatcher.registrable(host),
                            DomainMatcher.ListSource.DETECTED,
                            nowUptimeMs);
        }
        return new AddOutcome(added, true, added ? "added" : "duplicate", host, decision);
    }

    /**
     * F2 (review round 4, 2026-09-22 device finding): JS reports an OCR-only adult detection in
     * Chrome — the image check did not clear the blacklist threshold, so nothing may be listed and
     * no incident may be filed, but the child should not be left sitting on the page either. The host
     * is resolved HERE using the identical A2/A4 attribution rules as {@link #addDetectedDomain}
     * (same {@link #MAX_CAPTURE_AGE_MS}, same no-host-change requirement) — Back is reversible,
     * blacklisting is not, so this path never touches {@link #lists}.
     */
    public synchronized LeaveOutcome leaveBlockedPage(
            long captureTsWallMs, long nowWallMs, long nowUptimeMs) {
        if (captureTsWallMs <= 0) {
            return LeaveOutcome.refused("no_capture_ts");
        }
        long age = Math.max(0L, nowWallMs - captureTsWallMs);
        if (age > MAX_CAPTURE_AGE_MS) {
            return LeaveOutcome.refused("capture_too_old");
        }
        long captureUptime = nowUptimeMs - age;

        HostHistory.Entry cover = history.entryCoveringAt(captureUptime);
        if (cover == null) {
            return LeaveOutcome.refused("no_host");
        }
        if (cover.host == null) {
            return LeaveOutcome.refused("left_chrome");
        }
        if (history.anyEntryAfter(captureUptime, nowUptimeMs)) {
            return LeaveOutcome.refused("host_changed_since_capture");
        }

        String host = cover.host;
        lastCheckedHost = host;

        if (sequenceActive(nowUptimeMs)) {
            // A5: one sequence at a time — an enforcement is already under way for this page
            // (e.g. addDetectedDomain's own Back-only sequence just started for the same host).
            return new LeaveOutcome(true, "already_in_progress", host, Decision.NONE);
        }
        sequenceStep = 1;
        sequenceStartMs = nowUptimeMs;
        // No domain, no source, no incident: this is not a blacklist match.
        Decision decision = new Decision(Enforcement.BACK_ONLY, null, null, false);
        return new LeaveOutcome(true, "left", host, decision);
    }

    // ---- internals -----------------------------------------------------------------------------

    private Decision startEnforcement(
            Enforcement e, String domain, DomainMatcher.ListSource source, long nowUptime) {
        sequenceStep = 1;
        sequenceStartMs = nowUptime;

        Long last = lastIncidentMs.get(domain);
        boolean emit = last == null || nowUptime - last >= INCIDENT_COOLDOWN_MS;
        if (emit) {
            lastIncidentMs.put(domain, nowUptime);
        }
        return new Decision(e, domain, source, emit);
    }

    private void endSequence() {
        sequenceStep = 0;
    }
}
