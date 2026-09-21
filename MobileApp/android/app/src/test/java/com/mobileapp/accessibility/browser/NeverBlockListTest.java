package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

public class NeverBlockListTest {

    private final NeverBlockList list =
            new NeverBlockList(
                    Arrays.asList(
                            "google.*", "bing.com", "wikipedia.org", "x.com", "reddit.com"));

    @Test
    public void exactDomainIsCovered() {
        assertTrue(list.covers("bing.com"));
        assertTrue(list.covers("x.com"));
    }

    @Test
    public void subdomainsAreCovered() {
        assertTrue(list.covers("en.wikipedia.org"));
        assertTrue(list.covers("old.reddit.com"));
        assertTrue(list.covers("nsfw.reddit.com"));
    }

    @Test
    public void wildcardCoversEveryGoogleTld() {
        assertTrue(list.covers("google.com"));
        assertTrue(list.covers("www.google.fr"));
        assertTrue(list.covers("maps.google.com"));
        assertTrue(list.covers("google.co.uk"));
        assertTrue(list.covers("www.google.com.tn"));
    }

    @Test
    public void wildcardDoesNotSwallowUnrelatedDomains() {
        assertFalse(list.covers("google.porno.sexy"));
        assertFalse(list.covers("notgoogle.com"));
        assertFalse(list.covers("evilgoogle.com"));
        assertFalse(list.covers("google.evil.example.net"));
    }

    @Test
    public void lookalikesAreNotCovered() {
        assertFalse(list.covers("box.com"));
        assertFalse(list.covers("wikipedia.org.evil.com"));
        assertFalse(list.covers("mybing.com"));
    }

    @Test
    public void nullAndBlankAreNotCovered() {
        assertFalse(list.covers(null));
        assertFalse(list.covers(""));
    }

    @Test
    public void parseReadsAFlatJsonArray() {
        NeverBlockList parsed =
                NeverBlockList.parse("[\n  \"google.*\",\n  \"bing.com\"\n]\n");
        assertTrue(parsed.covers("www.google.com"));
        assertTrue(parsed.covers("bing.com"));
        assertFalse(parsed.covers("yahoo.com"));
        assertEquals(2, parsed.size());
    }
}
