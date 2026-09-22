package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mobileapp.accessibility.browser.BrowserBlockController.AddOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockController.Decision;
import com.mobileapp.accessibility.browser.BrowserBlockController.Enforcement;
import com.mobileapp.accessibility.browser.BrowserBlockController.LeaveOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockController.OverlayKind;
import com.mobileapp.accessibility.browser.BrowserBlockController.SequenceStep;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class BrowserBlockControllerTest {

    private static final String CHROME = "com.android.chrome";
    private static final String LAUNCHER = "com.miui.home";

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private DomainLists lists;
    private HostHistory history;
    private BrowserBlockController c;
    private OverlayKind overlay = OverlayKind.NONE;

    private static ByteArrayInputStream asset(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
    }

    @Before
    public void setUp() throws Exception {
        lists =
                new DomainLists(
                        new NeverBlockList(Arrays.asList("google.*", "wikipedia.org")),
                        new File(tmp.getRoot(), "dyn.txt"),
                        Runnable::run,
                        m -> {});
        lists.load(asset("blocked.com\nadult.example.org\n"));
        history = new HostHistory();
        c = new BrowserBlockController(lists, history, () -> overlay);
    }

    // ---- URL watcher path ---------------------------------------------------------------------

    @Test
    public void anUnlistedHostDoesNothing() {
        Decision d = c.onUrlRead("example.com", 1000, false);
        assertEquals(Enforcement.NONE, d.enforcement);
        assertFalse(c.sequenceActive(1000));
    }

    @Test
    public void aStaticListHostGetsBackAndTheBlockScreenAndAnIncident() {
        Decision d = c.onUrlRead("www.blocked.com", 1000, false);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, d.enforcement);
        assertEquals("blocked.com", d.incidentDomain);
        assertEquals(DomainMatcher.ListSource.STATIC, d.source);
        assertTrue(d.emitIncident);
        assertTrue(c.sequenceActive(1000));
    }

    @Test
    public void aMissionOverlayMeansBackOnlyButStillAnIncident() {
        overlay = OverlayKind.MISSION;
        Decision d = c.onUrlRead("blocked.com", 1000, false);
        assertEquals(Enforcement.BACK_ONLY, d.enforcement);
        assertTrue(d.emitIncident);
    }

    @Test
    public void aDetectedDomainMatchesItsSubdomains() {
        lists.addDetected("dyn-adult.com");
        Decision d = c.onUrlRead("m.dyn-adult.com", 1000, false);
        assertEquals(DomainMatcher.ListSource.DETECTED, d.source);
        assertEquals("dyn-adult.com", d.incidentDomain);
    }

    @Test
    public void anUnreadableAddressBarChangesNothing() {
        assertEquals(Enforcement.NONE, c.onUrlRead(null, 1000, false).enforcement);
        assertEquals(0, history.size());
    }

    @Test
    public void theSameHostIsNotRematchedOnceTheSequenceEnded() {
        c.onUrlRead("blocked.com", 1000, false);
        assertEquals(SequenceStep.DONE, c.onReRead(null, 1400));
        assertEquals(Enforcement.NONE, c.onUrlRead("blocked.com", 1500, false).enforcement);
    }

    @Test
    public void reopeningAfterTheHomeFallbackBlocksAgain() {
        // Back, Back, HOME: the blocked page is still open in Chrome's background.
        assertEquals(
                Enforcement.BACK_AND_BLOCK_SCREEN,
                c.onUrlRead("blocked.com", 1000, false).enforcement);
        assertEquals(SequenceStep.BACK_AGAIN, c.onReRead("blocked.com", 1400));
        assertEquals(SequenceStep.HOME, c.onReRead("blocked.com", 1800));
        assertEquals(SequenceStep.DONE, c.onReRead("blocked.com", 2200));

        // The child leaves Chrome, then reopens it from recents: same host, no host "change".
        c.onForegroundPackage(LAUNCHER, 3000);
        c.onForegroundPackage(CHROME, 20000);
        Decision d = c.onUrlRead("blocked.com", 20050, false);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, d.enforcement);
    }

    @Test
    public void twoMatchesInsideOneSequenceGiveOneSequenceAndOneIncident() {
        int incidents = 0;
        Decision first = c.onUrlRead("blocked.com", 1000, false);
        if (first.emitIncident) incidents++;
        // Pressing Back makes Chrome navigate and fire more events, some forced by a state change.
        Decision second = c.onUrlRead("blocked.com", 1050, true);
        Decision third = c.onUrlRead("adult.example.org", 1100, false);
        Decision fourth = c.onUrlRead("blocked.com", 1300, true);
        for (Decision d : new Decision[] {second, third, fourth}) {
            assertEquals(Enforcement.NONE, d.enforcement);
            if (d.emitIncident) incidents++;
        }
        assertEquals(1, incidents);
    }

    @Test
    public void anAbandonedSequenceStopsBlockingTheNextMatchAfterTheCeiling() {
        assertEquals(
                Enforcement.BACK_AND_BLOCK_SCREEN,
                c.onUrlRead("blocked.com", 1000, false).enforcement);
        // The re-read callback was lost (service killed mid-sequence): nothing calls onReRead.
        long justBefore = 1000 + BrowserBlockController.SEQUENCE_CEILING_MS - 1;
        assertTrue(c.sequenceActive(justBefore));
        assertEquals(Enforcement.NONE, c.onUrlRead("blocked.com", justBefore, true).enforcement);

        long atCeiling = 1000 + BrowserBlockController.SEQUENCE_CEILING_MS;
        assertFalse(c.sequenceActive(atCeiling));
        assertEquals(
                Enforcement.BACK_AND_BLOCK_SCREEN,
                c.onUrlRead("blocked.com", atCeiling, true).enforcement);
    }

    @Test
    public void reReadWalksBackBackHomeThenDone() {
        c.onUrlRead("blocked.com", 1000, false);
        assertEquals(SequenceStep.BACK_AGAIN, c.onReRead("blocked.com", 1400));
        assertEquals(SequenceStep.HOME, c.onReRead("blocked.com", 1800));
        assertEquals(SequenceStep.DONE, c.onReRead("blocked.com", 2200));
        assertFalse(c.sequenceActive(2200));
    }

    @Test
    public void reReadEndsTheSequenceOnceTheHostIsNoLongerBlocked() {
        c.onUrlRead("blocked.com", 1000, false);
        assertEquals(SequenceStep.DONE, c.onReRead("example.com", 1400));
        assertFalse(c.sequenceActive(1400));
    }

    @Test
    public void anUnreadableReReadEndsTheSequenceWithoutActing() {
        c.onUrlRead("blocked.com", 1000, false);
        assertEquals(SequenceStep.DONE, c.onReRead(null, 1400));
        assertFalse(c.sequenceActive(1400));
    }

    @Test
    public void reReadWithNoSequenceIsDone() {
        assertEquals(SequenceStep.DONE, c.onReRead("blocked.com", 1000));
    }

    @Test
    public void leavingChromeMidSequenceEndsIt() {
        c.onUrlRead("blocked.com", 1000, false);
        c.onForegroundPackage(LAUNCHER, 1200);
        assertFalse(c.sequenceActive(1200));
    }

    @Test
    public void theChromePackageItselfDoesNotCountAsLeavingChrome() {
        c.onUrlRead("example.com", 1000, false);
        c.onForegroundPackage(CHROME, 1100);
        assertNotNull(history.latest().host);
    }

    @Test
    public void oneIncidentPerDomainPerTenSeconds() {
        assertTrue(c.onUrlRead("blocked.com", 1000, false).emitIncident);
        c.onForegroundPackage(LAUNCHER, 1500);

        Decision soon = c.onUrlRead("blocked.com", 6000, false);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, soon.enforcement);
        assertFalse("inside the 10 s cooldown", soon.emitIncident);
        c.onForegroundPackage(LAUNCHER, 6500);

        Decision later = c.onUrlRead("blocked.com", 11000, false);
        assertTrue("cooldown over", later.emitIncident);
    }

    // ---- addDetectedDomain path -----------------------------------------------------------------

    private static final long NOW_WALL = 1_000_000L;
    private static final long NOW_UPTIME = 50_000L;

    private AddOutcome addAt(long captureAgeMs) {
        return c.addDetectedDomain(NOW_WALL - captureAgeMs, NOW_WALL, NOW_UPTIME);
    }

    @Test
    public void aMissingCaptureTimestampNeverFallsBackToNow() {
        history.recordHost("fresh-adult.com", 40_000);
        for (long ts : new long[] {0L, -5L}) {
            AddOutcome o = c.addDetectedDomain(ts, NOW_WALL, NOW_UPTIME);
            assertFalse(o.listed);
            assertEquals("no_capture_ts", o.reason);
        }
        assertTrue(lists.dynamicSnapshot().isEmpty());
    }

    @Test
    public void aCaptureOlderThanTheMaxAgeIsRefused() {
        history.recordHost("fresh-adult.com", 1_000);
        assertEquals(30_000L, BrowserBlockController.MAX_CAPTURE_AGE_MS);
        assertEquals("capture_too_old", addAt(30_001).reason);
        assertTrue(lists.dynamicSnapshot().isEmpty());
    }

    @Test
    public void aCaptureExactlyAtTheMaxAgeIsAllowed() {
        history.recordHost("fresh-adult.com", 10_000);
        assertTrue(addAt(30_000).listed);
    }

    @Test
    public void noKnownHostMeansNoAdd() {
        AddOutcome o = addAt(2000);
        assertFalse(o.listed);
        assertEquals("no_host", o.reason);
    }

    @Test
    public void aFrameTakenAfterLeavingChromeNeverBlacklistsTheLastChromeHost() {
        // Chrome on site.com, then the child switches to Instagram; an Instagram frame scores
        // adult. The last Chrome host must not be blacklisted.
        history.recordHost("innocent-site.com", 40_000);
        c.onForegroundPackage("com.instagram.android", 45_000);
        AddOutcome o = addAt(2000); // capture instant = 48_000, inside the Instagram period
        assertFalse(o.listed);
        assertEquals("left_chrome", o.reason);
        assertTrue(lists.dynamicSnapshot().isEmpty());
    }

    @Test
    public void aHostChangeBetweenTheCaptureAndNowIsRefused() {
        history.recordHost("first-adult.com", 40_000);
        history.recordHost("second-site.com", 49_000); // after the capture at 48_000
        AddOutcome o = addAt(2000);
        assertFalse(o.listed);
        assertEquals("host_changed_since_capture", o.reason);
    }

    @Test
    public void leavingChromeBetweenTheCaptureAndNowIsRefused() {
        history.recordHost("first-adult.com", 40_000);
        c.onForegroundPackage(LAUNCHER, 49_500);
        AddOutcome o = addAt(2000);
        assertFalse(o.listed);
        assertEquals("host_changed_since_capture", o.reason);
    }

    @Test
    public void aNeverBlockHostIsRefused() {
        history.recordHost("www.google.com", 40_000);
        AddOutcome o = addAt(2000);
        assertFalse(o.listed);
        assertEquals("never_block", o.reason);
        assertTrue(lists.dynamicSnapshot().isEmpty());
    }

    @Test
    public void aValidAddListsTheDomainAndEnforcesBackOnlyWithAnIncident() {
        history.recordHost("www.fresh-adult.com", 40_000);
        overlay = OverlayKind.NONE;
        AddOutcome o = addAt(2000);

        assertTrue(o.added);
        assertTrue(o.listed);
        assertEquals("added", o.reason);
        assertEquals("www.fresh-adult.com", o.host);
        assertNotNull(lists.match("fresh-adult.com"));

        // A1: the add path never shows the block screen (the mission overlay is about to arrive,
        // or JS decides to show the block screen itself).
        assertEquals(Enforcement.BACK_ONLY, o.decision.enforcement);
        // B2: the first detection is the most important incident for the parent.
        assertTrue(o.decision.emitIncident);
        assertEquals("fresh-adult.com", o.decision.incidentDomain);
        assertEquals(DomainMatcher.ListSource.DETECTED, o.decision.source);
    }

    @Test
    public void anAlreadyListedDomainIsListedButNotAdded() {
        lists.addDetected("fresh-adult.com");
        history.recordHost("fresh-adult.com", 40_000);
        AddOutcome o = addAt(2000);
        assertFalse(o.added);
        assertTrue(o.listed);
        assertEquals("duplicate", o.reason);
        assertEquals(Enforcement.BACK_ONLY, o.decision.enforcement);
    }

    @Test
    public void afterAnAddTheWatcherDoesNotStartASecondSequenceOrIncident() {
        history.recordHost("fresh-adult.com", 40_000);
        AddOutcome o = addAt(2000);
        assertTrue(o.decision.emitIncident);
        Decision watcher = c.onUrlRead("fresh-adult.com", NOW_UPTIME + 20, true);
        assertEquals(Enforcement.NONE, watcher.enforcement);
        assertFalse(watcher.emitIncident);
    }

    @Test
    public void anAddDuringARunningSequenceIsListedButNotEnforcedTwice() {
        // Chrome has been on blocked.com since 40_000; the watcher starts a sequence at 49_900.
        history.recordHost("blocked.com", 40_000);
        c.onUrlRead("blocked.com", NOW_UPTIME - 100, false);
        assertTrue(c.sequenceActive(NOW_UPTIME));

        AddOutcome o = addAt(500); // capture instant 49_500: Chrome was on blocked.com
        // The add is accepted (a new dynamic entry), but the running sequence already owns the
        // enforcement and the incident, so nothing is started or emitted twice.
        assertTrue(o.listed);
        assertEquals(Enforcement.NONE, o.decision.enforcement);
        assertFalse(o.decision.emitIncident);
    }

    @Test
    public void listsBecomingReadyWhileTheCurrentHostIsBlockedStartsExactlyOneSequence()
            throws Exception {
        // F1 (review round 4): the child restarted SafeGuard while Chrome was already on a
        // blocked page. Before the static list finishes loading, the host isn't recognised yet.
        DomainLists notYetLoaded =
                new DomainLists(
                        new NeverBlockList(Arrays.asList("google.*")),
                        new File(tmp.getRoot(), "f1.txt"),
                        Runnable::run,
                        m -> {});
        HostHistory h = new HostHistory();
        BrowserBlockController cc = new BrowserBlockController(notYetLoaded, h, () -> overlay);
        h.recordHost("blocked.com", 1000);
        assertEquals(Enforcement.NONE, cc.onUrlRead("blocked.com", 1050, true).enforcement);

        // The list finishes loading while Chrome is still on the same page (the runtime's F1
        // re-check, modelled here as a forced re-read — the same call a Chrome window-state
        // change makes).
        notYetLoaded.load(asset("blocked.com\n"));
        Decision first = cc.onUrlRead("blocked.com", 1100, true);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, first.enforcement);
        assertTrue(first.emitIncident);
        assertTrue(cc.sequenceActive(1100));

        // A second forced re-check landing inside the same sequence (an ordinary window event
        // racing the F1 check) must not start a second sequence or emit a second incident.
        Decision second = cc.onUrlRead("blocked.com", 1150, true);
        assertEquals(Enforcement.NONE, second.enforcement);
        assertFalse(second.emitIncident);
    }

    // ---- leaveBlockedPage path (F2) -----------------------------------------------------------

    private LeaveOutcome leaveAt(long captureAgeMs) {
        return c.leaveBlockedPage(NOW_WALL - captureAgeMs, NOW_WALL, NOW_UPTIME);
    }

    @Test
    public void leaveNeverFallsBackToNow() {
        history.recordHost("fresh.com", 40_000);
        for (long ts : new long[] {0L, -5L}) {
            LeaveOutcome o = c.leaveBlockedPage(ts, NOW_WALL, NOW_UPTIME);
            assertFalse(o.left);
            assertEquals("no_capture_ts", o.reason);
        }
    }

    @Test
    public void leaveRefusesACaptureOlderThanTheMaxAge() {
        history.recordHost("fresh.com", 1_000);
        assertEquals("capture_too_old", leaveAt(30_001).reason);
    }

    @Test
    public void leaveRefusesWhenNoHostIsKnown() {
        LeaveOutcome o = leaveAt(2000);
        assertFalse(o.left);
        assertEquals("no_host", o.reason);
    }

    @Test
    public void leaveRefusesWhenTheCaptureWasNotOnChrome() {
        // Chrome was on a page, then the child switched to Instagram before the capture instant;
        // the frame that scored an OCR-only adult text hit must not be blamed on the last Chrome
        // host it happens to share history with.
        history.recordHost("some-site.com", 40_000);
        c.onForegroundPackage("com.instagram.android", 45_000);
        LeaveOutcome o = leaveAt(2000); // capture instant = 48_000, inside the Instagram period
        assertFalse(o.left);
        assertEquals("left_chrome", o.reason);
    }

    @Test
    public void leaveRefusesOnAHostChangeSinceTheCapture() {
        history.recordHost("first.com", 40_000);
        history.recordHost("second.com", 49_000); // after the capture at 48_000
        LeaveOutcome o = leaveAt(2000);
        assertFalse(o.left);
        assertEquals("host_changed_since_capture", o.reason);
    }

    @Test
    public void aValidLeaveStartsBackOnlyWithNoListWriteAndNoIncident() {
        history.recordHost("wordpage.com", 40_000);
        overlay = OverlayKind.NONE;
        LeaveOutcome o = leaveAt(2000);

        assertTrue(o.left);
        assertEquals("left", o.reason);
        assertEquals("wordpage.com", o.host);
        assertEquals(Enforcement.BACK_ONLY, o.decision.enforcement);
        assertFalse("no incident for a word-only detection", o.decision.emitIncident);
        assertNull("no domain — this is not a blacklist match", o.decision.incidentDomain);
        assertTrue(lists.dynamicSnapshot().isEmpty());
        assertNull("never touches the list", lists.match("wordpage.com"));
        assertTrue(c.sequenceActive(NOW_UPTIME));
    }

    @Test
    public void leaveSharesTheA5ReEntrancyGuardWithARunningWatcherSequence() {
        // The URL watcher already started a BACK_AND_BLOCK_SCREEN sequence for a listed host;
        // a leaveBlockedPage call landing inside it (e.g. the same OCR-only frame that also fed a
        // stale word match) must not start a second sequence.
        history.recordHost("blocked.com", 40_000);
        c.onUrlRead("blocked.com", NOW_UPTIME - 100, false);
        assertTrue(c.sequenceActive(NOW_UPTIME));

        LeaveOutcome o = leaveAt(500); // capture instant 49_500: Chrome was on blocked.com
        assertTrue(o.left);
        assertEquals("already_in_progress", o.reason);
        assertEquals(Enforcement.NONE, o.decision.enforcement);
        assertFalse(o.decision.emitIncident);
    }

    @Test
    public void aLeaveDuringARunningSequenceDoesNotExtendOrResetIt() {
        history.recordHost("blocked.com", 40_000);
        Decision first = c.onUrlRead("blocked.com", NOW_UPTIME - 100, false);
        long originalStart = NOW_UPTIME - 100;
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, first.enforcement);

        leaveAt(500); // absorbed by the A5 guard, must not restart the sequence clock
        long justBeforeOriginalCeiling = originalStart + BrowserBlockController.SEQUENCE_CEILING_MS - 1;
        assertTrue(c.sequenceActive(justBeforeOriginalCeiling));
        long atOriginalCeiling = originalStart + BrowserBlockController.SEQUENCE_CEILING_MS;
        assertFalse(c.sequenceActive(atOriginalCeiling));
    }

    @Test
    public void addBeforeTheListsAreLoadedIsRefused() throws Exception {
        DomainLists unloaded =
                new DomainLists(
                        new NeverBlockList(Arrays.asList("google.*")),
                        new File(tmp.getRoot(), "other.txt"),
                        Runnable::run,
                        m -> {});
        HostHistory h = new HostHistory();
        h.recordHost("fresh-adult.com", 40_000);
        BrowserBlockController cc = new BrowserBlockController(unloaded, h, () -> overlay);
        AddOutcome o = cc.addDetectedDomain(NOW_WALL - 2000, NOW_WALL, NOW_UPTIME);
        assertFalse(o.listed);
        assertEquals("lists_not_loaded", o.reason);
        assertNull(o.decision.incidentDomain);
    }
}
