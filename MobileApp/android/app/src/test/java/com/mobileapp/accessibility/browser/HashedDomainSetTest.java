package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.Random;
import java.util.Set;
import org.junit.Test;

public class HashedDomainSetTest {

    private static HashedDomainSet setOf(String... items) {
        HashedDomainSet.Builder b = new HashedDomainSet.Builder();
        for (String s : items) {
            b.add(s);
        }
        return b.build();
    }

    @Test
    public void containsWhatWasAddedAndNothingElse() {
        HashedDomainSet s = setOf("pornhub.com", "xhamster.com", "hanime.tv");
        assertTrue(s.contains("pornhub.com"));
        assertTrue(s.contains("hanime.tv"));
        assertFalse(s.contains("example.com"));
        assertFalse(s.contains("pornhub.co"));
        assertFalse(s.contains("www.pornhub.com"));
        assertFalse(s.contains(""));
    }

    @Test
    public void duplicatesCollapse() {
        assertEquals(2, setOf("a.com", "b.com", "a.com", "a.com").size());
    }

    @Test
    public void emptySetContainsNothing() {
        HashedDomainSet s = setOf();
        assertEquals(0, s.size());
        assertFalse(s.contains("a.com"));
        assertTrue(s.isEmpty());
    }

    @Test
    public void nonStringQueriesAreNotContained() {
        HashedDomainSet s = setOf("a.com");
        assertFalse(s.contains(null));
        assertFalse(s.contains(42));
    }

    @Test
    public void similarStringsHashDifferently() {
        assertNotEquals(HashedDomainSet.hash("a.com"), HashedDomainSet.hash("b.com"));
        assertNotEquals(HashedDomainSet.hash("ab.com"), HashedDomainSet.hash("ba.com"));
        assertNotEquals(HashedDomainSet.hash("example.com"), HashedDomainSet.hash("example.co"));
    }

    @Test
    public void growsPastItsInitialBuffer() {
        HashedDomainSet.Builder b = new HashedDomainSet.Builder();
        for (int i = 0; i < 5000; i++) {
            b.add("site-" + i + ".example.com");
        }
        HashedDomainSet s = b.build();
        assertEquals(5000, s.size());
        assertTrue(s.contains("site-0.example.com"));
        assertTrue(s.contains("site-4999.example.com"));
        assertFalse(s.contains("site-5000.example.com"));
    }

    @Test
    public void noFalsePositivesAtTheRealListSize() {
        // ~77k domains, then 200k lookups of strings that are NOT in the set.
        Random rnd = new Random(42);
        Set<String> members = new HashSet<>();
        HashedDomainSet.Builder b = new HashedDomainSet.Builder();
        while (members.size() < 77_000) {
            String d = randomDomain(rnd);
            if (members.add(d)) {
                b.add(d);
            }
        }
        HashedDomainSet s = b.build();
        assertEquals(77_000, s.size());

        int falsePositives = 0;
        int checked = 0;
        while (checked < 200_000) {
            String q = randomDomain(rnd);
            if (members.contains(q)) {
                continue;
            }
            checked++;
            if (s.contains(q)) {
                falsePositives++;
            }
        }
        assertEquals("64-bit hashes must not collide at this size", 0, falsePositives);
        for (String m : members) {
            assertTrue(s.contains(m));
        }
    }

    // ---- fromLines: hashes the asset's bytes, never building a String per line ---------------------

    private static HashedDomainSet fromText(String text) throws Exception {
        return HashedDomainSet.fromLines(
                new java.io.ByteArrayInputStream(
                        text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    @Test
    public void fromLinesReadsOneDomainPerLine() throws Exception {
        HashedDomainSet s = fromText("pornhub.com\nxhamster.com\nhanime.tv\n");
        assertEquals(3, s.size());
        assertTrue(s.contains("pornhub.com"));
        assertTrue(s.contains("hanime.tv"));
        assertFalse(s.contains("example.com"));
    }

    @Test
    public void fromLinesSkipsCommentsAndBlankLines() throws Exception {
        HashedDomainSet s = fromText("# header\n\n   \na.com\n# a.com is not this\n\nb.com\n");
        assertEquals(2, s.size());
        assertTrue(s.contains("a.com"));
        assertTrue(s.contains("b.com"));
        assertFalse(s.contains("# header"));
    }

    @Test
    public void fromLinesHandlesCrLfAndSurroundingSpacesAndNoFinalNewline() throws Exception {
        HashedDomainSet s = fromText("a.com\r\n  b.com  \r\nc.com");
        assertEquals(3, s.size());
        assertTrue(s.contains("a.com"));
        assertTrue(s.contains("b.com"));
        assertTrue(s.contains("c.com"));
        assertFalse(s.contains("b.com "));
    }

    @Test
    public void fromLinesLowercasesAsciiAndDedupes() throws Exception {
        HashedDomainSet s = fromText("A.Example.COM\na.example.com\nB.example.com\n");
        assertEquals(2, s.size());
        assertTrue(s.contains("a.example.com"));
    }

    @Test
    public void fromLinesAgreesWithTheStringHashForNonAsciiHosts() throws Exception {
        HashedDomainSet s = fromText("münchen.de\nxn--nxasmq6b.com\n");
        assertTrue(s.contains("münchen.de"));
        assertTrue(s.contains("xn--nxasmq6b.com"));
        assertEquals(s.contains("münchen.de"), setOf("münchen.de").contains("münchen.de"));
    }

    @Test
    public void fromLinesAndBuilderProduceTheSameSet() throws Exception {
        HashedDomainSet a = fromText("a.com\nb.com\nc.com\n");
        HashedDomainSet b = setOf("a.com", "b.com", "c.com");
        for (String d : new String[] {"a.com", "b.com", "c.com", "d.com"}) {
            assertEquals(d, b.contains(d), a.contains(d));
        }
        assertEquals(b.size(), a.size());
    }

    @Test(expected = UnsupportedOperationException.class)
    public void iteratingIsNotSupportedBecauseTheStringsAreNotKept() {
        setOf("a.com").iterator();
    }

    private static String randomDomain(Random rnd) {
        StringBuilder sb = new StringBuilder();
        int labels = 2 + rnd.nextInt(2);
        for (int l = 0; l < labels; l++) {
            if (l > 0) {
                sb.append('.');
            }
            int len = 3 + rnd.nextInt(10);
            for (int i = 0; i < len; i++) {
                sb.append((char) ('a' + rnd.nextInt(26)));
            }
        }
        return sb.toString();
    }
}
