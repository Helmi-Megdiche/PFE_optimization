package com.mobileapp.foreground;

import android.app.ActivityManager;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;

import java.util.List;
import java.util.SortedMap;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Resolves foreground app via UsageStatsManager, with ActivityManager fallback.
 */
public class ForegroundAppModule extends ReactContextBaseJavaModule {

    private static final String TAG = "ForegroundAppModule";
    public static final String NAME = "ForegroundApp";

    /** UsageEvents: look back far enough to survive 60s capture intervals. */
    private static final long USAGE_EVENTS_WINDOW_MS = 120_000L;
    /** queryUsageStats fallback: ignore apps not used in the last few seconds. */
    private static final long USAGE_STATS_RECENCY_MS = 5_000L;
    /** Bounds getCurrentForegroundApp's Future.get wait — see ALL_IS_FIXED #11 (F2). */
    private static final long FUTURE_GET_TIMEOUT_MS = 2_500L;
    /**
     * How long the single worker may sit occupied before a rejected submission is treated
     * as a genuine wedge and the executor is replaced. Justified on its own terms: a
     * healthy UsageStats query completes in low single-digit milliseconds under normal
     * conditions (see ForegroundApp.ts's resolveForegroundApp callers), so 60s leaves
     * enormous margin before a merely-slow call could ever be mistaken for a wedge. Waiting
     * this long before reclaiming the pool costs nothing in attribution quality: a call
     * this deep into E_FOREGROUND_BUSY rejections already reads as "unknown" to the JS
     * caller — the same outcome a genuine wedge produces anyway. This constant only decides
     * how soon the module reclaims the occupied thread, not what the caller sees meanwhile.
     */
    private static final long EXECUTOR_WEDGE_RECOVERY_MS = 60_000L;

    private volatile ExecutorService executor = newExecutor();
    private volatile long currentTaskSubmittedAtMs = 0;
    private volatile boolean destroyed = false;

    private static ExecutorService newExecutor() {
        return new ThreadPoolExecutor(
                1, 1, 0L, TimeUnit.MILLISECONDS,
                new SynchronousQueue<Runnable>()
                // core=max=1 + zero-capacity queue: at most one lookup ever in flight; a
                // second concurrent submit() fails fast via the default AbortPolicy instead
                // of queuing behind a possibly-wedged worker. Do not change these two "1"s.
        );
    }

    public ForegroundAppModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return NAME;
    }

    @Override
    public void invalidate() {
        destroyed = true;
        executor.shutdownNow();
        super.invalidate();
    }

    @ReactMethod
    public void hasUsageAccess(Promise promise) {
        promise.resolve(hasUsageStatsPermission());
    }

    /** Alias for JS clarity (Sprint 3.7). */
    @ReactMethod
    public void hasUsageStatsPermission(Promise promise) {
        promise.resolve(hasUsageStatsPermission());
    }

    @ReactMethod
    public void openUsageAccessSettings(Promise promise) {
        try {
            Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("E_SETTINGS", "Cannot open usage access settings", e);
        }
    }

    /**
     * Returns foreground package + label. Never rejects — uses fallback when Usage access is missing.
     *
     * The actual UsageStats/ActivityManager resolution ({@link #resolveForegroundAppBlocking})
     * runs on a bounded, self-recovering background executor so a blocked Binder call into
     * the system server (which cannot be interrupted or given a client-side timeout) can
     * never hang this method beyond {@link #FUTURE_GET_TIMEOUT_MS} (ALL_IS_FIXED #11, F2).
     */
    @ReactMethod
    public void getCurrentForegroundApp(Promise promise) {
        Log.d(TAG, "getCurrentForegroundApp() called");
        final String ownPackage = getReactApplicationContext().getPackageName();

        Future<WritableMap> future;
        try {
            future = executor.submit(() -> resolveForegroundAppBlocking(ownPackage));
            currentTaskSubmittedAtMs = System.currentTimeMillis();
        } catch (RejectedExecutionException e) {
            if (destroyed) {
                // invalidate() already shut this executor down for teardown, not because
                // of a wedge — never treat that as a recovery opportunity.
                try {
                    promise.reject("E_FOREGROUND_BUSY", "module invalidated");
                } catch (Throwable ignored) {
                }
                return;
            }
            // currentTaskSubmittedAtMs == 0 means no task has ever been submitted from this
            // executor generation — treat as "not stuck", not as "stuck since the epoch"
            // (System.currentTimeMillis() - 0 would otherwise be astronomically over the
            // threshold and fire recovery on the very first rejection).
            long stuckForMs = currentTaskSubmittedAtMs == 0
                    ? 0
                    : System.currentTimeMillis() - currentTaskSubmittedAtMs;
            if (stuckForMs < EXECUTOR_WEDGE_RECOVERY_MS) {
                try {
                    promise.reject("E_FOREGROUND_BUSY",
                            "previous lookup still in flight (" + stuckForMs + "ms)");
                } catch (Throwable ignored) {
                }
                return;
            }
            // Presumed permanently wedged: replace the executor. shutdown() (not
            // shutdownNow()) on the old one — it cannot interrupt a blocked Binder ioctl
            // now, but it does tell the pool to retire that worker once (if) the call ever
            // actually returns, so a merely-very-slow call still cleans up instead of
            // lingering forever.
            Log.w(TAG, "getCurrentForegroundApp — executor presumed wedged after "
                    + stuckForMs + "ms, replacing");
            ExecutorService old = executor;
            executor = newExecutor();
            old.shutdown();
            try {
                future = executor.submit(() -> resolveForegroundAppBlocking(ownPackage));
                currentTaskSubmittedAtMs = System.currentTimeMillis();
            } catch (RejectedExecutionException e2) {
                try {
                    promise.reject("E_FOREGROUND_BUSY", "recovery submit failed");
                } catch (Throwable ignored) {
                }
                return;
            }
        }

        try {
            WritableMap result = future.get(FUTURE_GET_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            try {
                promise.resolve(result);
            } catch (Throwable t) {
                Log.e(TAG, "getCurrentForegroundApp — resolve threw", t);
            }
        } catch (TimeoutException te) {
            try {
                promise.reject("E_FOREGROUND_TIMEOUT", "native lookup exceeded "
                        + FUTURE_GET_TIMEOUT_MS + "ms");
            } catch (Throwable ignored) {
            }
            // Deliberately no future.cancel(true) — a blocked Binder transaction cannot be
            // interrupted (very likely true per Binder's ioctl-level blocking; not verified
            // on-device).
        } catch (Exception e) {
            Log.e(TAG, "getCurrentForegroundApp failed", e);
            try {
                promise.reject("E_FOREGROUND", e.getMessage());
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * The actual (blocking) foreground-app resolution — runs on the background executor,
     * never on the calling thread. {@code ownPackage} is passed in rather than read here via
     * {@code getReactApplicationContext()}: an abandoned worker thread (the one case this
     * design deliberately lets keep running past the caller's timeout) is exactly the thread
     * most likely to still be alive after the RN catalyst is torn down, so the bridge thread
     * reads it once, up front, instead.
     */
    private WritableMap resolveForegroundAppBlocking(String ownPackage) {
        if (hasUsageStatsPermission()) {
            WritableMap usage = resolveFromUsageStats(ownPackage);
            if (usage != null) {
                usage.putString("source", "usage_stats");
                Log.d(TAG, "getCurrentForegroundApp usage_stats => "
                        + usage.getString("packageName"));
                return usage;
            }
        } else {
            Log.w(TAG, "Usage access not granted — trying ActivityManager fallback");
        }

        WritableMap fallback = resolveFromActivityManager(ownPackage);
        if (fallback != null) {
            fallback.putString("source", "activity_manager");
            Log.d(TAG, "getCurrentForegroundApp fallback => "
                    + fallback.getString("packageName"));
            return fallback;
        }

        Log.w(TAG, "getCurrentForegroundApp => null (no foreground detected)");
        return null;
    }

    private WritableMap resolveFromUsageStats(String ownPackage) {
        UsageStatsManager usm = (UsageStatsManager)
                getReactApplicationContext().getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) {
            return null;
        }

        long end = System.currentTimeMillis();
        long start = end - USAGE_EVENTS_WINDOW_MS;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            WritableMap fromEvents = resolveFromUsageEvents(usm, start, end, ownPackage);
            if (fromEvents != null) {
                return fromEvents;
            }
        }

        List<UsageStats> stats = usm.queryUsageStats(
                UsageStatsManager.INTERVAL_BEST,
                start,
                end
        );

        if (stats == null || stats.isEmpty()) {
            return null;
        }

        SortedMap<Long, UsageStats> sorted = new TreeMap<>();
        for (UsageStats usage : stats) {
            long lastUsed = usage.getLastTimeUsed();
            if (lastUsed <= 0 || ownPackage.equals(usage.getPackageName())) {
                continue;
            }
            if (shouldSkipForegroundPackage(usage.getPackageName())) {
                continue;
            }
            // Ignore stale entries — Instagram background sync can beat Messenger otherwise.
            if (end - lastUsed > USAGE_STATS_RECENCY_MS) {
                continue;
            }
            sorted.put(lastUsed, usage);
        }

        if (sorted.isEmpty()) {
            return null;
        }

        UsageStats recent = sorted.get(sorted.lastKey());
        return buildResult(recent.getPackageName(), recent.getLastTimeUsed());
    }

    private WritableMap resolveFromUsageEvents(
            UsageStatsManager usm,
            long start,
            long end,
            String ownPackage
    ) {
        UsageEvents events = usm.queryEvents(start, end);
        if (events == null) {
            return null;
        }

        String lastPackage = null;
        long lastTime = 0;
        UsageEvents.Event event = new UsageEvents.Event();

        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            int type = event.getEventType();
            if (type == UsageEvents.Event.MOVE_TO_FOREGROUND
                    || type == UsageEvents.Event.ACTIVITY_RESUMED) {
                String pkg = event.getPackageName();
                if (pkg == null || ownPackage.equals(pkg) || shouldSkipForegroundPackage(pkg)) {
                    continue;
                }
                if (event.getTimeStamp() >= lastTime) {
                    lastTime = event.getTimeStamp();
                    lastPackage = pkg;
                }
            }
        }

        if (lastPackage == null) {
            return null;
        }
        return buildResult(lastPackage, lastTime);
    }

    private WritableMap resolveFromActivityManager(String ownPackage) {
        ActivityManager am = (ActivityManager)
                getReactApplicationContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) {
            return null;
        }

        List<ActivityManager.RunningAppProcessInfo> processes = am.getRunningAppProcesses();
        if (processes == null) {
            return null;
        }

        for (ActivityManager.RunningAppProcessInfo proc : processes) {
            if (proc.importance != ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
                continue;
            }
            String packageName = proc.pkgList != null && proc.pkgList.length > 0
                    ? proc.pkgList[0]
                    : proc.processName;
            if (packageName == null || ownPackage.equals(packageName)) {
                continue;
            }
            if (shouldSkipForegroundPackage(packageName)) {
                continue;
            }
            if (packageName.contains(":")) {
                packageName = packageName.split(":")[0];
            }
            if (ownPackage.equals(packageName)) {
                continue;
            }
            return buildResult(packageName, System.currentTimeMillis());
        }

        return null;
    }

    private WritableMap buildResult(String packageName, long lastTimeUsed) {
        WritableMap map = Arguments.createMap();
        map.putString("packageName", packageName);
        map.putString("appLabel", resolveAppLabel(packageName));
        map.putDouble("lastTimeUsed", lastTimeUsed);
        return map;
    }

    private boolean shouldSkipForegroundPackage(String packageName) {
        if (packageName == null) {
            return true;
        }
        if ("com.android.systemui".equals(packageName)) {
            return true;
        }
        if (packageName.contains("launcher")) {
            return true;
        }
        return false;
    }

    private boolean hasUsageStatsPermission() {
        Context ctx = getReactApplicationContext();
        AppOpsManager appOps = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) {
            return false;
        }
        int mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                ctx.getPackageName()
        );
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    private String resolveAppLabel(String packageName) {
        try {
            PackageManager pm = getReactApplicationContext().getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            CharSequence label = pm.getApplicationLabel(info);
            return label != null ? label.toString() : packageName;
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }
}
