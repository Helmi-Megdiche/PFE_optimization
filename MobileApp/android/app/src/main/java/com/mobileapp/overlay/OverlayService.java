package com.mobileapp.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
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
    @Nullable
    private View overlayView;

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

        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (intent != null) {
            showOverlayFromIntent(intent);
        }
        return START_STICKY;
    }

    private void showOverlayFromIntent(Intent intent) {
        String missionId = intent.getStringExtra(EXTRA_MISSION_ID);
        String title = intent.getStringExtra(EXTRA_TITLE);
        String description = intent.getStringExtra(EXTRA_DESCRIPTION);
        int points = intent.getIntExtra(EXTRA_POINTS, 0);
        String missionType = intent.getStringExtra(EXTRA_MISSION_TYPE);
        String metadataJson = intent.getStringExtra(EXTRA_METADATA_JSON);

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
            }
        } else {
            mainHandler.post(
                    () -> {
                        cancelPendingQuizAdvance();
                        cancelPendingTttAdvance();
                        if (windowManager != null && overlayView != null) {
                            OverlayWindowHelper.detach(windowManager, overlayView);
                            overlayView = null;
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
