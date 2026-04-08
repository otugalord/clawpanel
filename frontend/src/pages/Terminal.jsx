import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Plus, X } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';

export default function TerminalPage() {
  const [tabs, setTabs] = useState([]); // { id, cwd }
  const [activeId, setActiveId] = useState(null);
  const containerRef = useRef(null);
  const termsRef = useRef(new Map()); // id -> { xterm, fit }

  const onWs = useCallback((msg) => {
    if (msg.type === 'terminal_ready') {
      setTabs((t) => {
        const exists = t.find((x) => x.id === msg.sessionId);
        if (exists) return t;
        return [...t, { id: msg.sessionId, cwd: msg.cwd }];
      });
      setActiveId(msg.sessionId);
    } else if (msg.type === 'terminal_output') {
      const entry = termsRef.current.get(msg.sessionId);
      if (entry) entry.xterm.write(msg.data);
    } else if (msg.type === 'terminal_exit') {
      setTabs((t) => t.filter((x) => x.id !== msg.sessionId));
      const entry = termsRef.current.get(msg.sessionId);
      if (entry) { try { entry.xterm.dispose(); } catch {} }
      termsRef.current.delete(msg.sessionId);
    }
  }, []);

  const { send } = useWebSocket(onWs);

  // Create first tab
  useEffect(() => {
    if (tabs.length === 0) {
      send({ type: 'terminal_create' });
    }
    // eslint-disable-next-line
  }, []);

  // Mount xterm for active tab
  useEffect(() => {
    if (!activeId || !containerRef.current) return;
    let entry = termsRef.current.get(activeId);
    if (!entry) {
      const xterm = new Xterm({
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        cursorBlink: true,
        theme: {
          background: '#000000',
          foreground: '#e5e5e5',
          cursor: '#6c63ff',
          selectionBackground: '#6c63ff33',
        },
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.loadAddon(new WebLinksAddon());
      entry = { xterm, fit };
      termsRef.current.set(activeId, entry);

      xterm.onData((data) => {
        send({ type: 'terminal_input', sessionId: activeId, data });
      });
      xterm.onResize(({ cols, rows }) => {
        send({ type: 'terminal_resize', sessionId: activeId, cols, rows });
      });
    }
    // Clear container and attach
    containerRef.current.innerHTML = '';
    entry.xterm.open(containerRef.current);
    setTimeout(() => {
      try { entry.fit.fit(); } catch {}
    }, 50);
    const onResize = () => {
      try { entry.fit.fit(); } catch {}
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeId, send]);

  const newTab = () => send({ type: 'terminal_create' });
  const closeTab = (id) => {
    send({ type: 'terminal_kill', sessionId: id });
    setTabs((t) => t.filter((x) => x.id !== id));
    if (activeId === id) {
      const others = tabs.filter((x) => x.id !== id);
      setActiveId(others[0]?.id || null);
    }
  };

  return (
    <div className="term-wrap">
      <div className="term-tabs">
        {tabs.map((t, idx) => (
          <div
            key={t.id}
            className={'term-tab' + (t.id === activeId ? ' active' : '')}
            onClick={() => setActiveId(t.id)}
          >
            shell {idx + 1}
            <button className="close-x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={newTab}><Plus size={13} /> New</button>
      </div>
      <div className="term-body" ref={containerRef} />
    </div>
  );
}
