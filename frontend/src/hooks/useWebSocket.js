import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Persistent authenticated WebSocket connection.
 * Auto-reconnects with exponential backoff.
 */
export function useWebSocket(onMessage) {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  const reconnectTimer = useRef(null);
  const attemptsRef = useRef(0);

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);

  useEffect(() => {
    function connect() {
      const token = localStorage.getItem('clawpanel_token') || '';
      if (!token) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      const ws = new WebSocket(`${proto}://${host}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        attemptsRef.current = 0;
      };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        // backoff reconnect
        attemptsRef.current += 1;
        const delay = Math.min(1000 * Math.pow(2, attemptsRef.current), 15000);
        reconnectTimer.current = setTimeout(connect, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          onMessageRef.current?.(msg);
        } catch {}
      };
    }
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
      }
    };
  }, []);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  return { send, connected };
}
