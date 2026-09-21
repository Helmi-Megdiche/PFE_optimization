package com.mobileapp.accessibility.browser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Two lists from {@code assets/never_block_domains.json}, the single source that the list-build
 * script and {@code AdultAssetTest} also read.
 *
 * <p><b>{@code neverBlock}</b>: domains that must never be blacklisted (search engines, social
 * networks, messaging, Wikipedia). An entry covers the domain and its subdomains. An entry ending
 * in {@code .*} ({@code google.*}) covers the label followed by a one-label TLD or a known
 * two-part suffix ({@code google.com}, {@code google.co.uk}, {@code google.com.tn}, but not
 * {@code google.porno.sexy}).
 *
 * <p><b>{@code exactHostOnly}</b>: shared-hosting platforms ({@code blogspot.com},
 * {@code github.io}, ...). Every subdomain there is a different person's site, so a detection
 * stores the exact host, never the platform. The bare suffix itself is never stored.
 *
 * <p>Pure Java, no {@code android.*} imports (so no {@code org.json}: the file is two flat arrays
 * of strings).
 */
public final class NeverBlockList {

    private static final Pattern QUOTED = Pattern.compile("\"([^\"]+)\"");
    private static final Pattern NEVER_BLOCK_SECTION =
            Pattern.compile("\"neverBlock\"\\s*:\\s*\\[([^\\]]*)\\]");
    private static final Pattern EXACT_HOST_SECTION =
            Pattern.compile("\"exactHostOnly\"\\s*:\\s*\\[([^\\]]*)\\]");

    private final List<String> entries;
    private final List<String> exactHostOnly;

    public NeverBlockList(Collection<String> neverBlock) {
        this(neverBlock, Collections.<String>emptyList());
    }

    public NeverBlockList(Collection<String> neverBlock, Collection<String> exactHostOnly) {
        this.entries = clean(neverBlock);
        this.exactHostOnly = clean(exactHostOnly);
    }

    private static List<String> clean(Collection<String> in) {
        List<String> copy = new ArrayList<>();
        for (String e : in) {
            if (e != null && !e.trim().isEmpty()) {
                copy.add(e.trim().toLowerCase(Locale.ROOT));
            }
        }
        return copy;
    }

    /**
     * Parses {@code {"neverBlock": [...], "exactHostOnly": [...]}}. A bare flat array of strings
     * is also accepted and read as {@code neverBlock}.
     */
    public static NeverBlockList parse(String json) {
        Matcher never = NEVER_BLOCK_SECTION.matcher(json);
        Matcher exact = EXACT_HOST_SECTION.matcher(json);
        if (never.find()) {
            List<String> shared =
                    exact.find() ? quoted(exact.group(1)) : Collections.<String>emptyList();
            return new NeverBlockList(quoted(never.group(1)), shared);
        }
        return new NeverBlockList(quoted(json));
    }

    private static List<String> quoted(String text) {
        List<String> found = new ArrayList<>();
        Matcher m = QUOTED.matcher(text);
        while (m.find()) {
            found.add(m.group(1));
        }
        return found;
    }

    public static NeverBlockList load(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
        }
        return parse(new String(buf.toByteArray(), StandardCharsets.UTF_8));
    }

    /** Number of {@code neverBlock} entries. */
    public int size() {
        return entries.size();
    }

    public int exactHostOnlySize() {
        return exactHostOnly.size();
    }

    public boolean covers(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String lower = host.toLowerCase(Locale.ROOT);
        String[] labels = lower.split("\\.", -1);
        for (String entry : entries) {
            if (entry.endsWith(".*")) {
                String name = entry.substring(0, entry.length() - 2);
                for (int i = 0; i < labels.length; i++) {
                    if (!labels[i].equals(name)) {
                        continue;
                    }
                    int rest = labels.length - i - 1;
                    if (rest == 1) {
                        return true;
                    }
                    if (rest == 2
                            && DomainMatcher.isTwoPartSuffix(
                                    labels[labels.length - 2] + "." + labels[labels.length - 1])) {
                        return true;
                    }
                }
            } else if (lower.equals(entry) || lower.endsWith("." + entry)) {
                return true;
            }
        }
        return false;
    }

    /** True for a shared-hosting suffix and every host under it. */
    public boolean isSharedHost(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String lower = host.toLowerCase(Locale.ROOT);
        for (String suffix : exactHostOnly) {
            if (lower.equals(suffix) || lower.endsWith("." + suffix)) {
                return true;
            }
        }
        return false;
    }

    /** True only for the bare shared-hosting suffix (never stored, never a list entry). */
    public boolean isSharedSuffix(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        return exactHostOnly.contains(host.toLowerCase(Locale.ROOT));
    }
}
