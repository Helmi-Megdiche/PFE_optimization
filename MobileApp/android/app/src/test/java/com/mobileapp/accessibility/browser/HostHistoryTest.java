package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HostHistoryTest {

    @Test
    public void recordsAHostChangeOnce() {
        HostHistory h = new HostHistory();
        assertTrue(h.recordHost("a.com", 100));
        assertFalse("same host again is not a change", h.recordHost("a.com", 200));
        assertTrue(h.recordHost("b.com", 300));
        assertEquals(2, h.size());
    }

    @Test
    public void leftChromeIsANullEntryRecordedOnce() {
        HostHistory h = new HostHistory();
        h.recordHost("a.com", 100);
        assertTrue(h.recordLeftChrome(200));
        assertFalse("already outside Chrome", h.recordLeftChrome(300));
        assertNull(h.latest().host);
        assertEquals(200, h.latest().sinceUptimeMs);
    }

    @Test
    public void returningToTheSameHostAfterLeavingCountsAsAChange() {
        HostHistory h = new HostHistory();
        h.recordHost("a.com", 100);
        h.recordLeftChrome(200);
        assertTrue(h.recordHost("a.com", 300));
        assertEquals(3, h.size());
    }

    @Test
    public void entryCoveringAGivenInstant() {
        HostHistory h = new HostHistory();
        h.recordHost("a.com", 100);
        h.recordHost("b.com", 300);
        h.recordLeftChrome(500);
        assertNull("before anything was recorded", h.entryCoveringAt(50));
        assertEquals("a.com", h.entryCoveringAt(100).host);
        assertEquals("a.com", h.entryCoveringAt(299).host);
        assertEquals("b.com", h.entryCoveringAt(300).host);
        assertNull("the covering entry is 'left Chrome'", h.entryCoveringAt(600).host);
    }

    @Test
    public void anyEntryAfterIsExclusiveOfTheStartAndInclusiveOfTheEnd() {
        HostHistory h = new HostHistory();
        h.recordHost("a.com", 100);
        h.recordHost("b.com", 300);
        assertTrue(h.anyEntryAfter(200, 400));
        assertTrue("end is inclusive", h.anyEntryAfter(200, 300));
        assertFalse("start is exclusive", h.anyEntryAfter(300, 400));
        assertFalse(h.anyEntryAfter(300, 300));
    }

    @Test
    public void keepsOnlyTheLastTenEntries() {
        HostHistory h = new HostHistory();
        for (int i = 0; i < 25; i++) {
            h.recordHost("site" + i + ".com", 1000L + i);
        }
        assertEquals(HostHistory.CAPACITY, h.size());
        assertEquals("site24.com", h.latest().host);
        assertNull("the oldest entries were dropped", h.entryCoveringAt(1000));
        assertEquals("site15.com", h.entryCoveringAt(1015).host);
    }

    @Test
    public void emptyHistoryHasNoLatest() {
        assertNull(new HostHistory().latest());
    }
}
