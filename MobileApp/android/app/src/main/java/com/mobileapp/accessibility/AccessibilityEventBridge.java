package com.mobileapp.accessibility;

import android.util.Log;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.ArrayDeque;

/**
 * Emits accessibility events to JavaScript when React is active; buffers otherwise.
 *
 * <p>Modelled on {@code com.mobileapp.overlay.OverlayEventBridge}. The
 * {@link SafeGuardAccessibilityService} runs independently of the RN lifecycle, so an
 * event can fire while the JS context is dead — those are queued (bounded, drop-oldest)
 * and flushed once a live {@link ReactContext} is available again.
 */
public final class AccessibilityEventBridge {

    private static final String TAG = "SafeGuardA11yBridge";

    public static final String EVENT_WINDOW_CHANGED = "onAccessibilityWindowChanged";
    public static final String EVENT_KEYBOARD_CHANGED = "onAccessibilityKeyboardChanged";
    public static final String EVENT_SCROLL = "onAccessibilityScroll";

    /** Bounded buffer: keep at most this many pending events; drop the oldest when full. */
    private static final int MAX_PENDING = 20;

    private static final ArrayDeque<PendingEvent> PENDING = new ArrayDeque<>();

    @Nullable
    private static ReactContext reactContext;

    private AccessibilityEventBridge() {}

    private static final class PendingEvent {
        final String eventName;
        final WritableMap params;

        PendingEvent(String eventName, WritableMap params) {
            this.eventName = eventName;
            this.params = params;
        }
    }

    /** Called from the RN module constructor once a context exists. */
    public static synchronized void attach(ReactContext context) {
        reactContext = context;
        flushPendingEvents(context);
    }

    public static synchronized void detach() {
        reactContext = null;
    }

    public static void emitWindowChanged(String packageName, long timestamp) {
        WritableMap map = Arguments.createMap();
        map.putString("packageName", packageName);
        map.putDouble("timestamp", (double) timestamp);
        dispatch(EVENT_WINDOW_CHANGED, map);
    }

    public static void emitKeyboardChanged(boolean visible, long timestamp) {
        WritableMap map = Arguments.createMap();
        map.putBoolean("visible", visible);
        map.putDouble("timestamp", (double) timestamp);
        dispatch(EVENT_KEYBOARD_CHANGED, map);
    }

    public static void emitScroll(String packageName, long timestamp) {
        WritableMap map = Arguments.createMap();
        map.putString("packageName", packageName);
        map.putDouble("timestamp", (double) timestamp);
        dispatch(EVENT_SCROLL, map);
    }

    private static synchronized void dispatch(String eventName, WritableMap params) {
        if (!emit(eventName, params)) {
            if (PENDING.size() >= MAX_PENDING) {
                PENDING.pollFirst(); // drop oldest
            }
            PENDING.addLast(new PendingEvent(eventName, params));
            Log.i(TAG, "queued " + eventName + " (React not active), pending=" + PENDING.size());
        }
    }

    /** Drain buffered events oldest → newest; stop and keep the rest on the first failed emit. */
    public static synchronized void flushPendingEvents(@Nullable ReactContext ctx) {
        if (ctx != null) {
            reactContext = ctx;
        }
        if (PENDING.isEmpty()) {
            return;
        }
        int flushed = 0;
        while (!PENDING.isEmpty()) {
            PendingEvent next = PENDING.peekFirst();
            if (!emit(next.eventName, next.params)) {
                break;
            }
            PENDING.pollFirst();
            flushed++;
        }
        if (flushed > 0) {
            Log.i(TAG, "flushed " + flushed + " queued event(s), remaining=" + PENDING.size());
        }
    }

    private static boolean emit(String eventName, WritableMap params) {
        ReactContext ctx = reactContext;
        if (ctx == null) {
            return false;
        }
        if (!ctx.hasActiveReactInstance()) {
            return false;
        }
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(eventName, params);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "emit failed: " + eventName, e);
            return false;
        }
    }
}
