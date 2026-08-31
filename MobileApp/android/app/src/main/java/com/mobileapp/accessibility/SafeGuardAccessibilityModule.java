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
