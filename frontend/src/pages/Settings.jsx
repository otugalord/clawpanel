import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Plus, Copy, Trash2, CheckCircle2, XCircle,
  RefreshCw, Key, LogIn,
} from 'lucide-react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

const kbdStyle = {
  display: 'inline-block',
  padding: '1px 6px',
  background: 'var(--card2, #171831)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontFamily: 'Menlo, monospace',
  fontSize: 10,
  color: 'var(--text)',
  margin: '0 1px',
};

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [keys, setKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [revealedKey, setRevealedKey] = useState(null);
  const [passwords, setPasswords] = useState({ old: '', new: '', confirm: '' });

  // Claude auth state
  const [claudeStatus, setClaudeStatus] = useState(null);
  const [authTab, setAuthTab] = useState('oauth'); // 'oauth' | 'api_key'
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);

  // Embedded auth-terminal state
  const [authTermActive, setAuthTermActive] = useState(false);
  const [authTermSessionId, setAuthTermSessionId] = useState(null);
  const [authTermLoading, setAuthTermLoading] = useState(false);
  const [loginPolling, setLoginPolling] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const pollRef = useRef(null);
  const authTermContainerRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);

  const loadSettings = async () => {
    try {
      const [s, k] = await Promise.all([
        api.get('/api/system/settings'),
        api.get('/api/auth/api-keys'),
      ]);
      setSettings(s.settings || {});
      setKeys(k.keys || []);
    } catch (e) { toast.error(e.message); }
  };

  const loadClaudeStatus = async () => {
    try {
      const d = await api.get('/api/system/claude-status');
      setClaudeStatus(d);
      return d;
    } catch (e) {
      setClaudeStatus({ installed: false, authenticated: false, error: e.message });
      return null;
    }
  };

  useEffect(() => {
    loadSettings();
    loadClaudeStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      // Kill any lingering auth terminal session when leaving the page
      if (authTermSessionId) {
        try { wsSendRef.current?.({ type: 'auth_terminal_kill', sessionId: authTermSessionId }); } catch {}
      }
      if (xtermRef.current) {
        try { xtermRef.current.dispose(); } catch {}
        xtermRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default tab follows what's currently active
  useEffect(() => {
    if (claudeStatus?.authMethod === 'api_key') setAuthTab('api_key');
  }, [claudeStatus?.authMethod]);

  // ─── WebSocket bridge for auth terminal ────────────────────────
  const wsSendRef = useRef(null);
  const onWsMessage = useCallback((msg) => {
    if (msg.type === 'auth_terminal_ready') {
      setAuthTermSessionId(msg.sessionId);
      setAuthTermLoading(false);
      // Start polling for auth status
      if (!pollRef.current) {
        setLoginPolling(true);
        pollRef.current = setInterval(async () => {
          const s = await loadClaudeStatus();
          if (s?.authenticated) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setLoginPolling(false);
            toast.success('Claude connected ✓');
            // Kill the auth terminal gracefully
            closeAuthTerminal();
          }
        }, 3000);
      }
    } else if (msg.type === 'auth_terminal_output' && msg.sessionId === authTermSessionId) {
      if (xtermRef.current) {
        xtermRef.current.write(msg.data);
      }
    } else if (msg.type === 'auth_terminal_exit' && msg.sessionId === authTermSessionId) {
      if (xtermRef.current) {
        xtermRef.current.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n');
      }
    } else if (msg.type === 'auth_terminal_error') {
      toast.error(msg.error || 'Failed to start auth terminal');
      setAuthTermLoading(false);
      setAuthTermActive(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authTermSessionId]);

  const { send: wsSend, connected: wsConnected } = useWebSocket(onWsMessage);
  useEffect(() => { wsSendRef.current = wsSend; }, [wsSend]);

  // Initialize xterm when the auth terminal becomes active
  useEffect(() => {
    if (!authTermActive || !authTermContainerRef.current) return;
    // Create xterm once
    if (!xtermRef.current) {
      const term = new Xterm({
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 12,
        cursorBlink: true,
        theme: {
          background: '#0a0b14',
          foreground: '#e5e5e5',
          cursor: '#6c63ff',
          selectionBackground: '#6c63ff44',
        },
        allowProposedApi: true,
        convertEol: true,
        scrollback: 2000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon((event, uri) => {
        // Open URL in a new tab on click
        window.open(uri, '_blank', 'noopener,noreferrer');
      }));
      term.open(authTermContainerRef.current);
      try { fit.fit(); } catch {}
      // Auto-focus on mount so keystrokes / paste work immediately
      setTimeout(() => { try { term.focus(); } catch {} }, 50);
      term.onData((data) => {
        if (authTermSessionId && wsSendRef.current) {
          wsSendRef.current({ type: 'auth_terminal_input', sessionId: authTermSessionId, data });
        }
      });
      term.onResize(({ cols, rows }) => {
        if (authTermSessionId && wsSendRef.current) {
          wsSendRef.current({ type: 'auth_terminal_resize', sessionId: authTermSessionId, cols, rows });
        }
      });
      xtermRef.current = term;
      fitRef.current = fit;
    }
    // Request a new session if we don't have one yet
    if (!authTermSessionId && wsSendRef.current) {
      setAuthTermLoading(true);
      wsSendRef.current({ type: 'auth_terminal_create' });
    }
    const onResize = () => { try { fitRef.current?.fit(); } catch {} };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [authTermActive, authTermSessionId]);

  // Click anywhere on the terminal container → focus the xterm
  const focusTerminal = () => {
    if (xtermRef.current) {
      try { xtermRef.current.focus(); } catch {}
    }
  };

  // Manual code submit — sends the code + Enter to the PTY
  const submitManualCode = () => {
    const code = manualCode.trim();
    if (!code) return;
    if (!authTermSessionId || !wsSendRef.current) {
      toast.error('Terminal session not ready');
      return;
    }
    wsSendRef.current({
      type: 'auth_terminal_input',
      sessionId: authTermSessionId,
      data: code + '\r',
    });
    setManualCode('');
    toast.success('Code sent to terminal');
    // Re-focus xterm so any follow-up prompts go there
    setTimeout(focusTerminal, 100);
  };

  const hasApiKeySaved =
    settings.anthropic_api_key && settings.anthropic_api_key.length > 0;

  // ─── OAuth flow — embedded terminal ────────────────────────────
  const startOAuth = () => {
    if (!wsConnected) {
      toast.error('WebSocket not connected yet — try again in a second');
      return;
    }
    setAuthTermActive(true);
    setAuthTermSessionId(null);
    // The effect above will create the session once the container mounts
  };

  const closeAuthTerminal = () => {
    if (authTermSessionId && wsSendRef.current) {
      try { wsSendRef.current({ type: 'auth_terminal_kill', sessionId: authTermSessionId }); } catch {}
    }
    if (xtermRef.current) {
      try { xtermRef.current.dispose(); } catch {}
      xtermRef.current = null;
      fitRef.current = null;
    }
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setAuthTermActive(false);
    setAuthTermSessionId(null);
    setAuthTermLoading(false);
    setLoginPolling(false);
  };

  // ─── API Key ───────────────────────────────────────────────────
  const saveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    if (!apiKeyInput.startsWith('sk-ant-')) {
      toast.error('API key must start with sk-ant-');
      return;
    }
    setApiKeySaving(true);
    try {
      await api.post('/api/system/claude-api-key', { api_key: apiKeyInput.trim() });
      toast.success('API key saved');
      setApiKeyInput('');
      await loadSettings();
      await loadClaudeStatus();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setApiKeySaving(false);
    }
  };

  const clearApiKey = async () => {
    if (!window.confirm('Remove saved API key?')) return;
    try {
      await api.post('/api/system/claude-api-key', { api_key: '' });
      toast.success('API key removed');
      await loadSettings();
      await loadClaudeStatus();
    } catch (e) { toast.error(e.message); }
  };

  // ─── Password / API keys / etc ─────────────────────────────────
  const changePassword = async () => {
    if (passwords.new !== passwords.confirm) return toast.error('Passwords do not match');
    if (passwords.new.length < 6) return toast.error('Minimum 6 characters');
    try {
      await api.post('/api/auth/change-password', {
        oldPassword: passwords.old, newPassword: passwords.new,
      });
      toast.success('Password changed');
      setPasswords({ old: '', new: '', confirm: '' });
    } catch (e) { toast.error(e.message); }
  };

  const createKey = async () => {
    if (!newKeyName.trim()) return;
    try {
      const d = await api.post('/api/auth/api-keys', { name: newKeyName.trim() });
      setRevealedKey(d.key);
      setNewKeyName('');
      loadSettings();
    } catch (e) { toast.error(e.message); }
  };

  const deleteKey = async (id) => {
    if (!window.confirm('Delete this key?')) return;
    try {
      await api.del(`/api/auth/api-keys/${id}`);
      loadSettings();
    } catch (e) { toast.error(e.message); }
  };

  const copy = (txt) => {
    navigator.clipboard.writeText(txt).then(() => toast.success('Copied'));
  };

  const saveAppsDir = async () => {
    try {
      await api.put('/api/system/settings', { apps_dir: settings.apps_dir });
      toast.success('Saved');
      loadSettings();
    } catch (e) { toast.error(e.message); }
  };

  // ─── Status headline ────────────────────────────────────────────
  const isConnected = claudeStatus?.installed && claudeStatus?.authenticated;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>General ClawPanel configuration</p>
        </div>
      </div>

      <div className="grid" style={{ gap: 18 }}>
        {/* ═══ CONNECT CLAUDE CARD ═══ */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header with big status */}
          <div style={{
            padding: '22px 24px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            background: isConnected
              ? 'linear-gradient(135deg,rgba(74,222,128,.06),transparent)'
              : 'linear-gradient(135deg,rgba(248,113,113,.06),transparent)',
          }}>
            <div style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: isConnected ? 'rgba(74,222,128,.15)' : 'rgba(248,113,113,.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              {isConnected ? (
                <CheckCircle2 size={28} color="var(--green)" />
              ) : (
                <XCircle size={28} color="var(--red)" />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 3 }}>
                {isConnected ? 'Claude is connected' : 'Claude is not connected'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {isConnected ? (
                  <>
                    Using {claudeStatus?.authMethod === 'api_key' ? 'API key' : 'Anthropic OAuth'}
                    {claudeStatus?.version ? ` · ${claudeStatus.version}` : ''}
                  </>
                ) : !claudeStatus?.installed ? (
                  <>Claude Code CLI is not installed on this server. Run <code>npm install -g @anthropic-ai/claude-code</code>.</>
                ) : (
                  <>Choose how you want to connect below.</>
                )}
              </div>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={loadClaudeStatus} title="Re-check">
              <RefreshCw size={14} />
            </button>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
            <button
              onClick={() => setAuthTab('oauth')}
              style={{
                flex: 1,
                padding: '14px 18px',
                background: authTab === 'oauth' ? 'var(--bg2)' : 'transparent',
                border: 'none',
                borderBottom: authTab === 'oauth' ? '2px solid var(--accent)' : '2px solid transparent',
                color: authTab === 'oauth' ? 'var(--text)' : 'var(--text-dim)',
                fontWeight: authTab === 'oauth' ? 700 : 500,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <LogIn size={14} /> Sign in with Anthropic
            </button>
            <button
              onClick={() => setAuthTab('api_key')}
              style={{
                flex: 1,
                padding: '14px 18px',
                background: authTab === 'api_key' ? 'var(--bg2)' : 'transparent',
                border: 'none',
                borderBottom: authTab === 'api_key' ? '2px solid var(--accent)' : '2px solid transparent',
                color: authTab === 'api_key' ? 'var(--text)' : 'var(--text-dim)',
                fontWeight: authTab === 'api_key' ? 700 : 500,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <Key size={14} /> Use API Key
            </button>
          </div>

          {/* Tab content */}
          <div style={{ padding: 24 }}>
            {authTab === 'oauth' && (
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.6 }}>
                  Sign in with your Anthropic account. No credit card required if you already have a Claude Pro/Team subscription — your Claude Code usage is included.
                  <br /><strong style={{ color: 'var(--text)' }}>Sign in once and Claude works forever.</strong>
                </div>
                {!authTermActive && (
                  <button
                    className="btn btn-lg"
                    onClick={startOAuth}
                    disabled={authTermLoading || !claudeStatus?.installed || !wsConnected}
                  >
                    {authTermLoading ? 'Preparing sign-in…' : (
                      <>
                        <LogIn size={15} /> Sign in with Anthropic
                      </>
                    )}
                  </button>
                )}
                {authTermActive && (
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(108,99,255,.08), rgba(108,99,255,.02))',
                    border: '1px solid rgba(108,99,255,.25)',
                    borderRadius: 12,
                    padding: 18,
                  }}>
                    <div style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: 'var(--accent)',
                      textTransform: 'uppercase',
                      letterSpacing: 1.5,
                      marginBottom: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}>
                      <span style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--accent)',
                        boxShadow: '0 0 0 4px rgba(108,99,255,.2)',
                        animation: 'ts-blink 1.6s infinite',
                      }} />
                      Claude is starting the sign-in flow
                    </div>

                    {/* Embedded xterm.js — click to focus, paste with Ctrl/Cmd+V */}
                    <div
                      ref={authTermContainerRef}
                      onClick={focusTerminal}
                      tabIndex={0}
                      style={{
                        background: '#0a0b14',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: 8,
                        height: 300,
                        marginBottom: 12,
                        overflow: 'hidden',
                        cursor: 'text',
                      }}
                    />

                    {/* Primary instruction */}
                    <div style={{
                      fontSize: 12,
                      color: 'var(--text-dim)',
                      padding: '10px 12px',
                      background: 'var(--bg2)',
                      borderRadius: 6,
                      borderLeft: '2px solid var(--accent)',
                      marginBottom: 12,
                      lineHeight: 1.7,
                    }}>
                      👉 <strong style={{ color: 'var(--text)' }}>After clicking Authorize on Anthropic's page</strong>, copy the code and paste it into the terminal above.
                      Click the terminal first to focus it, then use <kbd style={kbdStyle}>Ctrl</kbd>+<kbd style={kbdStyle}>V</kbd> (or <kbd style={kbdStyle}>⌘</kbd>+<kbd style={kbdStyle}>V</kbd>) to paste and press <kbd style={kbdStyle}>Enter</kbd>.
                    </div>

                    {/* Fallback: manual code input */}
                    <div style={{
                      padding: '12px 14px',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      marginBottom: 12,
                    }}>
                      <label className="label" style={{ marginBottom: 6 }}>
                        Or paste the code here
                      </label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          className="input"
                          type="text"
                          placeholder="Paste authentication code"
                          value={manualCode}
                          onChange={(e) => setManualCode(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              submitManualCode();
                            }
                          }}
                          style={{ flex: 1, fontFamily: 'Menlo, monospace', fontSize: 12 }}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          className="btn"
                          onClick={submitManualCode}
                          disabled={!manualCode.trim() || !authTermSessionId}
                        >
                          Submit
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                        Use this if pasting directly into the terminal doesn't work.
                      </div>
                    </div>

                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 0 0',
                      borderTop: '1px solid var(--border)',
                    }}>
                      <div className="spinner" />
                      <span style={{ fontSize: 12, color: 'var(--text-dim)', flex: 1 }}>
                        {loginPolling
                          ? 'Waiting for sign-in… checking every 3 seconds'
                          : authTermLoading
                          ? 'Starting claude auth login…'
                          : 'Follow the instructions in the terminal above'}
                      </span>
                      <button className="btn btn-sm btn-ghost" onClick={closeAuthTerminal}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {authTab === 'api_key' && (
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.6 }}>
                  Paste your Anthropic API key to use Claude with pay-per-use credits.
                  <br /><strong style={{ color: 'var(--text)' }}>Pay per use with your Anthropic API credits.</strong>
                  <br />Get a key at{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    console.anthropic.com
                  </a>.
                </div>
                {hasApiKeySaved && (
                  <div style={{
                    padding: '10px 14px',
                    background: 'rgba(74,222,128,.08)',
                    border: '1px solid rgba(74,222,128,.22)',
                    borderRadius: 8,
                    marginBottom: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 12,
                  }}>
                    <CheckCircle2 size={14} color="var(--green)" />
                    <span style={{ flex: 1 }}>
                      API key saved: <code>{settings.anthropic_api_key}</code>
                    </span>
                    <button className="btn btn-sm btn-danger" onClick={clearApiKey}>
                      <Trash2 size={12} /> Remove
                    </button>
                  </div>
                )}
                <label className="label">Anthropic API Key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-ant-api03-..."
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
                <div style={{ marginTop: 12 }}>
                  <button className="btn" onClick={saveApiKey} disabled={!apiKeyInput.trim() || apiKeySaving}>
                    {apiKeySaving ? 'Saving…' : 'Save API Key'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ═══ Apps Directory ═══ */}
        <div className="card">
          <div className="card-title">Apps Directory</div>
          <div className="grid" style={{ gap: 12, maxWidth: 480 }}>
            <div>
              <label className="label">Apps Directory</label>
              <input
                className="input"
                value={settings.apps_dir || ''}
                onChange={(e) => setSettings({ ...settings, apps_dir: e.target.value })}
                placeholder="/root/apps"
              />
              <div className="text-xs text-dim" style={{ marginTop: 4 }}>Where new apps are created by default</div>
            </div>
            <div><button className="btn" onClick={saveAppsDir}>Save</button></div>
          </div>
        </div>

        {/* ═══ Password ═══ */}
        <div className="card">
          <div className="card-title">Change Password</div>
          <div className="grid" style={{ gap: 12, maxWidth: 420 }}>
            <div>
              <label className="label">Current Password</label>
              <input className="input" type="password" value={passwords.old} onChange={(e) => setPasswords({ ...passwords, old: e.target.value })} />
            </div>
            <div>
              <label className="label">New Password</label>
              <input className="input" type="password" value={passwords.new} onChange={(e) => setPasswords({ ...passwords, new: e.target.value })} />
            </div>
            <div>
              <label className="label">Confirm</label>
              <input className="input" type="password" value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
            </div>
            <div><button className="btn" onClick={changePassword}>Change</button></div>
          </div>
        </div>

        {/* ═══ ClawPanel API Keys ═══ */}
        <div className="card">
          <div className="card-title">ClawPanel API Keys</div>
          <div className="text-xs text-dim" style={{ marginBottom: 14 }}>
            For headless / CI access to the ClawPanel API. Not related to Claude.
          </div>
          {revealedKey && (
            <div style={{
              padding: 12,
              background: 'rgba(74,222,128,.08)',
              border: '1px solid rgba(74,222,128,.25)',
              borderRadius: 8,
              marginBottom: 14,
              fontFamily: 'monospace',
              fontSize: 12,
              wordBreak: 'break-all',
            }}>
              <div className="text-xs" style={{ color: 'var(--green)', marginBottom: 6, fontWeight: 700 }}>
                ⚠ Copy this key now — it will not be shown again
              </div>
              {revealedKey}
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-sm btn-ghost" onClick={() => copy(revealedKey)}><Copy size={12} /> Copy</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setRevealedKey(null)}>close</button>
              </div>
            </div>
          )}
          <div className="flex gap-8" style={{ marginBottom: 14 }}>
            <input
              className="input"
              placeholder="Key name (e.g. deploy-ci)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
            />
            <button className="btn" onClick={createKey}><Plus size={14} /> Create</button>
          </div>
          {keys.length === 0 ? (
            <div className="empty">No keys created</div>
          ) : (
            <table className="table">
              <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td><strong>{k.name}</strong></td>
                    <td className="text-xs text-dim">{new Date(k.created_at).toLocaleString('en-GB')}</td>
                    <td className="text-xs text-dim">{k.last_used ? new Date(k.last_used).toLocaleString('en-GB') : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteKey(k.id)}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ═══ About ═══ */}
        <div className="card">
          <div className="card-title">About</div>
          <div className="text-sm text-dim">
            ClawPanel v{settings.version || '0.1.0'} · self-hosted VPS management<br />
            Stack: Node.js + Express + SQLite + React + node-pty<br />
            <a href="https://github.com/otugalord/clawpanel" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>
              github.com/otugalord/clawpanel
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
