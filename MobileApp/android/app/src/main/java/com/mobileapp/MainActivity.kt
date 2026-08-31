package com.mobileapp

import android.content.Intent
import android.os.Bundle
import com.mobileapp.overlay.OverlayLaunchHolder
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    // Pass null, never savedInstanceState: react-native-screens' ScreenStackFragment
    // throws "Screen fragments should never be restored" if Android recreates this
    // activity and tries to restore the fragment back-stack — which happens when an
    // accessibility service connects/disconnects (global config change) or when the
    // OS kills this app while backgrounded and restores it. RN drives navigation from
    // JS, so there is no fragment state worth restoring.
    super.onCreate(null)
    OverlayLaunchHolder.setFromIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    com.mobileapp.overlay.OverlayEventBridge.flushPending()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    OverlayLaunchHolder.setFromIntent(intent)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "MobileApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  // MediaProjection result is handled by ScreenCaptureModule's ActivityEventListener only.
  // Do NOT forward onActivityResult here — duplicate calls break getMediaProjection().
}
