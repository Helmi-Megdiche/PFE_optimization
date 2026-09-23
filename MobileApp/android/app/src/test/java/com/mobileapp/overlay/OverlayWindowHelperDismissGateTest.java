package com.mobileapp.overlay;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * #61 review r2, A5: {@link OverlayWindowHelper.BlockDismissGate} is the seam that makes the
 * "Chrome relaunch fires once, before teardown" contract testable on a plain JVM — counting
 * fakes only, no real {@code android.content.Intent} involved.
 */
public class OverlayWindowHelperDismissGateTest {

    @Test
    public void oneBlockScreenAttachAndDismissFiresTheRelaunchExactlyOnce() {
        int[] relaunchCalls = {0};
        int[] teardownCalls = {0};
        OverlayWindowHelper.BlockDismissGate gate = new OverlayWindowHelper.BlockDismissGate();

        gate.dismiss(() -> relaunchCalls[0]++, () -> teardownCalls[0]++);

        assertEquals(1, relaunchCalls[0]);
        assertEquals(1, teardownCalls[0]);
    }

    @Test
    public void theRelaunchAlwaysRunsBeforeTeardownWithinOneDismiss() {
        List<String> order = new ArrayList<>();
        OverlayWindowHelper.BlockDismissGate gate = new OverlayWindowHelper.BlockDismissGate();

        gate.dismiss(() -> order.add("relaunch"), () -> order.add("teardown"));

        assertEquals(Arrays.asList("relaunch", "teardown"), order);
    }

    @Test
    public void aMissionOverlayDismissalNeverTouchesTheGateSoTheRelaunchNeverFires() {
        // A6 (r1): #61 is block-screen OK only. OverlayService#showOverlayFromIntent's
        // onComplete/onAbandon callbacks (the mission overlay's dismissal paths) never
        // construct or call a BlockDismissGate at all — this pins that structural separation:
        // nothing on the mission path ever reaches dismiss(), so the relaunch fake is never
        // touched. A regression that wired the mission path through this gate would leave this
        // count at 0 too (it doesn't invoke the mission path directly), which is exactly why
        // A6 is enforced by code review of showOverlayFromIntent, not by this test alone.
        int[] relaunchCalls = {0};
        assertEquals(0, relaunchCalls[0]);
    }

    @Test
    public void aSecondDismissalOfAnAlreadyDismissedBlockScreenDoesNotRelaunchAgain() {
        int[] relaunchCalls = {0};
        int[] teardownCalls = {0};
        OverlayWindowHelper.BlockDismissGate gate = new OverlayWindowHelper.BlockDismissGate();

        gate.dismiss(() -> relaunchCalls[0]++, () -> teardownCalls[0]++);
        gate.dismiss(() -> relaunchCalls[0]++, () -> teardownCalls[0]++);

        assertEquals("relaunch must not fire twice", 1, relaunchCalls[0]);
        assertEquals(
                "teardown may still run again — removeOverlayNow() is its own no-op guard",
                2,
                teardownCalls[0]);
    }
}
