package com.mobileapp.accessibility;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityWindowInfo;

import com.mobileapp.accessibility.browser.BrowserBlockRuntime;

import java.util.List;

/**
 * Parallel, read-minimal event source for SafeGuard.
 *
 * <p>Emits three structured signals to JS via {@link AccessibilityEventBridge}:
 * foreground window/package changes, software-keyboard visibility changes, and
 * (throttled) scroll activity. Those three JS-facing signals carry package names and booleans
 * only.
 *
 * <p><b>Phase B exception (the only one).</b> {@link BrowserBlockRuntime} reads ONE node: Chrome's
 * address bar ({@code com.android.chrome:id/url_bar}), text and focus flag only, and only for
 * events whose package is Chrome. It keeps the host, never logs the raw text, and never reads
 * page content, other fields or passwords. {@code TYPE_WINDOW_CONTENT_CHANGED} is routed there
 * exclusively and never reaches the three handlers above.
 *
 * <p>Runs independently of the React Native lifecycle, hence the buffering bridge.
 */
public class SafeGuardAccessibilityService extends AccessibilityService {

    private static final String TAG = "SafeGuardA11y";

    /** At most one {@code onAccessibilityScroll} emission per this window. */
    private static final long SCROLL_THROTTLE_MS = 500L;

    /**
     * Minimum spacing between {@link #getWindows()} calls, as a backstop against
     * window-event bursts. {@code getWindows()} is a binder IPC to system_server.
     */
    private static final long WINDOWS_QUERY_MIN_INTERVAL_MS = 300L;

    /** Set on connect, cleared on unbind/destroy — lets the RN module query connection state. */
    public static volatile SafeGuardAccessibilityService instance;

    // All throttle arithmetic below uses SystemClock.uptimeMillis() (monotonic).
    // System.currentTimeMillis() is used ONLY for the emitted `timestamp` payload field.
    private String lastWindowPackage;
    private boolean lastImeVisible;
    private long lastScrollEmitMs;
    private long lastWindowsQueryMs;

    /** Phase B browser blocker; null if it failed to start. */
    private volatile BrowserBlockRuntime browser;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                | AccessibilityEvent.TYPE_WINDOWS_CHANGED
                | AccessibilityEvent.TYPE_VIEW_SCROLLED
                // Phase B: fires in every app. Routed ONLY to BrowserBlockRuntime (see
                // onAccessibilityEvent) — never to the window/scroll/keyboard handlers below.
                | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        info.notificationTimeout = 100;
        // Intentionally no packageNames — must observe all apps.
        setServiceInfo(info);

        instance = this;
        startBrowserBlocker();
        Log.i(TAG, "service connected");
    }

    /** Phase B. A failure here must never affect the existing window/keyboard/scroll events. */
    private void startBrowserBlocker() {
        try {
            if (browser != null) {
                browser.shutdown();
            }
            browser = new BrowserBlockRuntime(this);
            browser.startLoading();
        } catch (Throwable t) {
            browser = null;
            Log.w(TAG, "browser blocker unavailable", t);
        }
    }

    private void stopBrowserBlocker() {
        BrowserBlockRuntime b = browser;
        browser = null;
        if (b != null) {
            b.shutdown();
        }
    }

    /** For the RN bridge (Phase B): null when the blocker failed to start. */
    public BrowserBlockRuntime getBrowserBlocker() {
        return browser;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        try {
            final int type = event.getEventType();

            // Phase B: TYPE_WINDOW_CONTENT_CHANGED belongs to the browser blocker ONLY. Return
            // before anything below runs, so no window/keyboard/scroll handler (and nothing that
            // feeds JS capture triggers or the mission-lease backstop) ever sees it.
            if (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                BrowserBlockRuntime b = browser;
                if (b != null) {
                    b.onContentChanged(event);
                }
                return;
            }

            final long wallClock = System.currentTimeMillis();

            if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
                handleWindowStateChanged(event, wallClock);
            }

            // IME visibility is derived from window *type*, so only re-check it on
            // window events — NEVER on TYPE_VIEW_SCROLLED (that would fire a
            // getWindows() binder IPC dozens of times per second while scrolling).
            if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                    || type == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
                maybeCheckImeVisibility(wallClock);
            }

            if (type == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
                handleScroll(event, wallClock);
            }
        } catch (Throwable t) {
            // Never crash the host app from an accessibility callback.
            Log.w(TAG, "onAccessibilityEvent handler failed", t);
        }
    }

    private void handleWindowStateChanged(AccessibilityEvent event, long wallClock) {
        CharSequence raw = event.getPackageName();
        if (raw == null) {
            return;
        }
        String pkg = raw.toString();
        if (pkg.equals(getPackageName())) {
            return;
        }
        // Phase B: every foreground-window change reaches the browser blocker, including repeats
        // of the same package (a returning-to-Chrome state change forces a match) — so this sits
        // BEFORE the package-change dedupe below, which only serves the JS window event.
        BrowserBlockRuntime b = browser;
        if (b != null) {
            b.onWindowStateChanged(event, pkg);
        }
        if (pkg.equals(lastWindowPackage)) {
            return;
        }
        lastWindowPackage = pkg;
        // KNOWN CASE (handle in A3b when these events feed the capture coordinator):
        // when the soft keyboard opens, this branch often reports the IME's own
        // package (e.g. com.google.android.inputmethod.latin) and looks like an app
        // switch. Not filtered here on purpose so the smoke test can observe the
        // real packages that show up.
        AccessibilityEventBridge.emitWindowChanged(pkg, wallClock);
    }

    private void maybeCheckImeVisibility(long wallClock) {
        long now = SystemClock.uptimeMillis();
        if (now - lastWindowsQueryMs < WINDOWS_QUERY_MIN_INTERVAL_MS) {
            return;
        }
        lastWindowsQueryMs = now;

        boolean imeVisible = false;
        List<AccessibilityWindowInfo> windows = getWindows(); // single call, no loop
        if (windows != null) {
            for (AccessibilityWindowInfo w : windows) {
                if (w != null && w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                    imeVisible = true;
                    break;
                }
            }
        }

        if (imeVisible != lastImeVisible) {
            lastImeVisible = imeVisible;
            AccessibilityEventBridge.emitKeyboardChanged(imeVisible, wallClock);
        }
    }

    private void handleScroll(AccessibilityEvent event, long wallClock) {
        long now = SystemClock.uptimeMillis();
        if (now - lastScrollEmitMs < SCROLL_THROTTLE_MS) {
            return;
        }
        lastScrollEmitMs = now;
        CharSequence raw = event.getPackageName();
        String pkg = raw != null ? raw.toString() : "";
        AccessibilityEventBridge.emitScroll(pkg, wallClock);
    }

    @Override
    public void onInterrupt() {
        // No-op — this service does not provide interactive feedback.
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        stopBrowserBlocker();
        Log.i(TAG, "service unbound");
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        stopBrowserBlocker();
        Log.i(TAG, "service destroyed");
        super.onDestroy();
    }
}
