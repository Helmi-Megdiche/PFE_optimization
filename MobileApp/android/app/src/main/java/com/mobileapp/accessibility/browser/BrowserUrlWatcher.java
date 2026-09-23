package com.mobileapp.accessibility.browser;

import com.mobileapp.accessibility.browser.BrowserBlockController.Decision;

/**
 * The only place accessibility events reach the browser blocker. It keeps
 * {@code TYPE_WINDOW_CONTENT_CHANGED} away from every other handler and guarantees the two rules
 * that make reading another app's address bar acceptable:
 *
 * <ul>
 *   <li>the Chrome package check is the FIRST statement, before any node is touched (this event
 *       fires in every app on the device), and a non-Chrome event neither reads a node nor consumes
 *       the throttle window;
 *   <li>a focused address bar (the child is typing) and an unreadable one are never a host.
 * </ul>
 *
 * <p>The service supplies a {@link UrlBarReader} that does the actual node access, so this class
 * stays pure Java and testable on the JVM.
 */
public final class BrowserUrlWatcher {

    /** At most one address-bar read per this window ({@code SystemClock.uptimeMillis()}). */
    public static final long READ_THROTTLE_MS = 250L;

    /** What the address bar showed: its text and whether it had input focus. */
    public static final class UrlBarRead {
        public final String text;
        public final boolean focused;

        public UrlBarRead(String text, boolean focused) {
            this.text = text;
            this.focused = focused;
        }
    }

    /** Reads Chrome's {@code url_bar} node. Returns null when the node is not found. */
    public interface UrlBarReader {
        UrlBarRead read();
    }

    private final BrowserBlockController controller;
    private long lastReadUptime = Long.MIN_VALUE / 2;

    public BrowserUrlWatcher(BrowserBlockController controller) {
        this.controller = controller;
    }

    /** A {@code TYPE_WINDOW_CONTENT_CHANGED} event from {@code pkg}. */
    public Decision onWindowContentChanged(String pkg, UrlBarReader reader, long nowUptime) {
        if (!BrowserBlockController.CHROME_PACKAGE.equals(pkg)) {
            return Decision.NONE; // first statement: no node access for any other app
        }
        if (nowUptime - lastReadUptime < READ_THROTTLE_MS) {
            return Decision.NONE;
        }
        lastReadUptime = nowUptime;
        return readAndMatch(reader, nowUptime, false);
    }

    /**
     * A {@code TYPE_WINDOW_STATE_CHANGED} event from {@code pkg}. Another app recording "left
     * Chrome"; Chrome itself forces a match even for an unchanged host (returning to Chrome).
     */
    public Decision onWindowStateChanged(String pkg, UrlBarReader reader, long nowUptime) {
        if (!BrowserBlockController.CHROME_PACKAGE.equals(pkg)) {
            controller.onForegroundPackage(pkg, nowUptime);
            return Decision.NONE;
        }
        controller.onForegroundPackage(pkg, nowUptime);
        lastReadUptime = nowUptime;
        return readAndMatch(reader, nowUptime, true);
    }

    private Decision readAndMatch(UrlBarReader reader, long nowUptime, boolean force) {
        UrlBarRead read = reader.read();
        if (read == null) {
            return Decision.NONE;
        }
        String host = HostNormalizer.fromUrlBar(read.text, read.focused);
        if (host == null) {
            return Decision.NONE;
        }
        return controller.onUrlRead(host, nowUptime, force);
    }
}
