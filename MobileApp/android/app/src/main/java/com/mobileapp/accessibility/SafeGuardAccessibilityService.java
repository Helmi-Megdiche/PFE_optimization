package com.mobileapp.accessibility;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

/**
 * Parallel, read-minimal event source for SafeGuard.
 *
 * <p>Emits three structured signals to JS via {@link AccessibilityEventBridge}:
 * foreground window/package changes, software-keyboard visibility changes, and
 * (throttled) scroll activity. It never reads node text, {@code AccessibilityNodeInfo}
 * content, URLs, or field values — package names and booleans only. Nothing consumes
 * these events yet; this class only establishes and proves the stream.
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

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                | AccessibilityEvent.TYPE_WINDOWS_CHANGED
                | AccessibilityEvent.TYPE_VIEW_SCROLLED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        info.notificationTimeout = 100;
        // Intentionally no packageNames — must observe all apps.
        setServiceInfo(info);

        instance = this;
        Log.i(TAG, "service connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        try {
            final int type = event.getEventType();
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
        Log.i(TAG, "service unbound");
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        Log.i(TAG, "service destroyed");
        super.onDestroy();
    }
}
