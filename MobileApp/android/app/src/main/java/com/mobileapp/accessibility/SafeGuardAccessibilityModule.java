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
import com.mobileapp.BuildConfig;
import com.mobileapp.accessibility.browser.BrowserBlockController.AddOutcome;
import com.mobileapp.accessibility.browser.BrowserBlockController.LeaveOutcome;
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
     * F2 (review round 4). An OCR-only adult detection in Chrome — the image check did not clear
     * the blacklist threshold, so nothing is added or reported, but Back still runs so the child
     * isn't left sitting on the page. Resolves {left, reason, host}. Never rejects for a refusal.
     */
    @ReactMethod
    public void leaveBlockedPage(double captureTimestampMs, Promise promise) {
        try {
            SafeGuardAccessibilityService svc = SafeGuardAccessibilityService.instance;
            BrowserBlockRuntime b = svc == null ? null : svc.getBrowserBlocker();
            WritableMap out = Arguments.createMap();
            if (b == null) {
                out.putBoolean("left", false);
                out.putString("reason", "service_unavailable");
                promise.resolve(out);
                return;
            }
            LeaveOutcome o = b.leaveBlockedPage((long) captureTimestampMs);
            out.putBoolean("left", o.left);
            out.putString("reason", o.reason);
            if (o.host != null) {
                out.putString("host", o.host);
            }
            promise.resolve(out);
        } catch (Throwable t) {
            promise.reject("E_LEAVE_BLOCKED", "leaveBlockedPage failed", t);
        }
    }

    /**
     * DEBUG BUILDS ONLY (Q2 device arm, review round 4): calls {@code addDetectedDomain} with the
     * capture timestamp genuinely {@code now}, so native attribution runs against the real history
     * ring without needing a staged screenshot/vision pipeline run — the same "gated exactly like
     * the static-list switch" shape as {@link com.mobileapp.accessibility.browser.DevStaticSwitch}:
     * the guard is {@code BuildConfig.DEBUG}, a compile-time constant that is {@code false} in
     * release, so this branch never runs there. No marker file needed (nothing to leave behind).
     */
    @ReactMethod
    public void devAddDetectedDomainNow(Promise promise) {
        if (!BuildConfig.DEBUG) {
            promise.reject("E_DEV_ONLY", "devAddDetectedDomainNow is debug-build only");
            return;
        }
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
            AddOutcome o = b.addDetectedDomain(System.currentTimeMillis());
            out.putBoolean("added", o.added);
            out.putBoolean("listed", o.listed);
            out.putString("reason", o.reason);
            if (o.host != null) {
                out.putString("host", o.host);
            }
            promise.resolve(out);
        } catch (Throwable t) {
            promise.reject("E_DEV_ADD_NOW", "devAddDetectedDomainNow failed", t);
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
