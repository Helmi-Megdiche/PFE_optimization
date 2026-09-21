package com.mobileapp.accessibility.browser;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Domain matching for the browser blocker: walks a host up its labels
 * ({@code a.b.example.com -> b.example.com -> example.com}) and stops before a bare public
 * suffix, so a list entry such as {@code com} or {@code co.uk} can never block a whole TLD.
 *
 * <p>Pure Java, no {@code android.*} imports.
 */
public final class DomainMatcher {

    public enum ListSource {
        STATIC,
        DETECTED
    }

    /** The list entry that matched and which list it came from. */
    public static final class Match {
        public final String domain;
        public final ListSource source;

        Match(String domain, ListSource source) {
            this.domain = domain;
            this.source = source;
        }
    }

    /**
     * Minimal two-part public suffixes: for these, the registrable domain has three labels
     * ({@code example.co.uk}). Deliberately small, not the full public suffix list; keep in sync
     * with {@code TWO_PART_SUFFIXES} in scripts/build-adult-list.js (AdultAssetTest cross-checks).
     */
    private static final Set<String> TWO_PART_SUFFIXES =
            new HashSet<>(
                    Arrays.asList(
                            "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.tn", "org.tn",
                            "gov.tn", "nat.tn", "com.au", "net.au", "org.au", "co.jp", "ne.jp",
                            "or.jp", "com.br", "net.br", "co.in", "net.in", "org.in", "com.eg",
                            "com.sa", "co.za", "com.tr", "com.mx", "co.nz", "com.ar", "com.co",
                            "com.cn", "com.hk", "com.sg", "com.my", "com.pk", "co.id", "co.kr",
                            "com.ua", "com.ng"));

    private DomainMatcher() {}

    public static boolean isTwoPartSuffix(String suffix) {
        return suffix != null && TWO_PART_SUFFIXES.contains(suffix);
    }

    /** Fewest labels a matchable domain may have: 2, or 3 under a two-part suffix. */
    private static int minLabels(String[] labels) {
        int n = labels.length;
        if (n >= 2 && isTwoPartSuffix(labels[n - 2] + "." + labels[n - 1])) {
            return 3;
        }
        return 2;
    }

    /**
     * The registrable domain of {@code host} ({@code www.pornhub.com -> pornhub.com},
     * {@code a.example.co.uk -> example.co.uk}), or {@code null} when the host is a single label
     * or is itself a bare public suffix.
     */
    public static String registrable(String host) {
        if (host == null || host.isEmpty()) {
            return null;
        }
        String[] labels = host.split("\\.", -1);
        int min = minLabels(labels);
        if (labels.length < min) {
            return null;
        }
        return join(labels, labels.length - min);
    }

    /**
     * Walks {@code host} up to its registrable domain, checking each candidate against the static
     * list first and then the detected list. Returns the first (most specific) hit, or null.
     */
    public static Match match(String host, Set<String> stat, Set<String> dyn) {
        if (host == null || host.isEmpty()) {
            return null;
        }
        String[] labels = host.split("\\.", -1);
        int min = minLabels(labels);
        if (labels.length < min) {
            return null;
        }
        for (int start = 0; labels.length - start >= min; start++) {
            String candidate = join(labels, start);
            if (stat != null && stat.contains(candidate)) {
                return new Match(candidate, ListSource.STATIC);
            }
            if (dyn != null && dyn.contains(candidate)) {
                return new Match(candidate, ListSource.DETECTED);
            }
        }
        return null;
    }

    private static String join(String[] labels, int from) {
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < labels.length; i++) {
            if (i > from) {
                sb.append('.');
            }
            sb.append(labels[i]);
        }
        return sb.toString();
    }
}
