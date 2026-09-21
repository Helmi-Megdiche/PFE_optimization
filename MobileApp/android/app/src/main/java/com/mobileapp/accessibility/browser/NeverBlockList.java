package com.mobileapp.accessibility.browser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Domains that must never be blacklisted: search engines, social networks, messaging, Wikipedia.
 * Loaded from {@code assets/never_block_domains.json}, the single source that the list-build
 * script also reads.
 *
 * <p>An entry covers the domain and its subdomains. An entry ending in {@code .*}
 * ({@code google.*}) covers the label followed by a one-label TLD or a known two-part suffix
 * ({@code google.com}, {@code google.co.uk}, {@code google.com.tn}, but not
 * {@code google.porno.sexy}).
 *
 * <p>Pure Java, no {@code android.*} imports (so no {@code org.json}: the file is a flat array
 * of strings).
 */
public final class NeverBlockList {

    private static final Pattern QUOTED = Pattern.compile("\"([^\"]+)\"");

    private final List<String> entries;

    public NeverBlockList(Collection<String> entries) {
        List<String> copy = new ArrayList<>();
        for (String e : entries) {
            if (e != null && !e.trim().isEmpty()) {
                copy.add(e.trim().toLowerCase(java.util.Locale.ROOT));
            }
        }
        this.entries = copy;
    }

    /** Parses a flat JSON array of strings, e.g. {@code ["google.*", "bing.com"]}. */
    public static NeverBlockList parse(String json) {
        List<String> found = new ArrayList<>();
        Matcher m = QUOTED.matcher(json);
        while (m.find()) {
            found.add(m.group(1));
        }
        return new NeverBlockList(found);
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

    public int size() {
        return entries.size();
    }

    public boolean covers(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String[] labels = host.toLowerCase(java.util.Locale.ROOT).split("\\.", -1);
        String lower = host.toLowerCase(java.util.Locale.ROOT);
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
}
