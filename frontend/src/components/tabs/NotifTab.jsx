import { useState, useEffect, useRef } from 'react';

export default function NotifTab({ device, data, send }) {
  const [notifs,   setNotifs]   = useState([]);
  const [filter,   setFilter]   = useState('');
  const [paused,   setPaused]   = useState(false);
  const bufRef = useRef([]);

  useEffect(() => {
    const handler = (e) => {
      const { deviceId, msg } = e.detail;
      if (deviceId !== device.id) return;
      if (msg.type !== 'notif' && msg._type !== 'notif' && !msg.package_name) return;
      if (msg.removed) {
        setNotifs(prev => prev.filter(n => !(n.pkg === msg.package_name && n.id === msg.id)));
        return;
      }
      const entry = {
        pkg:      msg.package_name || '',
        app:      msg.app_name     || msg.package_name || '',
        title:    msg.title        || '',
        content:  msg.content      || '',
        time:     msg.post_time    || msg.timestamp || Date.now(),
        id:       msg.id,
        category: msg.category     || '',
        ongoing:  !!msg.ongoing,
      };
      if (!paused) {
        setNotifs(prev => [entry, ...prev].slice(0, 500));
      } else {
        bufRef.current.push(entry);
      }
    };
    window.addEventListener('rat_msg', handler);
    return () => window.removeEventListener('rat_msg', handler);
  }, [device.id, paused]);

  const resume = () => {
    setPaused(false);
    if (bufRef.current.length > 0) {
      setNotifs(prev => [...bufRef.current.reverse(), ...prev].slice(0, 500));
      bufRef.current = [];
    }
  };

  const filtered = filter
    ? notifs.filter(n =>
        [n.app, n.title, n.content].some(s => s.toLowerCase().includes(filter.toLowerCase()))
      )
    : notifs;

  return (
    <div style={S.root}>
      <div style={S.toolbar}>
        <input style={S.search} placeholder="Filter…" value={filter}
          onChange={e => setFilter(e.target.value)} />
        <Btn onClick={() => paused ? resume() : setPaused(true)} active={paused}>
          {paused ? `RESUME (${bufRef.current.length})` : 'PAUSE'}
        </Btn>
        <Btn onClick={() => setNotifs([])}>CLEAR</Btn>
        <span style={{ fontSize: 11, color: '#444', marginLeft: 'auto' }}>{filtered.length}</span>
      </div>
      {filtered.length === 0
        ? <div style={S.empty}>Waiting for notifications…</div>
        : <div style={S.list}>
            {filtered.map((n, i) => (
              <div key={i} style={{ ...S.card, borderLeft: `3px solid ${pkgColor(n.pkg)}` }}>
                <div style={S.cardTop}>
                  <span style={{ ...S.appName, color: pkgColor(n.pkg) }}>{n.app}</span>
                  {n.ongoing && <span style={S.badge}>ONGOING</span>}
                  {n.category && <span style={S.badge}>{n.category}</span>}
                  <span style={S.time}>{fmtTime(n.time)}</span>
                </div>
                {n.title   && <div style={S.title}>{n.title}</div>}
                {n.content && <div style={S.content}>{n.content}</div>}
                <div style={S.pkg}>{n.pkg}</div>
              </div>
            ))}
          </div>
      }
    </div>
  );
}

function pkgColor(pkg) {
  if (!pkg) return '#555';
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = pkg.charCodeAt(i) + ((h << 5) - h);
  return ['#7b61ff','#00d26a','#f5a623','#61b3ff','#ff6b8a','#61ffee'][Math.abs(h) % 6];
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function Btn({ onClick, active, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? '#00d26a22' : 'transparent',
      border: `1px solid ${active ? '#00d26a' : '#222'}`,
      color: active ? '#00d26a' : '#666',
      fontSize: 11, padding: '4px 10px', borderRadius: 4,
      cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
  );
}

const S = {
  root:    { display:'flex', flexDirection:'column', gap:10, height:'100%', overflow:'hidden' },
  toolbar: { display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', flexShrink:0 },
  search:  { flex:1, minWidth:140, background:'#0d0d18', border:'1px solid #1e1e2a',
             color:'#ccc', fontSize:12, padding:'5px 10px', borderRadius:4, outline:'none', fontFamily:'monospace' },
  list:    { flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:6 },
  empty:   { color:'#333', fontSize:12, textAlign:'center', marginTop:40 },
  card:    { background:'#0d0d18', border:'1px solid #1a1a24', borderRadius:5,
             padding:'8px 12px', display:'flex', flexDirection:'column', gap:3 },
  cardTop: { display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' },
  appName: { fontSize:11, fontWeight:700, fontFamily:'monospace' },
  badge:   { background:'#1a1a2a', color:'#555', fontSize:9, padding:'1px 5px', borderRadius:3 },
  time:    { marginLeft:'auto', fontSize:10, color:'#444' },
  title:   { fontSize:13, color:'#ccc', fontWeight:600 },
  content: { fontSize:12, color:'#888', lineHeight:1.4 },
  pkg:     { fontSize:9, color:'#333', fontFamily:'monospace', marginTop:2 },
};
