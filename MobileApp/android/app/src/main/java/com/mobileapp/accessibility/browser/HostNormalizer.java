package com.mobileapp.accessibility.browser;

import java.util.Locale;

/**
 * Turns the text of Chrome's address bar into a bare host, or {@code null} when the text is not
 * a loaded page's host.
 *
 * <p>Privacy (Phase B): only the host ever leaves this class. The path, query and fragment are
 * dropped here, at the first opportunity, and are never logged or stored.
 *
 * <p>Pure Java, no {@code android.*} imports, so it runs in JVM unit tests.
 */
public final class HostNormalizer {

    private HostNormalizer() {}

    /**
     * The read the accessibility service actually uses. While the address bar is focused the
     * child is typing, and the text (for example a half-typed {@code example.net}) is not a
     * loaded page, so it must never yield a host.
     */
    public static String fromUrlBar(String text, boolean focused) {
        if (focused) {
            return null;
        }
        return toHost(text);
    }

    /** Lowercased host without scheme, userinfo, port, path, query, fragment or trailing dot. */
    public static String toHost(String text) {
        if (text == null) {
            return null;
        }
        String s = text.trim();
        if (s.isEmpty()) {
            return null;
        }
        for (int i = 0; i < s.length(); i++) {
            if (Character.isWhitespace(s.charAt(i))) {
                return null; // "Search Google or type URL", "example.net foo"
            }
        }

        int schemeEnd = s.indexOf("://");
        if (schemeEnd > 0) {
            s = s.substring(schemeEnd + 3);
        }

        // Keep only the authority: drop path, query and fragment first, so an '@' or ':' that
        // appears later in the URL can never be mistaken for userinfo or a port.
        int cut = firstIndexOfAny(s, "/?#");
        if (cut >= 0) {
            s = s.substring(0, cut);
        }

        int at = s.lastIndexOf('@');
        if (at >= 0) {
            s = s.substring(at + 1);
        }

        if (s.startsWith("[")) {
            return null; // IPv6 literal, not a domain
        }

        int colon = s.lastIndexOf(':');
        if (colon >= 0) {
            String port = s.substring(colon + 1);
            for (int i = 0; i < port.length(); i++) {
                if (!Character.isDigit(port.charAt(i))) {
                    return null;
                }
            }
            s = s.substring(0, colon);
        }

        s = s.toLowerCase(Locale.ROOT);
        while (s.endsWith(".")) {
            s = s.substring(0, s.length() - 1);
        }

        if (s.isEmpty() || s.indexOf('.') < 0) {
            return null;
        }

        String[] labels = s.split("\\.", -1);
        boolean allNumeric = true;
        for (String label : labels) {
            if (label.isEmpty()) {
                return null;
            }
            boolean numeric = true;
            for (int i = 0; i < label.length(); i++) {
                char c = label.charAt(i);
                if (!(Character.isLetterOrDigit(c) || c == '-' || c == '_')) {
                    return null; // stray punctuation from half-typed text
                }
                if (!Character.isDigit(c)) {
                    numeric = false;
                }
            }
            if (!numeric) {
                allNumeric = false;
            }
        }
        if (allNumeric) {
            return null; // IPv4 literal, not a domain
        }
        return s;
    }

    private static int firstIndexOfAny(String s, String chars) {
        for (int i = 0; i < s.length(); i++) {
            if (chars.indexOf(s.charAt(i)) >= 0) {
                return i;
            }
        }
        return -1;
    }
}
