package com.mobileapp.accessibility.browser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.AbstractSet;
import java.util.Arrays;
import java.util.Iterator;

/**
 * An immutable set of domains stored as a sorted array of 64-bit hashes, looked up by binary
 * search. Replaces a {@code HashSet<String>} for the ~77k-entry static adult list (R6): the String
 * set cost ~6.7 MB and ~470-560 ms to build on the test device, mostly from creating a String per
 * line. {@link #fromLines} hashes the asset's raw bytes and never builds a per-line String.
 *
 * <p>Only the hashes are kept, so it cannot be iterated. A 64-bit hash colliding with a different
 * host is ~77k / 2^64 per lookup, which is negligible; the set is only ever consulted with
 * normalised (lowercase) hosts. Both {@link #hash(String)} and {@link #fromLines} hash the UTF-8
 * bytes, so they always agree. Pure Java, no {@code android.*} imports.
 */
public final class HashedDomainSet extends AbstractSet<String> {

    private static final long FNV_OFFSET = 0xcbf29ce484222325L;
    private static final long FNV_PRIME = 0x100000001b3L;

    private final long[] sorted;

    private HashedDomainSet(long[] sorted) {
        this.sorted = sorted;
    }

    private static long mix(long h) {
        h ^= h >>> 33;
        h *= 0xff51afd7ed558ccdL;
        h ^= h >>> 33;
        h *= 0xc4ceb9fe1a85ec53L;
        h ^= h >>> 33;
        return h;
    }

    /** FNV-1a over the UTF-8 bytes, then a 64-bit avalanche so near-identical hosts spread out. */
    public static long hash(String s) {
        long h = FNV_OFFSET;
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            h ^= (b & 0xff);
            h *= FNV_PRIME;
        }
        return mix(h);
    }

    /**
     * Reads one domain per line. Skips blank lines and {@code #} comments, trims spaces and CR,
     * lowercases ASCII letters, and dedupes. Hashes bytes in place: no String per line.
     */
    public static HashedDomainSet fromLines(InputStream in) throws IOException {
        ByteArrayOutputStream all = new ByteArrayOutputStream(Math.max(in.available(), 4096));
        byte[] chunk = new byte[16 * 1024];
        int n;
        while ((n = in.read(chunk)) > 0) {
            all.write(chunk, 0, n);
        }
        byte[] data = all.toByteArray();

        long[] buf = new long[8192];
        int count = 0;
        int len = data.length;
        int pos = 0;
        while (pos < len) {
            int lineEnd = pos;
            while (lineEnd < len && data[lineEnd] != '\n') {
                lineEnd++;
            }
            int s = pos;
            while (s < lineEnd && (data[s] & 0xff) <= ' ') {
                s++;
            }
            int e = lineEnd;
            while (e > s && (data[e - 1] & 0xff) <= ' ') {
                e--;
            }
            if (e > s && data[s] != '#') {
                long h = FNV_OFFSET;
                for (int i = s; i < e; i++) {
                    int b = data[i] & 0xff;
                    if (b >= 'A' && b <= 'Z') {
                        b |= 0x20;
                    }
                    h ^= b;
                    h *= FNV_PRIME;
                }
                if (count == buf.length) {
                    buf = Arrays.copyOf(buf, count * 2);
                }
                buf[count++] = mix(h);
            }
            pos = lineEnd + 1;
        }
        return sortedUnique(buf, count);
    }

    private static HashedDomainSet sortedUnique(long[] buf, int count) {
        long[] a = Arrays.copyOf(buf, count);
        Arrays.sort(a);
        int unique = 0;
        for (int i = 0; i < a.length; i++) {
            if (i == 0 || a[i] != a[i - 1]) {
                a[unique++] = a[i];
            }
        }
        return new HashedDomainSet(Arrays.copyOf(a, unique));
    }

    @Override
    public boolean contains(Object o) {
        if (!(o instanceof String)) {
            return false;
        }
        return Arrays.binarySearch(sorted, hash((String) o)) >= 0;
    }

    @Override
    public int size() {
        return sorted.length;
    }

    @Override
    public Iterator<String> iterator() {
        throw new UnsupportedOperationException("only hashes are stored");
    }

    public static final class Builder {
        private long[] buf = new long[1024];
        private int n;

        public Builder add(String domain) {
            if (n == buf.length) {
                buf = Arrays.copyOf(buf, n * 2);
            }
            buf[n++] = hash(domain);
            return this;
        }

        public HashedDomainSet build() {
            return sortedUnique(buf, n);
        }
    }
}
