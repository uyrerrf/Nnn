import { useState, useEffect } from 'react';
import { subscribeType } from '../../lib/socket';

export default function LocationTab({ device, send }) {
  const [loc,       setLoc]       = useState(null);
  const [tracking,  setTracking]  = useState(false);
  const [history,   setHistory]   = useState([]);
  const [loading,   setLoading]   = useState(false);

  useEffect(() => {
    const unsub = subscribeType(device.id, ['LOCATION', 'location', 'GPS'], (msg) => {
      setLoading(false);
      if (msg.enabled === false) return;
      const entry = {
        lat:       msg.latitude  || msg.lat,
        lng:       msg.longitude || msg.lng,
        accuracy:  msg.accuracy,
        speed:     msg.speed,
        provider:  msg.provider,
        altitude:  msg.altitude,
        bearing:   msg.bearing,
        time:      msg.timestamp || Date.now(),
      };
      setLoc(entry);
      setHistory(prev => [entry, ...prev].slice(0, 50));
    });
    return unsub;
  }, [device.id]);

  useEffect(() => {
    let interval;
    if (tracking) {
      interval = setInterval(() => send('GET_LOCATION'), 10_000);
    }
    return () => clearInterval(interval);
  }, [tracking, send]);

  const requestOnce = () => {
    setLoading(true);
    send('GET_LOCATION');
    setTimeout(() => setLoading(false), 10_000);
  };

  const mapsUrl = loc
    ? `https://maps.google.com/?q=${loc.lat},${loc.lng}`
    : null;

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <Btn onClick={requestOnce} loading={loading}>{loading ? 'Getting…' : 'GET ONCE'}</Btn>
        <Btn
          onClick={() => setTracking(!tracking)}
          active={tracking}
          color={tracking ? '#f5a623' : undefined}
        >
          {tracking ? 'STOP TRACK' : 'TRACK (10s)'}
        </Btn>
        {mapsUrl && (
          <a href={mapsUrl} target="_blank" rel="noreferrer" style={S.mapLink}>
            OPEN MAP ↗
          </a>
        )}
      </div>

      {!loc && !loading && (
        <div style={S.empty}>No location data. Press GET ONCE.</div>
      )}

      {loading && !loc && (
        <div style={S.empty}>Requesting GPS fix…</div>
      )}

      {loc && (
        <div style={S.card}>
          <Row label="Latitude"  value={loc.lat?.toFixed(7)} />
          <Row label="Longitude" value={loc.lng?.toFixed(7)} />
          {loc.accuracy  != null && <Row label="Accuracy"  value={`±${loc.accuracy?.toFixed(1)}m`} />}
          {loc.altitude  != null && <Row label="Altitude"  value={`${loc.altitude?.toFixed(1)}m`} />}
          {loc.speed     != null && <Row label="Speed"     value={`${(loc.speed * 3.6).toFixed(1)} km/h`} />}
          {loc.bearing   != null && <Row label="Bearing"   value={`${loc.bearing?.toFixed(1)}°`} />}
          {loc.provider         && <Row label="Provider"  value={loc.provider} />}
          <Row label="Time" value={new Date(loc.time).toLocaleTimeString()} />
        </div>
      )}

      {history.length > 1 && (
        <div style={S.histSection}>
          <div style={S.histTitle}>HISTORY ({history.length})</div>
          <div style={S.histList}>
            {history.map((h, i) => (
              <div key={i} style={S.histRow}>
                <span style={S.histCoords}>{h.lat?.toFixed(5)}, {h.lng?.toFixed(5)}</span>
                <span style={S.histAcc}>±{h.accuracy?.toFixed(0)}m</span>
                <span style={S.histTime}>{new Date(h.time).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #12121e' }}>
      <span style={{ fontSize: 11, color: '#444', width: 90, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 11, color: '#ccc', fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

function Btn({ onClick, active, color, loading, children }) {
  const c = color || '#00d26a';
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: active ? c + '22' : 'transparent',
      border: `1px solid ${active ? c : '#222'}`,
      color: active ? c : '#666',
      fontSize: 11, padding: '4px 10px', borderRadius: 4,
      cursor: loading ? 'default' : 'pointer', fontFamily: 'inherit',
      opacity: loading ? .6 : 1,
    }}>{children}</button>
  );
}

const S = {
  root:  { display: 'flex', flexDirection: 'column', gap: 14 },
  bar:   { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  empty: { color: '#333', fontSize: 12, textAlign: 'center', marginTop: 40 },
  card:  { background: '#0d0d18', border: '1px solid #1a1a24', borderRadius: 6, padding: '12px 14px' },
  mapLink: {
    fontSize: 11, color: '#7b61ff', textDecoration: 'none',
    border: '1px solid #7b61ff44', padding: '4px 10px', borderRadius: 4,
  },
  histSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  histTitle:   { fontSize: 9, color: '#333', letterSpacing: 1.5, textTransform: 'uppercase' },
  histList:    { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 200, overflowY: 'auto' },
  histRow:     { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0',
                 borderBottom: '1px solid #0f0f18' },
  histCoords:  { fontSize: 11, fontFamily: 'monospace', color: '#888', flex: 1 },
  histAcc:     { fontSize: 10, color: '#444' },
  histTime:    { fontSize: 10, color: '#333' },
};
