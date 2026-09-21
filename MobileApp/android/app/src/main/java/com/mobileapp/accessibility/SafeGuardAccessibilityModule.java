package com.mobileapp.accessibility;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.text.TextUtils;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.mobileapp.accessibility.browser.BrowserBlockController.AddOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockRuntime;
import com.facebook.react.module.annotations.ReactModule;

/**
 * Bridge surface for {@link SafeGuardAccessibilityService}: query enable-state, deep-link to
 * the system settings screen, and flush events buffered while JS was dead.
 */
@ReactModule(name = SafeGuardAccessibilityModule.NAME)
public class SafeGuardAccessibilityModule extends ReactContextBaseJavaModule {

    public static final String NAME = "SafeGuardAccessibility";

    public SafeGuardAccessibilityModule(ReactApplicationContext reactContext) {
        super(reactContext);
        AccessibilityEventBridge.attach(reactContext);
    }

    @Override
    public void invalidate() {
        AccessibilityEventBridge.detach();
        super.invalidate();
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    @ReactMethod
    public void isEnabled(Promise promise) {
        try {
            boolean connected = SafeGuardAccessibilityService.instance != null;

            Context ctx = getReactApplicationContext();
            String enabledServices = Settings.Secure.getString(
                    ctx.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String component =
                    new ComponentName(ctx, SafeGuardAccessibilityService.class).flattenToString();

            boolean listed = false;
            if (!TextUtils.isEmpty(enabledServices)) {
                TextUtils.SimpleStringSplitter splitter =
                        new TextUtils.SimpleStringSplitter(':');
                splitter.setString(enabledServices);
                while (splitter.hasNext()) {
                    if (component.equalsIgnoreCase(splitter.next())) {
                        listed = true;
                        break;
                    }
                }
            }

            promise.resolve(connected && listed);
        } catch (Exception e) {
            promise.reject("E_A11Y_STATE", "Failed to read accessibility state", e);
        }
    }

    @ReactMethod
    public void openAccessibilitySettings(Promise promise) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("E_A11Y_SETTINGS", "Cannot open accessibility settings", e);
        }
    }

    @ReactMethod
    public void flushPendingEvents(Promise promise) {
        AccessibilityEventBridge.flushPendingEvents(getReactApplicationContext());
        promise.resolve(true);
    }

    /**
     * Phase B. Attribution + add for the frame captured at {@code captureTimestampMs} (wall-clock ms
     * of the capture, never "now"). Resolves {added, listed, reason, host}: {@code listed} is true
     * when the host is on a list after the call (added OR duplicate), and is what lets JS show the
     * block screen when a mission was not presented. Never rejects for a refusal — the reason says why.
     */
    @ReactMethod
    public void addDetectedDomain(double captureTimestampMs, Promise promise) {
        try {
            SafeGuardAccessibilityService svc = SafeGuardAccessibilityService.instance;
            BrowserBlockRuntime b = svc == null ? null : svc.getBrowserBlocker();
            WritableMap out = Arguments.createMap();
            if (b == null) {
                out.putBoolean("added", false);
                out.putBoolean("listed", false);
                out.putString("reason", "service_unavailable");
                promise.resolve(out);
                return;
            }
            AddOutcome o = b.addDetectedDomain((long) captureTimestampMs);
            out.putBoolean("added", o.added);
            out.putBoolean("listed", o.listed);
            out.putString("reason", o.reason);
            if (o.host != null) {
                out.putString("host", o.host);
            }
            promise.resolve(out);
        } catch (Throwable t) {
            promise.reject("E_ADD_DETECTED", "addDetectedDomain failed", t);
        }
    }

    /**
     * Phase B (A1/B9). Shows the block screen through OverlayService unless a mission overlay is up.
     * Resolves true if shown, false if refused (mission on screen / service unavailable).
     */
    @ReactMethod
    public void showBrowserBlockScreen(Promise promise) {
        try {
            SafeGuardAccessibilityService svc = SafeGuardAccessibilityService.instance;
            BrowserBlockRuntime b = svc == null ? null : svc.getBrowserBlocker();
            promise.resolve(b != null && b.showBlockScreenFromJs());
        } catch (Throwable t) {
            promise.reject("E_SHOW_BLOCK", "showBrowserBlockScreen failed", t);
        }
    }

    /** Required for NativeEventEmitter. */
    @ReactMethod
    public void addListener(String eventName) {
        // Stub — events use RCTDeviceEventEmitter.
    }

    @ReactMethod
    public void removeListeners(double count) {
        // Stub
    }
}
