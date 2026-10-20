import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';

// ── Theme ──────────────────────────────────────────────────────────────────────
export const C = {
  bg:     '#0d0d18',
  panel:  '#10101e',
  border: '#1e1e2e',
  text:   '#ccc',
  dim:    '#555',
  green:  '#00d26a',
  red:    '#f44',
  accent: '#7b61ff',
};

// ── Data hook ──────────────────────────────────────────────────────────────────
export function useData(deviceId, type) {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (limit = 100) => {
    setLoading(true);
    try { setData(await api.getData(deviceId, type, limit)); }
    catch { setData([]); }
    finally { setLoading(false); }
  }, [deviceId, type]);

  return { data, loading, load };
}

// ── CCS payload parser ─────────────────────────────────────────────────────────
// CCS wraps payloads as {"type":"CONTACTS","data":"[{...json string...}]"}.
// The API stores the raw message; unwrap the JSON-string `data` field.
export function parseCcsData(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    const d = e?.data;
    if (typeof d === 'string') {
      try { return JSON.parse(d); } catch { /* fall through */ }
    }
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') return [d];
  }
  return [];
}

// ── Layout primitives ──────────────────────────────────────────────────────────
export function Card({ title, action, children }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text, letterSpacing: .5, textTransform: 'uppercase' }}>{title}</span>
          <div style={{ display: 'flex', gap: 6 }}>{action}</div>
        </div>
      )}
      {children}
    </div>
  );
}

export function Empty({ text }) {
  return (
    <div style={{ color: C.dim, fontSize: 12, padding: '18px 0', textAlign: 'center' }}>{text}</div>
  );
}

export function Table({ headers, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ textAlign: 'left', color: C.dim, fontWeight: 600, padding: '6px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${C.border}55` }}>
              {headers.map((h, j) => (
                <td key={j} style={{ padding: '6px 8px', color: C.text, verticalAlign: 'top', wordBreak: 'break-word' }}>{r[h]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Command button ─────────────────────────────────────────────────────────────
export function CmdBtn({ deviceId, action, params = {}, label, onDone }) {
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await api.sendCommand(deviceId, action, params);
      if (onDone) await onDone();
    } catch { /* surfaced via socket/data refresh */ }
    finally { setBusy(false); }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      style={{
        background: busy ? C.border : '#181828',
        border: `1px solid ${C.border}`,
        borderRadius: 5,
        color: busy ? C.dim : C.text,
        fontSize: 11,
        padding: '6px 12px',
        cursor: busy ? 'default' : 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
