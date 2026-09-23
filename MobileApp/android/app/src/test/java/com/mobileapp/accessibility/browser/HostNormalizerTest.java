package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Inputs are the address-bar texts Chrome actually exposed on the device (recon R1). */
public class HostNormalizerTest {

    // ---- real Chrome display forms ------------------------------------------------------

    @Test
    public void plainHost() {
        assertEquals("example.com", HostNormalizer.toHost("example.com"));
    }

    @Test
    public void hostWithPath() {
        assertEquals("en.wikipedia.org", HostNormalizer.toHost("en.wikipedia.org/wiki/Cat"));
    }

    @Test
    public void googleResultsPage() {
        assertEquals("google.com", HostNormalizer.toHost("google.com/search?q=cats"));
    }

    @Test
    public void queryContainingAmpersandAndEquals() {
        assertEquals(
                "bing.com", HostNormalizer.toHost("bing.com/images/search?q=cats&first=1"));
    }

    @Test
    public void longAdultVideoPath() {
        assertEquals(
                "pornhub.com",
                HostNormalizer.toHost("pornhub.com/view_video.php?viewkey=ph60ec3bb69a3fb"));
    }

    @Test
    public void portPathQueryAndFragment() {
        assertEquals("example.com", HostNormalizer.toHost("example.com:8443/a?b=c#d"));
    }

    @Test
    public void hostWithSubdomainIsKeptAsIs() {
        // Walking up to a parent domain is the matcher's job, not the normalizer's.
        assertEquals("news.ycombinator.com", HostNormalizer.toHost("news.ycombinator.com"));
    }

    // ---- forms Chrome strips but the normalizer must still survive ------------------------

    @Test
    public void schemeUserinfoPortPathQueryFragment() {
        assertEquals(
                "example.com",
                HostNormalizer.toHost("https://user:pw@Example.com:8080/a?b#c"));
    }

    @Test
    public void uppercaseIsLowercased() {
        assertEquals("example.com", HostNormalizer.toHost("EXAMPLE.Com"));
    }

    @Test
    public void trailingDotIsStripped() {
        assertEquals("example.com", HostNormalizer.toHost("example.com."));
    }

    @Test
    public void surroundingWhitespaceIsTrimmed() {
        assertEquals("example.com", HostNormalizer.toHost("  example.com  "));
    }

    @Test
    public void punycodeIsKeptAsIs() {
        assertEquals("xn--nxasmq6b.com", HostNormalizer.toHost("xn--nxasmq6b.com/x"));
    }

    // ---- not a host -> null ---------------------------------------------------------------

    @Test
    public void nullAndEmpty() {
        assertNull(HostNormalizer.toHost(null));
        assertNull(HostNormalizer.toHost(""));
        assertNull(HostNormalizer.toHost("   "));
    }

    @Test
    public void textWithSpacesIsNotAHost() {
        assertNull(HostNormalizer.toHost("Search Google or type URL"));
        assertNull(HostNormalizer.toHost("example.net foo"));
    }

    @Test
    public void noDotIsNotAHost() {
        assertNull(HostNormalizer.toHost("localhost"));
        assertNull(HostNormalizer.toHost("po"));
    }

    @Test
    public void ipv4LiteralIsNotADomain() {
        assertNull(HostNormalizer.toHost("127.0.0.1"));
        assertNull(HostNormalizer.toHost("192.168.1.10:3000/x"));
    }

    @Test
    public void ipv6LiteralIsNotADomain() {
        assertNull(HostNormalizer.toHost("[::1]:8080/x"));
    }

    @Test
    public void emptyLabelsAreRejected() {
        assertNull(HostNormalizer.toHost("example..com"));
        assertNull(HostNormalizer.toHost(".example.com"));
    }

    @Test
    public void halfTypedTextWithStrayPunctuationIsRejected() {
        assertNull(HostNormalizer.toHost("ha'ime.r"));
        assertNull(HostNormalizer.toHost("<none>"));
    }

    // ---- fromUrlBar: the address-bar read the service actually uses ----------------------

    @Test
    public void focusedTypingIsSkippedEvenWhenItLooksLikeAHost() {
        // Recon: while typing, the bar reads "example.net" with focused=true. That is not a
        // loaded page, so it must never produce a host.
        assertNull(HostNormalizer.fromUrlBar("example.net", true));
        assertNull(HostNormalizer.fromUrlBar("pornhub.com/view_video.php?viewkey=x", true));
    }

    @Test
    public void focusedPlaceholderIsSkipped() {
        assertNull(HostNormalizer.fromUrlBar("Search Google or type URL", true));
    }

    @Test
    public void unfocusedLoadedPageYieldsItsHost() {
        assertEquals("example.com", HostNormalizer.fromUrlBar("example.com", false));
        assertEquals(
                "google.com", HostNormalizer.fromUrlBar("google.com/search?q=cats", false));
    }

    @Test
    public void missingNodeTextIsNoHost() {
        // "<none>" in recon = the url_bar node was not found. It is "no change", never a host.
        assertNull(HostNormalizer.fromUrlBar(null, false));
        assertNull(HostNormalizer.fromUrlBar("<none>", false));
    }
}
