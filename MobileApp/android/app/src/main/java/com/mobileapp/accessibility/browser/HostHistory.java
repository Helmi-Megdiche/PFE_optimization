package com.mobileapp.accessibility.browser;

import java.util.ArrayList;
import java.util.List;

/**
 * A small ring of the browser hosts recently seen in Chrome, used to attribute a screenshot to the
 * page that was on screen when it was taken.
 *
 * <p>Each entry is either a host, or {@code null} meaning "Chrome was not in the foreground from
 * this instant". The null entry is what stops an adult frame taken in Instagram from being blamed
 * on the last Chrome host. Entries are only appended on a CHANGE, so "any entry after the capture"
 * means "the page (or the foreground app) changed since the capture".
 *
 * <p>All methods are {@code synchronized}: the accessibility thread records and the RN bridge
 * thread reads. Times are {@code SystemClock.uptimeMillis()} values supplied by the caller.
 * Pure Java, no {@code android.*} imports.
 */
public final class HostHistory {

    public static final int CAPACITY = 10;

    public static final class Entry {
        /** Null = Chrome left the foreground. */
        public final String host;

        public final long sinceUptimeMs;

        Entry(String host, long sinceUptimeMs) {
            this.host = host;
            this.sinceUptimeMs = sinceUptimeMs;
        }
    }

    private final List<Entry> ring = new ArrayList<>();

    /** Records a host if it differs from the latest entry. Returns true if an entry was appended. */
    public synchronized boolean recordHost(String host, long nowUptime) {
        Entry latest = latest();
        if (latest != null && host.equals(latest.host)) {
            return false;
        }
        append(new Entry(host, nowUptime));
        return true;
    }

    /** Records that Chrome left the foreground, once. Returns true if an entry was appended. */
    public synchronized boolean recordLeftChrome(long nowUptime) {
        Entry latest = latest();
        if (latest != null && latest.host == null) {
            return false;
        }
        append(new Entry(null, nowUptime));
        return true;
    }

    public synchronized Entry latest() {
        return ring.isEmpty() ? null : ring.get(ring.size() - 1);
    }

    public synchronized int size() {
        return ring.size();
    }

    /** The last entry that began at or before {@code t}, or null if none is retained. */
    public synchronized Entry entryCoveringAt(long t) {
        Entry found = null;
        for (Entry e : ring) {
            if (e.sinceUptimeMs <= t) {
                found = e;
            } else {
                break;
            }
        }
        return found;
    }

    /** True if any entry began in {@code (fromExclusive, toInclusive]}. */
    public synchronized boolean anyEntryAfter(long fromExclusive, long toInclusive) {
        for (Entry e : ring) {
            if (e.sinceUptimeMs > fromExclusive && e.sinceUptimeMs <= toInclusive) {
                return true;
            }
        }
        return false;
    }

    private void append(Entry e) {
        ring.add(e);
        while (ring.size() > CAPACITY) {
            ring.remove(0);
        }
    }
}
