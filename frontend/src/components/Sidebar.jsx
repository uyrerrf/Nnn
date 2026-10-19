const S = {
  root: (open) => ({
    width: 220,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#0a0a14',
    borderRight: '1px solid #1a1a24',
    overflow: 'hidden',
    transition: 'transform .2s',
    '@media (max-width: 768px)': {},
  }),
  header: {
    padding: '12px 14px 8px',
    borderBottom: '1px solid #1a1a24',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  logoText: {
    fontSize: 13,
    fontWeight: 700,
    color: '#00d26a',
    letterSpacing: 1,
    fontFamily: 'monospace',
  },
  wsIndicator: (state) => ({
    width: 7, height: 7,
    borderRadius: '50%',
    background: state === 'connected' ? '#00d26a' : state === 'connecting' ? '#f5a623' : '#f44',
    boxShadow: state === 'connected' ? '0 0 5px #00d26a' : 'none',
    flexShrink: 0,
  }),
  section: {
    padding: '8px 14px 4px',
    fontSize: 10,
    color: '#333',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  deviceList: {
    flex: 1,
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    scrollbarColor: '#1a1a24 transparent',
  },
  device: (selected, online) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '9px 14px',
    cursor: 'pointer',
    background: selected ? '#13131f' : 'transparent',
    borderLeft: selected ? '2px solid #00d26a' : '2px solid transparent',
    transition: 'background .12s',
    userSelect: 'none',
  }),
  dot: (online) => ({
    width: 7, height: 7,
    borderRadius: '50%',
    background: online ? '#00d26a' : '#2a2a3a',
    boxShadow: online ? '0 0 4px #00d26a66' : 'none',
    flexShrink: 0,
  }),
  deviceName: {
    fontSize: 12,
    color: '#ccc',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deviceSub: {
    fontSize: 10,
    color: '#444',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginTop: 1,
  },
  battery: (level) => ({
    marginLeft: 'auto',
    fontSize: 10,
    color: level < 20 ? '#f44' : level < 50 ? '#f5a623' : '#00d26a',
    flexShrink: 0,
  }),
  footer: {
    padding: '10px 14px',
    borderTop: '1px solid #1a1a24',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  logoutBtn: {
    background: 'none',
    border: '1px solid #222',
    borderRadius: 4,
    color: '#555',
    fontSize: 11,
    padding: '4px 10px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'color .12s, border-color .12s',
  },
  count: {
    fontSize: 10,
    color: '#333',
  },
};

export default function Sidebar({ devices, selectedId, onSelect, onLogout, wsState, sidebarOpen }) {
  const online  = devices.filter(d => d.online).length;
  const offline = devices.filter(d => !d.online).length;

  return (
    <aside style={{
      width: 220,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      background: '#0a0a14',
      borderRight: '1px solid #1a1a24',
      overflow: 'hidden',
      position: 'relative',
      zIndex: 60,
    }}>

      {/* Logo + status */}
      <div style={S.header}>
        <span style={S.logoText}>C2 PANEL</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: '#333' }}>
            {online > 0 ? `${online} live` : 'offline'}
          </span>
          <div style={S.wsIndicator(wsState)} />
        </div>
      </div>

      {/* Online devices */}
      {online > 0 && (
        <>
          <div style={S.section}>ONLINE — {online}</div>
          <div style={{ ...S.deviceList, maxHeight: offline > 0 ? '50%' : undefined }}>
            {devices.filter(d => d.online).map(d => (
              <DeviceRow
                key={d.id}
                device={d}
                selected={selectedId === d.id}
                onClick={() => onSelect(d.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Offline devices */}
      {offline > 0 && (
        <>
          <div style={S.section}>OFFLINE — {offline}</div>
          <div style={S.deviceList}>
            {devices.filter(d => !d.online).map(d => (
              <DeviceRow
                key={d.id}
                device={d}
                selected={selectedId === d.id}
                onClick={() => onSelect(d.id)}
              />
            ))}
          </div>
        </>
      )}

      {devices.length === 0 && (
        <div style={{ padding: '20px 14px', fontSize: 11, color: '#333', textAlign: 'center' }}>
          No devices
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Footer */}
      <div style={S.footer}>
        <span style={S.count}>{devices.length} total</span>
        <button
          style={S.logoutBtn}
          onClick={onLogout}
          onMouseOver={e => { e.target.style.color = '#aaa'; e.target.style.borderColor = '#444'; }}
          onMouseOut={e  => { e.target.style.color = '#555'; e.target.style.borderColor = '#222'; }}
        >
          logout
        </button>
      </div>
    </aside>
  );
}

function DeviceRow({ device: d, selected, onClick }) {
  return (
    <div
      style={S.device(selected, d.online)}
      onClick={onClick}
      onMouseOver={e => { if (!selected) e.currentTarget.style.background = '#0f0f1a'; }}
      onMouseOut={e  => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={S.dot(d.online)} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={S.deviceName}>
          {d.alias || d.model || d.id.slice(0, 12)}
        </div>
        <div style={S.deviceSub}>
          {[d.manufacturer, d.android_version && `API ${d.android_version}`]
            .filter(Boolean).join(' · ')}
        </div>
      </div>
      {d.battery_level >= 0 && (
        <span style={S.battery(d.battery_level)}>{d.battery_level}%</span>
      )}
    </div>
  );
}
