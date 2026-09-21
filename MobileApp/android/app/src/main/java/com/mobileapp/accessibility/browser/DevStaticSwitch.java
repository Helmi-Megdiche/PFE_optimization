package com.mobileapp.accessibility.browser;

/**
 * Debug-build-only switch that turns the static adult list off, so device step 2 ("an adult
 * domain that is NOT on the list") can be exercised with a domain that really is on it.
 *
 * <p>Reachable only in a debug build: the decision is {@code debugBuild && markerExists}, and
 * {@code debugBuild} is {@code BuildConfig.DEBUG}, a compile-time constant that is {@code false}
 * in release, so the marker file is never even consulted there. The marker is a plain file in the
 * app's private {@code filesDir}, created with {@code adb shell run-as com.mobileapp touch
 * files/debug_disable_static_list} (run-as only works on debuggable builds). No JS, UI or bridge
 * path can flip it. Pure Java, JVM-tested.
 */
public final class DevStaticSwitch {

    public static final String MARKER_FILE_NAME = "debug_disable_static_list";

    private DevStaticSwitch() {}

    public static boolean staticListDisabled(boolean debugBuild, boolean markerExists) {
        return debugBuild && markerExists;
    }
}
