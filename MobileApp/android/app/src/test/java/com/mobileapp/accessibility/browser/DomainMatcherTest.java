package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class DomainMatcherTest {

    private static Set<String> set(String... items) {
        Set<String> s = new HashSet<>();
        Collections.addAll(s, items);
        return s;
    }

    private static final Set<String> NONE = Collections.emptySet();

    @Test
    public void exactMatch() {
        DomainMatcher.Match m = DomainMatcher.match("example.com", set("example.com"), NONE);
        assertNotNull(m);
        assertEquals("example.com", m.domain);
        assertEquals(DomainMatcher.ListSource.STATIC, m.source);
    }

    @Test
    public void walksUpFromASubdomain() {
        DomainMatcher.Match m =
                DomainMatcher.match("a.b.example.com", set("example.com"), NONE);
        assertNotNull(m);
        assertEquals("example.com", m.domain);
    }

    @Test
    public void listedSubdomainMatchesItsOwnHostButNotItsParent() {
        Set<String> s = set("cdn.example.com");
        assertNotNull(DomainMatcher.match("cdn.example.com", s, NONE));
        assertNotNull(DomainMatcher.match("x.cdn.example.com", s, NONE));
        assertNull(DomainMatcher.match("example.com", s, NONE));
        assertNull(DomainMatcher.match("www.example.com", s, NONE));
    }

    @Test
    public void unrelatedDomainsDoNotMatch() {
        assertNull(DomainMatcher.match("notexample.com", set("example.com"), NONE));
        assertNull(DomainMatcher.match("example.com.evil.net", set("example.com"), NONE));
    }

    @Test
    public void neverWalksUpToABareTld() {
        assertNull(DomainMatcher.match("example.com", set("com"), NONE));
        assertNull(DomainMatcher.match("a.b.example.org", set("org"), NONE));
    }

    @Test
    public void neverWalksUpToATwoPartPublicSuffix() {
        assertNull(DomainMatcher.match("foo.co.uk", set("co.uk"), NONE));
        assertNull(DomainMatcher.match("shop.example.com.tn", set("com.tn"), NONE));
    }

    @Test
    public void matchesTheRegistrableDomainUnderATwoPartSuffix() {
        DomainMatcher.Match m =
                DomainMatcher.match("x.example.co.uk", set("example.co.uk"), NONE);
        assertNotNull(m);
        assertEquals("example.co.uk", m.domain);
        assertNotNull(
                DomainMatcher.match("shop.example.com.tn", set("example.com.tn"), NONE));
    }

    @Test
    public void bareSuffixHostAndSingleLabelNeverMatch() {
        assertNull(DomainMatcher.match("co.uk", set("co.uk", "uk"), NONE));
        assertNull(DomainMatcher.match("com", set("com"), NONE));
        assertNull(DomainMatcher.match("localhost", set("localhost"), NONE));
        assertNull(DomainMatcher.match(null, set("example.com"), NONE));
        assertNull(DomainMatcher.match("", set("example.com"), NONE));
    }

    @Test
    public void recordsWhichListMatched() {
        DomainMatcher.Match s = DomainMatcher.match("a.example.com", set("example.com"), NONE);
        DomainMatcher.Match d = DomainMatcher.match("a.other.com", NONE, set("other.com"));
        assertEquals(DomainMatcher.ListSource.STATIC, s.source);
        assertEquals(DomainMatcher.ListSource.DETECTED, d.source);
    }

    @Test
    public void staticWinsWhenBothListsHoldTheSameDomain() {
        DomainMatcher.Match m =
                DomainMatcher.match("example.com", set("example.com"), set("example.com"));
        assertEquals(DomainMatcher.ListSource.STATIC, m.source);
    }

    @Test
    public void registrableDomain() {
        assertEquals("pornhub.com", DomainMatcher.registrable("www.pornhub.com"));
        assertEquals("example.com", DomainMatcher.registrable("example.com"));
        assertEquals("example.co.uk", DomainMatcher.registrable("a.b.example.co.uk"));
        assertEquals("example.com.tn", DomainMatcher.registrable("example.com.tn"));
    }

    @Test
    public void registrableIsNullForSuffixesAndSingleLabels() {
        assertNull(DomainMatcher.registrable("co.uk"));
        assertNull(DomainMatcher.registrable("com.tn"));
        assertNull(DomainMatcher.registrable("com"));
        assertNull(DomainMatcher.registrable("localhost"));
        assertNull(DomainMatcher.registrable(null));
    }
}
