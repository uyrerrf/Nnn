import { useState, useEffect, useRef } from 'react';
import { subscribeType } from '../../lib/socket';

export default function ShellTab({ device, send }) {
  const [lines,   setLines]   = useState([]);
  const [input,   setInput]   = useState('');
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [cwd,     setCwd]     = useState('~');
  const inputRef  = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    const unsub = subscribeType(device.id, ['SHELL_RESULT', 'shell_result'], (msg) => {
      const out = msg.output || msg.result || msg.data || '';
      const err = msg.error  || '';
      if (msg.cwd) setCwd(msg.cwd);
      setLines(prev => [
        ...prev,
        ...(out ? [{ type: 'out', text: out }] : []),
        ...(err ? [{ type: 'err', text: err }] : []),
      ].slice(-2000));
    });
    return unsub;
  }, [device.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [lines]);

  const submit = () => {
    const cmd = input.trim();
    if (!cmd) return;
    setLines(prev => [...prev, { type: 'cmd', text: `${cwd} $ ${cmd}` }]);
    setHistory(prev => [cmd, ...prev.filter(c => c !== cmd)].slice(0, 100));
    setHistIdx(-1);
    send({ type: 'SHELL', cmd });
    setInput('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { submit(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setInput(history[idx] || '');
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(histIdx - 1, -1);
      setHistIdx(idx);
      setInput(idx >= 0 ? history[idx] : '');
    }
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  };

  const QUICK = ['id', 'whoami', 'uname -a', 'getprop ro.build.version.release',
    'pm list packages -3', 'dumpsys battery', 'ifconfig', 'cat /proc/cpuinfo | head -20'];

  return (
    <div style={S.root}>
      <div style={S.quickBar}>
        {QUICK.map(q => (
          <button key={q} style={S.quickBtn}
            onClick={() => { send({ type: 'SHELL', cmd: q }); setLines(p => [...p, { type: 'cmd', text: `~ $ ${q}` }]); }}>
            {q}
          </button>
        ))}
        <button style={{ ...S.quickBtn, color: '#f44', borderColor: '#f4444444' }}
          onClick={() => setLines([])}>
          clear
        </button>
      </div>

      <div style={S.terminal} onClick={() => inputRef.current?.focus()}>
        {lines.map((l, i) => (
          <div key={i} style={{
            color: l.type === 'cmd' ? '#00d26a' : l.type === 'err' ? '#f44' : '#ccc',
            fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {l.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={S.inputRow}>
        <span style={S.prompt}>{cwd} $</span>
        <input
          ref={inputRef}
          style={S.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          placeholder="command…"
          autoFocus
        />
        <button style={S.sendBtn} onClick={submit}>EXEC</button>
      </div>
    </div>
  );
}

const S = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100%', minHeight: 0, gap: 8,
    background: '#060610',
  },
  quickBar: {
    display: 'flex', flexWrap: 'wrap', gap: 4, flexShrink: 0, padding: '4px 0',
  },
  quickBtn: {
    background: 'transparent', border: '1px solid #1a1a24',
    color: '#444', fontSize: 10, padding: '2px 8px',
    borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
  },
  terminal: {
    flex: 1, overflowY: 'auto', padding: '8px 10px',
    background: '#04040c', border: '1px solid #1a1a24',
    borderRadius: 4, cursor: 'text', minHeight: 0,
  },
  inputRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#04040c', border: '1px solid #1a1a24',
    borderRadius: 4, padding: '4px 10px', flexShrink: 0,
  },
  prompt: {
    color: '#00d26a', fontFamily: 'monospace', fontSize: 12,
    flexShrink: 0, whiteSpace: 'nowrap',
  },
  input: {
    flex: 1, background: 'transparent', border: 'none',
    color: '#ccc', fontFamily: 'monospace', fontSize: 12,
    outline: 'none', padding: 0,
  },
  sendBtn: {
    background: 'transparent', border: '1px solid #00d26a44',
    color: '#00d26a', fontSize: 10, padding: '3px 10px',
    borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
    letterSpacing: .5,
  },
};
