package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mobileapp.accessibility.browser.BrowserBlockController.Decision;
import com.mobileapp.accessibility.browser.BrowserBlockController.Enforcement;
import com.mobileapp.accessibility.browser.BrowserBlockController.OverlayKind;
import com.mobileapp.accessibility.browser.BrowserBlockController.SequenceStep;
import com.mobileapp.accessibility.browser.BrowserUrlWatcher.UrlBarRead;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class BrowserUrlWatcherTest {

    private static final String CHROME = "com.android.chrome";

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private DomainLists lists;
    private HostHistory history;
    private BrowserBlockController controller;
    private BrowserUrlWatcher watcher;

    /** Counts node reads and returns whatever the test sets. */
    private static final class FakeReader implements BrowserUrlWatcher.UrlBarReader {
        int reads;
        UrlBarRead next;

        @Override
        public UrlBarRead read() {
            reads++;
            return next;
        }
    }

    private static final BrowserUrlWatcher.UrlBarReader MUST_NOT_BE_CALLED =
            () -> {
                throw new AssertionError("a node was read for a non-Chrome package");
            };

    @Before
    public void setUp() throws Exception {
        lists =
                new DomainLists(
                        new NeverBlockList(Arrays.asList("google.*")),
                        new File(tmp.getRoot(), "dyn.txt"),
                        Runnable::run,
                        m -> {});
        lists.load(
                new ByteArrayInputStream("blocked.com\n".getBytes(StandardCharsets.UTF_8)));
        history = new HostHistory();
        controller = new BrowserBlockController(lists, history, () -> OverlayKind.NONE);
        watcher = new BrowserUrlWatcher(controller);
    }

    // ---- content-changed events from other apps do nothing ---------------------------------------

    @Test
    public void aContentChangedEventFromAnotherAppDoesNothingAndReadsNoNode() {
        for (String pkg :
                new String[] {
                    "com.instagram.android", "com.android.systemui", "com.mobileapp",
                    "com.android.chromium", "org.chromium.webview_shell", "", null
                }) {
            Decision d = watcher.onWindowContentChanged(pkg, MUST_NOT_BE_CALLED, 1000);
            assertEquals(String.valueOf(pkg), Enforcement.NONE, d.enforcement);
        }
        assertEquals("no history, no left-Chrome entry", 0, history.size());
        assertEquals(SequenceStep.DONE, controller.onReRead("blocked.com", 1000));
    }

    @Test
    public void aContentChangedEventFromAnotherAppDoesNotConsumeTheThrottleWindow() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("example.com", false);
        watcher.onWindowContentChanged("com.instagram.android", MUST_NOT_BE_CALLED, 1000);
        watcher.onWindowContentChanged(CHROME, r, 1010);
        assertEquals("the Chrome event right after must still be read", 1, r.reads);
    }

    // ---- Chrome content-changed events -------------------------------------------------------------

    @Test
    public void chromeContentChangedToABlockedHostIsEnforced() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("blocked.com/view?x=1", false);
        Decision d = watcher.onWindowContentChanged(CHROME, r, 1000);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, d.enforcement);
        assertEquals("blocked.com", d.incidentDomain);
        assertEquals("host only in history", "blocked.com", history.latest().host);
    }

    @Test
    public void readsAreThrottledToOnePerTwoHundredFiftyMs() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("example.com", false);
        watcher.onWindowContentChanged(CHROME, r, 1000);
        watcher.onWindowContentChanged(CHROME, r, 1100);
        watcher.onWindowContentChanged(CHROME, r, 1249);
        assertEquals(1, r.reads);
        watcher.onWindowContentChanged(CHROME, r, 1250);
        assertEquals(2, r.reads);
    }

    @Test
    public void aFocusedAddressBarIsSkippedEvenWhenItLooksLikeABlockedHost() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("blocked.com", true); // the child is typing, not on the page
        Decision d = watcher.onWindowContentChanged(CHROME, r, 1000);
        assertEquals(Enforcement.NONE, d.enforcement);
        assertEquals(0, history.size());
    }

    @Test
    public void aMissingOrNoneAddressBarIsNoChange() {
        FakeReader r = new FakeReader();
        r.next = null; // url_bar node not found
        assertEquals(
                Enforcement.NONE, watcher.onWindowContentChanged(CHROME, r, 1000).enforcement);
        r.next = new UrlBarRead("<none>", false);
        assertEquals(
                Enforcement.NONE, watcher.onWindowContentChanged(CHROME, r, 1300).enforcement);
        r.next = new UrlBarRead(null, false);
        assertEquals(
                Enforcement.NONE, watcher.onWindowContentChanged(CHROME, r, 1600).enforcement);
        assertEquals("no host, no null entry, no match", 0, history.size());
    }

    // ---- window state changes -----------------------------------------------------------------------

    @Test
    public void aStateChangeFromAnotherAppRecordsLeavingChrome() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("example.com", false);
        watcher.onWindowContentChanged(CHROME, r, 1000);
        Decision d = watcher.onWindowStateChanged("com.miui.home", MUST_NOT_BE_CALLED, 2000);
        assertEquals(Enforcement.NONE, d.enforcement);
        assertNull(history.latest().host);
    }

    @Test
    public void aChromeStateChangeForcesAMatchOnTheSameHost() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("blocked.com", false);
        Decision first = watcher.onWindowContentChanged(CHROME, r, 1000);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, first.enforcement);
        controller.onReRead(null, 1400); // sequence ends; the same host is now deduped
        assertEquals(
                Enforcement.NONE, watcher.onWindowContentChanged(CHROME, r, 1500).enforcement);

        // Returning to Chrome sends a state change with the same blocked page on screen.
        Decision forced = watcher.onWindowStateChanged(CHROME, r, 1600);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, forced.enforcement);
    }

    @Test
    public void reopenFromRecentsBlocksOnTheFirstContentEventEvenBeforeTheStateChange() {
        FakeReader r = new FakeReader();
        r.next = new UrlBarRead("blocked.com", false);
        watcher.onWindowContentChanged(CHROME, r, 1000);
        controller.onReRead(null, 1400);
        watcher.onWindowStateChanged("com.miui.home", MUST_NOT_BE_CALLED, 2000); // left Chrome

        // Recon: on reopen the first content-changed event arrives ~100 ms BEFORE the state change.
        Decision d = watcher.onWindowContentChanged(CHROME, r, 30000);
        assertEquals(Enforcement.BACK_AND_BLOCK_SCREEN, d.enforcement);
    }

    // ---- thread safety ----------------------------------------------------------------------------

    @Test
    public void watcherEventsAndAddsFromAnotherThreadDoNotCorruptState() throws Exception {
        final List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch done = new CountDownLatch(2);
        final FakeReader r = new FakeReader();

        Thread a11y =
                new Thread(
                        () -> {
                            try {
                                for (int i = 0; i < 2000; i++) {
                                    r.next =
                                            new UrlBarRead(
                                                    i % 2 == 0 ? "blocked.com" : "example.com",
                                                    false);
                                    long now = 10_000L + i * 300L;
                                    watcher.onWindowContentChanged(CHROME, r, now);
                                    controller.onReRead("example.com", now + 10);
                                    if (i % 50 == 0) {
                                        watcher.onWindowStateChanged("com.miui.home", null, now);
                                    }
                                }
                            } catch (Throwable t) {
                                errors.add(t);
                            } finally {
                                done.countDown();
                            }
                        });
        Thread rn =
                new Thread(
                        () -> {
                            try {
                                for (int i = 0; i < 2000; i++) {
                                    controller.addDetectedDomain(
                                            1_000_000L - 500, 1_000_000L, 700_000L + i);
                                }
                            } catch (Throwable t) {
                                errors.add(t);
                            } finally {
                                done.countDown();
                            }
                        });
        a11y.start();
        rn.start();
        assertTrue(done.await(30, TimeUnit.SECONDS));
        assertTrue("errors: " + errors, errors.isEmpty());
        assertNotNull(history.latest());
    }
}
