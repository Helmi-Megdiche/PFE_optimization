package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;
import org.junit.Test;

public class DevStaticSwitchTest {

    @Test
    public void debugBuildWithMarkerDisablesTheStaticList() {
        assertTrue(DevStaticSwitch.staticListDisabled(true, true));
    }

    @Test
    public void debugBuildWithoutMarkerLeavesItOn() {
        assertFalse(DevStaticSwitch.staticListDisabled(true, false));
    }

    @Test
    public void aReleaseBuildNeverDisablesItEvenWithTheMarkerPresent() {
        assertFalse(DevStaticSwitch.staticListDisabled(false, true));
        assertFalse(DevStaticSwitch.staticListDisabled(false, false));
    }

    @Test
    public void theRuntimeOnlyEverPassesBuildConfigDebugAsTheFirstArgument() throws Exception {
        // The release guarantee rests on this call site: BuildConfig.DEBUG is a compile-time
        // constant, false in release. If someone replaces it with a runtime flag, this fails.
        File src =
                new File(
                        "src/main/java/com/mobileapp/accessibility/browser/BrowserBlockRuntime.java");
        String text =
                new String(
                        java.nio.file.Files.readAllBytes(src.toPath()), StandardCharsets.UTF_8);
        assertTrue(text.contains("DevStaticSwitch.staticListDisabled(BuildConfig.DEBUG,"));
        assertEquals(
                "exactly one call site",
                1,
                text.split("DevStaticSwitch\\.staticListDisabled\\(", -1).length - 1);
    }

    @Test
    public void domainListsIgnoresTheStaticListWhileSwitchedOffButKeepsDetectedDomains()
            throws Exception {
        Executor direct = Runnable::run;
        File dyn = File.createTempFile("dyn", ".txt");
        dyn.delete();
        NeverBlockList nb =
                NeverBlockList.load(
                        new ByteArrayInputStream(
                                "{\"neverBlock\":[\"google.*\"],\"exactHostOnly\":[]}"
                                        .getBytes(StandardCharsets.UTF_8)));
        DomainLists lists = new DomainLists(nb, dyn, direct, m -> {});
        lists.load(new ByteArrayInputStream("pornhub.com\n".getBytes(StandardCharsets.UTF_8)));
        assertEquals(DomainLists.AddResult.ADDED, lists.addDetected("other-adult.example"));

        assertNotNull(lists.match("pornhub.com"));
        lists.setStaticEnabled(false);
        assertNull("static list is off", lists.match("pornhub.com"));
        assertNotNull("detected list still matches", lists.match("other-adult.example"));
        lists.setStaticEnabled(true);
        assertNotNull(lists.match("pornhub.com"));
        dyn.delete();
    }
}
