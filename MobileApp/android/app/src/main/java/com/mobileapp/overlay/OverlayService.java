package com.mobileapp.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Browser;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.mobileapp.R;

/**
 * Foreground service that owns the full-screen mission overlay WindowManager view.
 */
public class OverlayService extends Service {

    public static final String ACTION_HIDE = "com.mobileapp.overlay.HIDE";
    /** Phase B: show the "Inappropriate content" block screen (never over a mission). */
    public static final String ACTION_SHOW_BLOCK = "com.mobileapp.overlay.SHOW_BLOCK";

    /** Phase B (B6): the mission overlay shows a browser-adult warning line when true. */
    public static final String EXTRA_BROWSER_ADULT = "browser_adult";

    /** What the current overlay view is. A mission always wins over the block screen. */
    public static final int KIND_NONE = 0;
    public static final int KIND_MISSION = 1;
    public static final int KIND_BLOCK = 2;

    public static final String EXTRA_MISSION_ID = "mission_id";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_DESCRIPTION = "description";
    public static final String EXTRA_POINTS = "points";
    public static final String EXTRA_MISSION_TYPE = "mission_type";
    public static final String EXTRA_METADATA_JSON = "metadata_json";

    private static final String CHANNEL_ID = "pfe_overlay_service";
    private static final int NOTIFICATION_ID = 1002;

    @Nullable
    private static OverlayService runningInstance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Nullable
    private WindowManager windowManager;

    /**
     * ALL_IS_FIXED #58: {@code volatile} for the same cross-thread-visibility reason as
     * {@link #pendingQuizCancel}/{@link #pendingTttCancel} below (#53) — written on the main
     * thread (directly, or via {@code mainHandler.post(...)}), now also read from the RN
     * native-modules thread by {@link #hasActiveOverlayView()}, which backs
     * {@code OverlayMissionModule.isOverlayShowing()}, the mission-capture-session backstop's
     * on-demand liveness query for the overlay path.
     */
    @Nullable
    private volatile View overlayView;

    /** Set with {@link #overlayView}, cleared wherever it is nulled. */
    private volatile int overlayKind = KIND_NONE;

    /**
     * ALL_IS_FIXED #46: cancels a pending answer-feedback "advance to next question" callback
     * (see {@link OverlayQuizHelper#showQuiz}) if the overlay is torn down while that hold is
     * pending — otherwise it would fire against detached views or double-complete the
     * mission. Set at the {@code onStartQuiz} call site below, invoked and cleared by both
     * removal paths ({@link #removeOverlayNow()} and {@link #removeOverlay()}) before they
     * detach the view — mirrors the existing {@link #overlayView} field pattern.
     *
     * {@code volatile} (ALL_IS_FIXED #53, A1): defensive hardening, not a fix for a
     * demonstrated race — every read in the current call graph already happens on the main
     * thread (either directly, or via {@code mainHandler.post(...)} when the caller isn't
     * already on it), so there is no cross-thread read of this field today. Kept {@code
     * volatile} anyway in case a future caller ever reads it off the main thread directly.
     */
    @Nullable
    private volatile Runnable pendingQuizCancel;

    /**
     * ALL_IS_FIXED #53: same shape as {@link #pendingQuizCancel}, for
     * {@link OverlayTicTacToeHelper#showGame}'s AI-move delay. A second field rather than a
     * shared one — only one surface is ever live at a time, so sharing would work, but it
     * would mean touching the already-device-verified quiz call sites for no behavioural gain.
     */
    @Nullable
    private volatile Runnable pendingTttCancel;

    @Nullable
    public static OverlayService getRunningInstance() {
        return runningInstance;
    }

    /**
     * ALL_IS_FIXED #58: backs {@code OverlayMissionModule.isOverlayShowing()} — an in-process,
     * immediately-resolved liveness check the mission-capture-session backstop asks (from JS) only
     * when its soft staleness threshold trips, instead of relying on a JS timer, which would
     * freeze for the overlay's entire display duration (the RN host is backgrounded the whole
     * time the overlay is shown over another app).
     */
    public boolean hasActiveOverlayView() {
        // A mission overlay only: the #58 lease backstop asks "is the MISSION still up?", and a
        // Phase B block screen must never keep a stale mission lease alive.
        return overlayView != null && overlayKind == KIND_MISSION;
    }

    public int getOverlayKind() {
        return overlayView == null ? KIND_NONE : overlayKind;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        runningInstance = this;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_HIDE.equals(intent.getAction())) {
            removeOverlayNow();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        boolean showBlock = intent != null && ACTION_SHOW_BLOCK.equals(intent.getAction());

        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (showBlock) {
            showBlockScreen();
        } else if (intent != null) {
            showOverlayFromIntent(intent);
        }
        return START_STICKY;
    }

    /** Phase B block screen. Refused (logged) if a mission overlay is up; replaces an older block screen. */
    private void showBlockScreen() {
        Runnable task =
                () -> {
                    if (overlayView != null && overlayKind == KIND_MISSION) {
                        android.util.Log.i("OverlayService", "block screen refused: mission overlay is up");
                        return;
                    }
                    removeOverlayNow();
                    if (windowManager == null) {
                        return;
                    }
                    OverlayWindowHelper.BlockDismissGate dismissGate =
                            new OverlayWindowHelper.BlockDismissGate();
                    Runnable onDismiss =
                            () ->
                                    dismissGate.dismiss(
                                            this::relaunchChromeToBlankTab,
                                            () -> {
                                                removeOverlayNow();
                                                Log.i(
                                                        "OverlayService",
                                                        "block screen OK: overlay removed after"
                                                                + " Chrome relaunch");
                                                stopForeground(true);
                                                stopSelf();
                                            });
                    View root =
                            OverlayWindowHelper.attachBlock(
                                    OverlayService.this, windowManager, onDismiss);
                    overlayView = root;
                    overlayKind = root != null ? KIND_BLOCK : KIND_NONE;
                    if (root == null) {
                        stopForeground(true);
                        stopSelf();
                    }
                };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
        } else {
            mainHandler.post(task);
        }
    }

    /**
     * Phase B (#61). Relaunches Chrome onto a blank tab so the child isn't left staring at the
     * adult page after OK.
     *
     * <p><b>Must run before the overlay is torn down.</b> The BAL (background-activity-launch)
     * grant this depends on — device-confirmed {@code BAL_ALLOW_NON_APP_VISIBLE_WINDOW}, #61
     * review r1/r2 A1 — is granted because our overlay window is still the visible non-app
     * window at the moment {@code startActivity} is called. Remove the overlay first and Android
     * can silently refuse the launch: the refusal is swallowed by this try/catch (degrading to
     * today's behaviour, per A3), so the failure would be invisible and the child would be left
     * on the adult page with no error shown anywhere. Ordering is enforced by
     * {@link OverlayWindowHelper.BlockDismissGate}, which always calls this before its teardown
     * {@link Runnable}.
     */
    private void relaunchChromeToBlankTab() {
        try {
            Intent relaunch = new Intent(Intent.ACTION_VIEW, Uri.parse("about:blank"));
            relaunch.setPackage("com.android.chrome");
            relaunch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            relaunch.putExtra(Browser.EXTRA_CREATE_NEW_TAB, true);
            Log.i("OverlayService", "block screen OK: relaunching Chrome to blank tab");
            startActivity(relaunch);
        } catch (Throwable t) {
            Log.w("OverlayService", "block screen OK: Chrome relaunch failed", t);
        }
    }

    private void showOverlayFromIntent(Intent intent) {
        String missionId = intent.getStringExtra(EXTRA_MISSION_ID);
        String title = intent.getStringExtra(EXTRA_TITLE);
        String description = intent.getStringExtra(EXTRA_DESCRIPTION);
        int points = intent.getIntExtra(EXTRA_POINTS, 0);
        String missionType = intent.getStringExtra(EXTRA_MISSION_TYPE);
        String metadataJson = intent.getStringExtra(EXTRA_METADATA_JSON);
        boolean browserAdult = intent.getBooleanExtra(EXTRA_BROWSER_ADULT, false);

        if (missionId == null) {
            return;
        }

        Runnable attachTask =
                () -> {
                    removeOverlayNow();
                    if (windowManager == null) {
                        return;
                    }
                    View root =
                            OverlayWindowHelper.attach(
                                    OverlayService.this,
                                    windowManager,
                                    missionId,
                                    title != null ? title : "Mission",
                                    description != null ? description : "",
                                    points,
                                    missionType != null ? missionType : "real_world",
                                    metadataJson != null ? metadataJson : "{}",
                                    browserAdult,
                                    new OverlayWindowHelper.ActionListener() {
                                        @Override
                                        public void onStartQuiz(
                                                android.view.View overlayRoot,
                                                String id,
                                                String quizTitle,
                                                int quizPoints,
                                                String meta) {
                                            pendingQuizCancel =
                                                    OverlayQuizHelper.showQuiz(
                                                    OverlayService.this,
                                                    overlayRoot,
                                                    id,
                                                    quizTitle,
                                                    quizPoints,
                                                    meta,
                                                    new OverlayQuizHelper.QuizFinishedListener() {
                                                        @Override
                                                        public void onQuizFinished(
                                                                String missionId,
                                                                String type,
                                                                String metadataJson) {
                                                            OverlayEventBridge.emitMissionAction(
                                                                    missionId,
                                                                    "complete",
                                                                    type,
                                                                    metadataJson);
                                                        }

                                                        @Override
                                                        public void onQuizNeedsInApp(
                                                                String missionId,
                                                                String t,
                                                                int pts,
                                                                String type,
                                                                String metadataJson) {
                                                            OverlayMissionLauncher.launchMissionApp(
                                                                    OverlayService.this,
                                                                    missionId,
                                                                    t,
                                                                    "",
                                                                    pts,
                                                                    type,
                                                                    metadataJson);
                                                            OverlayEventBridge.emitMissionAction(
                                                                    missionId,
                                                                    "start",
                                                                    type,
                                                                    metadataJson);
                                                        }
                                                    });
                                        }

                                        @Override
                                        public void onStartInAppMission(
                                                String id,
                                                String t,
                                                String desc,
                                                int pts,
                                                String type,
                                                String meta) {
                                            OverlayMissionLauncher.launchMissionApp(
                                                    OverlayService.this,
                                                    id,
                                                    t,
                                                    desc,
                                                    pts,
                                                    type,
                                                    meta);
                                            OverlayEventBridge.emitMissionAction(
                                                    id, "start", type, meta);
                                        }

                                        @Override
                                        public void onStartTicTacToe(
                                                android.view.View overlayRoot,
                                                String id,
                                                String t,
                                                int pts,
                                                String meta) {
                                            pendingTttCancel =
                                                    OverlayTicTacToeHelper.showGame(
                                                    OverlayService.this,
                                                    overlayRoot,
                                                    id,
                                                    t,
                                                    pts,
                                                    meta,
                                                    new OverlayTicTacToeHelper.GameFinishedListener() {
                                                        @Override
                                                        public void onGameFinished(
                                                                String missionId,
                                                                String type,
                                                                String metadataJson) {
                                                            OverlayEventBridge.emitMissionAction(
                                                                    missionId,
                                                                    "complete",
                                                                    type,
                                                                    metadataJson);
                                                        }

                                                        @Override
                                                        public void onGameNeedsInApp(
                                                                String missionId,
                                                                String t2,
                                                                int pts2,
                                                                String type,
                                                                String metadataJson) {
                                                            OverlayMissionLauncher.launchMissionApp(
                                                                    OverlayService.this,
                                                                    missionId,
                                                                    t2,
                                                                    "",
                                                                    pts2,
                                                                    type,
                                                                    metadataJson);
                                                            OverlayEventBridge.emitMissionAction(
                                                                    missionId,
                                                                    "start",
                                                                    type,
                                                                    metadataJson);
                                                        }
                                                    });
                                        }

                                        @Override
                                        public void onComplete(
                                                String id, String type, String meta) {
                                            OverlayEventBridge.emitMissionAction(
                                                    id, "complete", type, meta);
                                        }

                                        @Override
                                        public void onAbandon(
                                                String id, String type, String meta) {
                                            OverlayEventBridge.emitMissionAction(
                                                    id, "abandon", type, meta);
                                        }
                                    });
                    overlayView = root;
                    overlayKind = root != null ? KIND_MISSION : KIND_NONE;
                };

        if (Looper.myLooper() == Looper.getMainLooper()) {
            attachTask.run();
        } else {
            mainHandler.post(attachTask);
        }
    }

    /** Cancels any pending quiz answer-feedback advance before the view it targets is torn
     * down (ALL_IS_FIXED #46) — the single place both removal paths funnel through. */
    private void cancelPendingQuizAdvance() {
        if (pendingQuizCancel != null) {
            pendingQuizCancel.run();
            pendingQuizCancel = null;
        }
    }

    /** Cancels a pending Tic-Tac-Toe AI-move advance before the view it targets is torn down
     * (ALL_IS_FIXED #53) — mirrors {@link #cancelPendingQuizAdvance()} exactly. */
    private void cancelPendingTttAdvance() {
        if (pendingTttCancel != null) {
            pendingTttCancel.run();
            pendingTttCancel = null;
        }
    }

    /** Synchronous remove on main thread — avoids racing addView with a posted remove. */
    private void removeOverlayNow() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            cancelPendingQuizAdvance();
            cancelPendingTttAdvance();
            if (windowManager != null && overlayView != null) {
                OverlayWindowHelper.detach(windowManager, overlayView);
                overlayView = null;
overlayKind = KIND_NONE;
            }
            return;
        }
        mainHandler.post(
                () -> {
                    cancelPendingQuizAdvance();
                    cancelPendingTttAdvance();
                    if (windowManager != null && overlayView != null) {
                        OverlayWindowHelper.detach(windowManager, overlayView);
                        overlayView = null;
overlayKind = KIND_NONE;
                    }
                });
    }

    public void removeOverlay() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            cancelPendingQuizAdvance();
            cancelPendingTttAdvance();
            if (windowManager != null && overlayView != null) {
                OverlayWindowHelper.detach(windowManager, overlayView);
                overlayView = null;
overlayKind = KIND_NONE;
            }
        } else {
            mainHandler.post(
                    () -> {
                        cancelPendingQuizAdvance();
                        cancelPendingTttAdvance();
                        if (windowManager != null && overlayView != null) {
                            OverlayWindowHelper.detach(windowManager, overlayView);
                            overlayView = null;
overlayKind = KIND_NONE;
                        }
                    });
        }
    }

    @Override
    public void onDestroy() {
        removeOverlayNow();
        if (runningInstance == this) {
            runningInstance = null;
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel =
                    new NotificationChannel(
                            CHANNEL_ID,
                            getString(R.string.overlay_service_channel_name),
                            NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(getString(R.string.overlay_service_notification_title))
                .setContentText(getString(R.string.overlay_service_notification_text))
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
