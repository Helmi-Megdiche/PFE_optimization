package com.mobileapp.overlay;

import android.content.Context;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import com.mobileapp.R;

import org.json.JSONObject;

/**
 * Attaches/detaches the mission overlay WindowManager view (must run on main thread for add/remove).
 */
public final class OverlayWindowHelper {

    private static final String TAG = "OverlayWindowHelper";

  private OverlayWindowHelper() {}

  public interface ActionListener {
    void onStartQuiz(
            android.view.View overlayRoot,
            String missionId,
            String title,
            int points,
            String metadataJson);

    void onStartInAppMission(
            String missionId,
            String title,
            String description,
            int points,
            String missionType,
            String metadataJson);

    void onStartTicTacToe(
            android.view.View overlayRoot,
            String missionId,
            String title,
            int points,
            String metadataJson);

    void onComplete(String missionId, String missionType, String metadataJson);

    void onAbandon(String missionId, String missionType, String metadataJson);
  }

  private static boolean isPlayableMissionType(String missionType) {
    return "quiz".equals(missionType)
        || "minigame".equals(missionType)
        || "cognitive".equals(missionType);
  }

  /**
   * True iff {@code metadataJson} identifies the game as Tic-Tac-Toe (ALL_IS_FIXED #51 §A0:
   * missionType alone can't distinguish tictactoe from sudoku — both are "minigame"). Never
   * throws: a missing or unparseable metadata blob returns false, falling through to the
   * ordinary onStartInAppMission hand-off — the same "never render a half-identified game"
   * fallback OverlayQuizHelper already uses for a missing `questions` array.
   */
  private static boolean isTicTacToeGame(String metadataJson) {
    if (metadataJson == null) {
      return false;
    }
    try {
      JSONObject meta = new JSONObject(metadataJson);
      return "tictactoe".equals(meta.optString("game", null));
    } catch (Exception e) {
      return false;
    }
  }

  public static boolean canDrawOverlay(Context context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      return Settings.canDrawOverlays(context);
    }
    return true;
  }

  /**
   * @return the attached root view, or null if permission missing / addView failed
   */
  public static View attach(
      Context context,
      WindowManager windowManager,
      String missionId,
      String title,
      String description,
      int points,
      String missionType,
      String metadataJson,
      boolean browserAdult,
      ActionListener listener) {
    if (!canDrawOverlay(context)) {
      Log.e(TAG, "attach blocked — SYSTEM_ALERT_WINDOW not granted");
      Toast.makeText(
              context,
              "Allow \"Display over other apps\" for mission blocking",
              Toast.LENGTH_LONG)
          .show();
      return null;
    }

    LayoutInflater inflater = LayoutInflater.from(context);
    View root = inflater.inflate(R.layout.overlay_mission, null);

    // ALL_IS_FIXED #46: insets installed exactly once, on this exact root view (F1) — it's
    // the same View object OverlayQuizHelper/OverlayTicTacToeHelper removeAllViews() and
    // rebuild into when they take over, so this padding (and the root's own full-bleed
    // background, set in overlay_mission.xml) survives that transition unreinstalled.
    OverlayChrome.installInsetPadding(root);

    TextView titleView = root.findViewById(R.id.overlay_title);
    TextView descView = root.findViewById(R.id.overlay_description);
    TextView pointsView = root.findViewById(R.id.overlay_points);
    TextView browserWarning = root.findViewById(R.id.overlay_browser_warning);
    if (browserWarning != null) {
      // Phase B (B6): driven by the JS-side R4 condition, not by whether a domain was added.
      browserWarning.setVisibility(browserAdult ? View.VISIBLE : View.GONE);
    }
    Button completeBtn = root.findViewById(R.id.overlay_btn_complete);
    Button laterBtn = root.findViewById(R.id.overlay_btn_later);

    View card = root.findViewById(R.id.overlay_card);
    if (card != null && card.getParent() instanceof View) {
      OverlayChrome.applyMaxWidth(context, card, (View) card.getParent());
    }

    titleView.setText(title);
    descView.setText(description);
    pointsView.setText(OverlayChrome.captionText(points));
    completeBtn.setText(resolveCompleteLabel(context, missionType));

    final boolean[] actionSent = {false};

    completeBtn.setOnClickListener(
        v -> {
          if (actionSent[0]) {
            return;
          }
          actionSent[0] = true;
          setButtonsEnabled(completeBtn, laterBtn, false);
          if ("quiz".equals(missionType)) {
            listener.onStartQuiz(root, missionId, title, points, metadataJson);
          } else if ("minigame".equals(missionType) && isTicTacToeGame(metadataJson)) {
            listener.onStartTicTacToe(root, missionId, title, points, metadataJson);
          } else if (isPlayableMissionType(missionType)) {
            listener.onStartInAppMission(
                missionId, title, description, points, missionType, metadataJson);
          } else {
            listener.onComplete(missionId, missionType, metadataJson);
          }
        });

    laterBtn.setOnClickListener(
        v -> {
          if (actionSent[0]) {
            return;
          }
          actionSent[0] = true;
          setButtonsEnabled(completeBtn, laterBtn, false);
          listener.onAbandon(missionId, missionType, metadataJson);
        });

    WindowManager.LayoutParams params = fullScreenParams();

    try {
      windowManager.addView(root, params);
      Log.i(TAG, "overlay attached missionId=" + missionId);
      return root;
    } catch (Exception e) {
      Log.e(TAG, "addView failed", e);
      Toast.makeText(context, "Could not show mission overlay: " + e.getMessage(), Toast.LENGTH_LONG)
          .show();
      return null;
    }
  }

  private static WindowManager.LayoutParams fullScreenParams() {
    int overlayType =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

    WindowManager.LayoutParams params =
        new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            overlayType,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            PixelFormat.TRANSLUCENT);
    params.gravity = Gravity.TOP | Gravity.START;
    return params;
  }

  /**
   * Phase B: the informational "Inappropriate content" screen. Same full-bleed chrome as the mission
   * overlay (focus palette via OverlayChrome). No points, no penalty, no mission. Returns the root
   * view, or null if the overlay permission is missing or addView failed.
   */
  public static View attachBlock(
      Context context, WindowManager windowManager, Runnable onDismiss) {
    if (!canDrawOverlay(context)) {
      Log.e(TAG, "block screen blocked - SYSTEM_ALERT_WINDOW not granted");
      return null;
    }
    android.widget.FrameLayout root = new android.widget.FrameLayout(context);
    root.setBackgroundColor(androidx.core.content.ContextCompat.getColor(context, R.color.overlay_bg));
    root.setClickable(true);
    root.setFocusable(true);
    OverlayChrome.installInsetPadding(root);

    android.widget.LinearLayout card = OverlayChrome.buildCenteredScrollColumn(context, root);

    TextView title = OverlayChrome.titleView(context, context.getString(R.string.overlay_block_title));
    title.setTextSize(
        android.util.TypedValue.COMPLEX_UNIT_PX,
        context.getResources().getDimension(R.dimen.overlay_text_title));
    card.addView(title);

    TextView body = OverlayChrome.captionView(context);
    body.setText(context.getString(R.string.overlay_block_body));
    body.setTextColor(androidx.core.content.ContextCompat.getColor(context, R.color.overlay_description));
    body.setTextSize(
        android.util.TypedValue.COMPLEX_UNIT_PX,
        context.getResources().getDimension(R.dimen.overlay_text_description));
    body.setPadding(0, OverlayChrome.dp(context, 12), 0, OverlayChrome.dp(context, 20));
    card.addView(body);

    Button ok = new Button(context);
    ok.setText(context.getString(R.string.overlay_block_ok));
    ok.setAllCaps(false);
    ok.setTextColor(androidx.core.content.ContextCompat.getColor(context, R.color.overlay_btn_text));
    ok.setBackgroundTintList(
        android.content.res.ColorStateList.valueOf(
            androidx.core.content.ContextCompat.getColor(context, R.color.overlay_btn_complete_bg)));
    ok.setOnClickListener(v -> onDismiss.run());
    card.addView(ok);

    try {
      windowManager.addView(root, fullScreenParams());
      Log.i(TAG, "block screen attached");
      return root;
    } catch (Exception e) {
      Log.e(TAG, "block screen addView failed", e);
      return null;
    }
  }

  public static void detach(WindowManager windowManager, View overlayView) {
    if (windowManager == null || overlayView == null) {
      return;
    }
    try {
      windowManager.removeView(overlayView);
      Log.i(TAG, "overlay detached");
    } catch (Exception e) {
      Log.w(TAG, "removeView: " + e.getMessage());
    }
  }

  public static void detachOnMainThread(
      Handler mainHandler, WindowManager windowManager, View overlayView) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      detach(windowManager, overlayView);
    } else {
      mainHandler.post(() -> detach(windowManager, overlayView));
    }
  }

  private static int resolveCompleteLabel(Context context, String missionType) {
    switch (missionType) {
      case "real_world":
        return R.string.overlay_mission_complete_real_world;
      case "quiz":
        return R.string.overlay_mission_start_quiz;
      case "cognitive":
        return R.string.overlay_mission_start_cognitive;
      case "minigame":
        return R.string.overlay_mission_start_minigame;
      default:
        return R.string.overlay_mission_complete_default;
    }
  }

  private static void setButtonsEnabled(Button complete, Button later, boolean enabled) {
    complete.setEnabled(enabled);
    later.setEnabled(enabled);
    complete.setAlpha(enabled ? 1f : 0.5f);
    later.setAlpha(enabled ? 1f : 0.5f);
  }
}
