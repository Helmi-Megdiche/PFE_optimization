package com.mobileapp.accessibility.browser;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import com.mobileapp.BuildConfig;
import com.mobileapp.accessibility.browser.BrowserBlockController.AddOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockController.Decision;
import com.mobileapp.accessibility.browser.BrowserBlockController.Enforcement;
import com.mobileapp.accessibility.browser.BrowserBlockController.LeaveOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockController.OverlayKind;
import com.mobileapp.accessibility.browser.BrowserBlockController.SequenceStep;
import com.mobileapp.accessibility.AccessibilityEventBridge;
import com.mobileapp.overlay.OverlayService;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collection;
import java.util.List;
import java.util.Set;
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

    /**
     * Device finding (Task 9): a covering overlay makes Chrome's window unreadable, so the block screen
     * is shown only when the Back -> re-read -> Back -> HOME sequence has settled, never up front.
     * Main thread only.
     */
    private String pendingBlockDomain;

    private final File devMarker;
    private boolean devStaticDisabled;

    private long lastNotLoadedLogMs = Long.MIN_VALUE / 2;
    private long ignoredCount;
    private long ignoredWindowStartMs = SystemClock.uptimeMillis();
    private volatile boolean shutDown;

    public BrowserBlockRuntime(AccessibilityService service) throws IOException {
        this.service = service;
        try (InputStream in = service.getAssets().open("never_block_domains.json")) {
            this.neverBlock = NeverBlockList.load(in);
        }
        this.devMarker = new File(service.getFilesDir(), DevStaticSwitch.MARKER_FILE_NAME);
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
                                main.post(this::checkCurrentChromePage);
                            } catch (Throwable e) {
                                Log.w(TAG, "list load failed — nothing will be blocked", e);
                            }
                        },
                        "SafeGuardBrowser-load");
        t.setDaemon(true);
        t.start();
        // Defensive: if the lists were somehow already loaded when this runtime was built (not
        // reachable today — a fresh DomainLists starts unloaded every time — but kept so a future
        // change that reuses lists across restarts doesn't silently lose this check).
        if (lists.isLoaded()) {
            main.post(this::checkCurrentChromePage);
        }
    }

    /**
     * F1 (review round 4, device finding): a child who restarts SafeGuard, or opens it for the
     * first time, while Chrome already sits on a blocked page must not get a free pass until the
     * page's content next changes. Runs once the static list is ready (from {@link #startLoading}),
     * main thread only. Reads no node beyond the active window's package name unless that window is
     * Chrome, in which case it makes the one normal url_bar read every Chrome window-state change
     * already makes.
     */
    private void checkCurrentChromePage() {
        if (shutDown || !isChromeTheActiveWindow()) {
            return;
        }
        Decision d =
                watcher.onWindowStateChanged(
                        BrowserBlockController.CHROME_PACKAGE, reader, SystemClock.uptimeMillis());
        execute(d, SystemClock.uptimeMillis());
    }

    /** True iff the currently active window's package is Chrome. */
    private boolean isChromeTheActiveWindow() {
        List<AccessibilityWindowInfo> windows = service.getWindows();
        if (windows == null) {
            return false;
        }
        for (AccessibilityWindowInfo w : windows) {
            if (w == null || !w.isActive()) {
                continue;
            }
            AccessibilityNodeInfo root = w.getRoot();
            if (root == null) {
                return false;
            }
            try {
                CharSequence pkg = root.getPackageName();
                return pkg != null && BrowserBlockController.CHROME_PACKAGE.contentEquals(pkg);
            } finally {
                root.recycle();
            }
        }
        return false;
    }

    public void shutdown() {
        shutDown = true;
        main.removeCallbacks(reReadTask);
        pendingBlockDomain = null;
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
        applyDevSwitch();
        Decision d = watcher.onWindowContentChanged(pkg, reader, SystemClock.uptimeMillis());
        execute(d, event.getEventTime());
    }

    /** A window-state change from {@code pkg} (own package already filtered by the service). */
    public void onWindowStateChanged(AccessibilityEvent event, String pkg) {
        if (BrowserBlockController.CHROME_PACKAGE.equals(pkg)) {
            noteListsNotLoaded();
            applyDevSwitch();
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

    /**
     * DEBUG BUILDS ONLY: a marker file in filesDir turns the static list off (device step 2). In a
     * release build BuildConfig.DEBUG is a false compile-time constant, so the file is never read.
     * Only Chrome events reach here, so this is at most a few File.exists() calls a second.
     */
    private void applyDevSwitch() {
        if (!BuildConfig.DEBUG) {
            return;
        }
        boolean disabled =
                DevStaticSwitch.staticListDisabled(BuildConfig.DEBUG, devMarker.exists());
        if (disabled != devStaticDisabled) {
            devStaticDisabled = disabled;
            lists.setStaticEnabled(!disabled);
            Log.w(TAG, "DEV: static adult list " + (disabled ? "DISABLED" : "re-enabled"));
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

    /**
     * F2: an OCR-only adult detection in Chrome — send the child back one page, no list write, no
     * incident. Never throws.
     */
    public LeaveOutcome leaveBlockedPage(long captureTsWallMs) {
        LeaveOutcome o =
                controller.leaveBlockedPage(
                        captureTsWallMs, System.currentTimeMillis(), SystemClock.uptimeMillis());
        Log.i(
                TAG,
                "browser.leave left="
                        + o.left
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

    // ---- device sync (Task 11, called from the RN bridge thread) ------------------------------

    /**
     * The dynamic list as it stands right now, for the one-time backfill POST. Empty (never null)
     * if the lists haven't loaded yet — the caller just backfills nothing that round.
     */
    public Set<String> getDynamicDomains() {
        return lists.dynamicSnapshot();
    }

    /**
     * Replaces the dynamic list with the server's current active set — additions AND parent
     * removals both take effect via {@link DomainLists#replaceDynamic}, a full snapshot rewrite.
     * A no-op (logged) if the lists aren't loaded yet, so a sync racing app start can't overwrite
     * a real file with an empty one.
     */
    public void syncBlockedDomains(Collection<String> domains) {
        if (!lists.isLoaded()) {
            Log.w(TAG, "sync skipped — lists not loaded yet");
            return;
        }
        lists.replaceDynamic(domains);
        Log.i(TAG, "sync applied: dynamic=" + lists.dynamicSnapshot().size());
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
            pendingBlockDomain = d.incidentDomain;
        }
        if (d.emitIncident) {
            emitIncident(d);
        }
        main.removeCallbacks(reReadTask);
        main.postDelayed(reReadTask, REREAD_DELAY_MS);
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
        // Read Chrome's own window (not the active one): the active window can be a system or
        // overlay surface. The block screen is not up yet (see pendingBlockDomain), so Chrome is readable.
        BrowserUrlWatcher.UrlBarRead read = readChromeWindowUrlBar();
        String host = read == null ? null : HostNormalizer.fromUrlBar(read.text, read.focused);
        SequenceStep step = controller.onReRead(host, SystemClock.uptimeMillis());
        Log.i(
                TAG,
                "browser.reread "
                        + (read == null ? "chrome-window-unreadable" : host == null ? "no-host" : "host=" + host)
                        + " step="
                        + step);
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
                showPendingBlockScreen();
                break;
        }
    }

    /** The sequence is over (Chrome left the blocked page, or Back/Back/HOME ran): now cover the screen. */
    private void showPendingBlockScreen() {
        String domain = pendingBlockDomain;
        pendingBlockDomain = null;
        if (domain != null && !shutDown) {
            boolean shown = showBlockScreen();
            Log.i(TAG, "block screen " + (shown ? "shown" : "refused") + " for " + domain);
        }
    }

    // ---- the one node read ------------------------------------------------------------------------

    /**
     * The address bar of Chrome's own window even when another window (our block screen) is on top.
     * Only a window whose root package is Chrome is ever opened; every other window is skipped
     * without reading a node.
     */
    private BrowserUrlWatcher.UrlBarRead readChromeWindowUrlBar() {
        List<AccessibilityWindowInfo> windows = service.getWindows();
        if (windows != null) {
            for (AccessibilityWindowInfo w : windows) {
                if (w == null) {
                    continue;
                }
                AccessibilityNodeInfo root = w.getRoot();
                if (root == null) {
                    continue;
                }
                try {
                    CharSequence pkg = root.getPackageName();
                    if (pkg != null
                            && BrowserBlockController.CHROME_PACKAGE.contentEquals(pkg)) {
                        return readUrlBarFrom(root);
                    }
                } finally {
                    root.recycle();
                }
            }
        }
        return null;
    }

    /** Chrome's address bar text + focus, or null. Reads no other node; the text is never logged. */
    private BrowserUrlWatcher.UrlBarRead readUrlBar() {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) {
            return null;
        }
        try {
            return readUrlBarFrom(root);
        } finally {
            root.recycle();
        }
    }

    private static BrowserUrlWatcher.UrlBarRead readUrlBarFrom(AccessibilityNodeInfo root) {
        {
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
        }
    }
}
