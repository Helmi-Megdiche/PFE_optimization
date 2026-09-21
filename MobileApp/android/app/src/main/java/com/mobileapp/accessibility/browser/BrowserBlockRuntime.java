package com.mobileapp.accessibility.browser;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import com.mobileapp.BuildConfig;
import com.mobileapp.accessibility.browser.BrowserBlockController.AddOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockController.Decision;
import com.mobileapp.accessibility.browser.BrowserBlockController.Enforcement;
import com.mobileapp.accessibility.browser.BrowserBlockController.OverlayKind;
import com.mobileapp.accessibility.browser.BrowserBlockController.SequenceStep;
import com.mobileapp.accessibility.AccessibilityEventBridge;
import com.mobileapp.overlay.OverlayService;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android glue for the Phase B browser blocker. Everything with rules lives in the pure,
 * JVM-tested classes ({@link BrowserBlockController}, {@link BrowserUrlWatcher}, ...); this class
 * only does what needs Android: load the lists from assets/filesDir, read Chrome's address-bar
 * node, and press Back/HOME on the main thread.
 *
 * <p><b>Privacy.</b> The only node ever read is Chrome's {@code url_bar}, and only its text and
 * focus flag. Only the normalised HOST (or the matched list domain) is ever logged; the raw
 * address-bar text, the path, the query and any field value are never logged or stored.
 *
 * <p><b>Threading.</b> Accessibility callbacks arrive on the main thread. {@code addDetectedDomain}
 * is called from the RN native-modules thread; the controller and lists are thread-safe, and any
 * Back/HOME press it causes is posted to the main thread.
 */
public final class BrowserBlockRuntime {

    private static final String TAG = "SafeGuardBrowser";
    private static final String URL_BAR_ID = "com.android.chrome:id/url_bar";

    /** R7: Back settles in ~280-300 ms on this ROM, so 400 ms is enough before re-reading. */
    private static final long REREAD_DELAY_MS = 400L;

    private static final long NOT_LOADED_LOG_INTERVAL_MS = 10_000L;
    private static final long IGNORED_COUNT_LOG_INTERVAL_MS = 60_000L;

    private final AccessibilityService service;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService writer =
            Executors.newSingleThreadExecutor(
                    r -> {
                        Thread t = new Thread(r, "SafeGuardBrowser-writer");
                        t.setDaemon(true);
                        return t;
                    });

    private final NeverBlockList neverBlock;
    private final DomainLists lists;
    private final HostHistory history = new HostHistory();
    private final BrowserBlockController controller;
    private final BrowserUrlWatcher watcher;

    private final BrowserUrlWatcher.UrlBarReader reader = this::readUrlBar;
    private final Runnable reReadTask = this::reRead;

    private long lastNotLoadedLogMs = Long.MIN_VALUE / 2;
    private long ignoredCount;
    private long ignoredWindowStartMs = SystemClock.uptimeMillis();
    private volatile boolean shutDown;

    public BrowserBlockRuntime(AccessibilityService service) throws IOException {
        this.service = service;
        try (InputStream in = service.getAssets().open("never_block_domains.json")) {
            this.neverBlock = NeverBlockList.load(in);
        }
        this.lists =
                new DomainLists(
                        neverBlock,
                        new File(service.getFilesDir(), "dynamic_blacklist.txt"),
                        writer,
                        msg -> Log.w(TAG, msg));
        this.controller =
                new BrowserBlockController(lists, history, BrowserBlockRuntime::currentOverlayKind);
        this.watcher = new BrowserUrlWatcher(controller);
    }

    /** What overlay is on screen (the block screen has its own kind, so it never counts as a mission). */
    private static OverlayKind currentOverlayKind() {
        OverlayService s = OverlayService.getRunningInstance();
        if (s == null) {
            return OverlayKind.NONE;
        }
        switch (s.getOverlayKind()) {
            case OverlayService.KIND_MISSION:
                return OverlayKind.MISSION;
            case OverlayService.KIND_BLOCK:
                return OverlayKind.BLOCK;
            default:
                return OverlayKind.NONE;
        }
    }

    // ---- loading --------------------------------------------------------------------------------

    /**
     * Loads the lists on a background thread. Until it finishes, nothing is blocked (logged).
     *
     * <p>R6 (measured on the test device): the static list is a {@link HashedDomainSet} (sorted
     * 64-bit hashes). A {@code HashSet<String>} of the same 76,774 domains cost ~3.9 MB and took
     * ~170 ms (470-560 ms during app start); the hashed set is ~0.8 MB and loads in ~80-115 ms.
     */
    public void startLoading() {
        Thread t =
                new Thread(
                        () -> {
                            try {
                                long startMs = SystemClock.elapsedRealtime();
                                try (InputStream in = service.getAssets().open("adult_domains.txt")) {
                                    lists.load(in);
                                }
                                Log.i(
                                        TAG,
                                        "lists loaded: static="
                                                + lists.staticSize()
                                                + " dynamic="
                                                + lists.dynamicSnapshot().size()
                                                + " loadMs="
                                                + (SystemClock.elapsedRealtime() - startMs));
                            } catch (Throwable e) {
                                Log.w(TAG, "list load failed — nothing will be blocked", e);
                            }
                        },
                        "SafeGuardBrowser-load");
        t.setDaemon(true);
        t.start();
    }

    public void shutdown() {
        shutDown = true;
        main.removeCallbacks(reReadTask);
        writer.shutdown();
    }

    // ---- accessibility events -------------------------------------------------------------------

    /**
     * {@code TYPE_WINDOW_CONTENT_CHANGED}. This event fires in EVERY app, so it goes ONLY here and
     * the watcher's first statement is the Chrome package check, before any node is touched.
     */
    public void onContentChanged(AccessibilityEvent event) {
        CharSequence raw = event.getPackageName();
        String pkg = raw == null ? null : raw.toString();
        boolean chrome = BrowserBlockController.CHROME_PACKAGE.equals(pkg);
        if (!chrome) {
            noteIgnored();
            return;
        }
        noteListsNotLoaded();
        Decision d = watcher.onWindowContentChanged(pkg, reader, SystemClock.uptimeMillis());
        execute(d, event.getEventTime());
    }

    /** A window-state change from {@code pkg} (own package already filtered by the service). */
    public void onWindowStateChanged(AccessibilityEvent event, String pkg) {
        if (BrowserBlockController.CHROME_PACKAGE.equals(pkg)) {
            noteListsNotLoaded();
        }
        Decision d = watcher.onWindowStateChanged(pkg, reader, SystemClock.uptimeMillis());
        execute(d, event.getEventTime());
    }

    /** Debug builds count (never identify) content events from other apps, to prove they are ignored. */
    private void noteIgnored() {
        if (!BuildConfig.DEBUG) {
            return;
        }
        ignoredCount++;
        long now = SystemClock.uptimeMillis();
        if (now - ignoredWindowStartMs >= IGNORED_COUNT_LOG_INTERVAL_MS) {
            Log.i(
                    TAG,
                    "content-changed ignored (non-Chrome): "
                            + ignoredCount
                            + " in "
                            + ((now - ignoredWindowStartMs) / 1000)
                            + "s");
            ignoredCount = 0;
            ignoredWindowStartMs = now;
        }
    }

    private void noteListsNotLoaded() {
        if (lists.isLoaded()) {
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastNotLoadedLogMs >= NOT_LOADED_LOG_INTERVAL_MS) {
            lastNotLoadedLogMs = now;
            Log.i(TAG, "lists not loaded yet — matching returns not-blocked");
        }
    }

    // ---- screenshot detection (called from the RN bridge thread in Task 6) --------------------

    /** Attribution + add for the frame captured at {@code captureTsWallMs}. Never throws. */
    public AddOutcome addDetectedDomain(long captureTsWallMs) {
        AddOutcome o =
                controller.addDetectedDomain(
                        captureTsWallMs, System.currentTimeMillis(), SystemClock.uptimeMillis());
        Log.i(
                TAG,
                "browser.add listed="
                        + o.listed
                        + " added="
                        + o.added
                        + " reason="
                        + o.reason
                        + (o.host != null ? " host=" + o.host : ""));
        final Decision d = o.decision;
        if (d.enforcement != Enforcement.NONE) {
            final long queuedAt = SystemClock.uptimeMillis();
            main.post(() -> execute(d, queuedAt));
        }
        return o;
    }

    // ---- enforcement ----------------------------------------------------------------------------

    private void execute(Decision d, long eventUptimeMs) {
        if (d.enforcement == Enforcement.NONE || shutDown) {
            return;
        }
        long latency = SystemClock.uptimeMillis() - eventUptimeMs;
        boolean back = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
        Log.i(
                TAG,
                "browser.block domain="
                        + d.incidentDomain
                        + " list="
                        + d.source
                        + " enforcement="
                        + d.enforcement
                        + " back="
                        + back
                        + " latencyMs="
                        + latency
                        + " incident="
                        + d.emitIncident);
        if (d.enforcement == Enforcement.BACK_AND_BLOCK_SCREEN) {
            requestBlockScreen(d);
        }
        if (d.emitIncident) {
            emitIncident(d);
        }
        main.removeCallbacks(reReadTask);
        main.postDelayed(reReadTask, REREAD_DELAY_MS);
    }

    /** Block screen via OverlayService; refused (logged) while a mission overlay is up. */
    private void requestBlockScreen(Decision d) {
        boolean shown = showBlockScreen();
        Log.i(TAG, "block screen " + (shown ? "shown" : "refused") + " for " + d.incidentDomain);
    }

    /** From JS (A1/B9): a listed adult site whose mission was not presented. */
    public boolean showBlockScreenFromJs() {
        boolean shown = showBlockScreen();
        Log.i(TAG, "block screen from JS " + (shown ? "shown" : "refused"));
        return shown;
    }

    private boolean showBlockScreen() {
        if (currentOverlayKind() == OverlayKind.MISSION) {
            return false; // a mission always wins over the block screen
        }
        try {
            android.content.Intent i = new android.content.Intent(service, OverlayService.class);
            i.setAction(OverlayService.ACTION_SHOW_BLOCK);
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                service.startForegroundService(i);
            } else {
                service.startService(i);
            }
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "block screen start failed", t);
            return false;
        }
    }

    /** {@code onBrowserBlocked {host, listSource, timestamp}} to JS (buffered, drop-oldest). Host only. */
    private void emitIncident(Decision d) {
        AccessibilityEventBridge.emitBrowserBlocked(
                d.incidentDomain,
                d.source == null ? "detected" : d.source.name().toLowerCase(java.util.Locale.ROOT),
                System.currentTimeMillis());
    }

    private void reRead() {
        if (shutDown) {
            return;
        }
        BrowserUrlWatcher.UrlBarRead read = readUrlBar();
        String host = read == null ? null : HostNormalizer.fromUrlBar(read.text, read.focused);
        SequenceStep step = controller.onReRead(host, SystemClock.uptimeMillis());
        switch (step) {
            case BACK_AGAIN:
                boolean back = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
                Log.i(TAG, "browser.block still blocked — Back again ok=" + back);
                main.postDelayed(reReadTask, REREAD_DELAY_MS);
                break;
            case HOME:
                boolean home = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
                Log.i(TAG, "browser.block still blocked — HOME ok=" + home);
                main.postDelayed(reReadTask, REREAD_DELAY_MS);
                break;
            default:
                break;
        }
    }

    // ---- the one node read ------------------------------------------------------------------------

    /** Chrome's address bar text + focus, or null. Reads no other node; the text is never logged. */
    private BrowserUrlWatcher.UrlBarRead readUrlBar() {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) {
            return null;
        }
        try {
            List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId(URL_BAR_ID);
            if (nodes == null || nodes.isEmpty()) {
                return null;
            }
            AccessibilityNodeInfo bar = nodes.get(0);
            CharSequence text = bar.getText();
            BrowserUrlWatcher.UrlBarRead read =
                    new BrowserUrlWatcher.UrlBarRead(
                            text == null ? null : text.toString(), bar.isFocused());
            for (AccessibilityNodeInfo n : nodes) {
                n.recycle();
            }
            return read;
        } finally {
            root.recycle();
        }
    }
}
