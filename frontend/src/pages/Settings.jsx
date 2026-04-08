import { useEffect, useRef, useState } from 'react';
import {
  Plus, Copy, Trash2, CheckCircle2, XCircle, ExternalLink,
  RefreshCw, Key, LogIn, AlertCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [keys, setKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [revealedKey, setRevealedKey] = useState(null);
  const [passwords, setPasswords] = useState({ old: '', new: '', confirm: '' });

  // Claude auth state
  const [claudeStatus, setClaudeStatus] = useState(null);
  const [authTab, setAuthTab] = useState('oauth'); // 'oauth' | 'api_key'
  const [loginUrl, setLoginUrl] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginPolling, setLoginPolling] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const pollRef = useRef(null);

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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Default tab follows what's currently active
  useEffect(() => {
    if (claudeStatus?.authMethod === 'api_key') setAuthTab('api_key');
  }, [claudeStatus?.authMethod]);

  const hasApiKeySaved =
    settings.anthropic_api_key && settings.anthropic_api_key.length > 0;

  // ─── OAuth flow ────────────────────────────────────────────────
  const startOAuth = async () => {
    setLoginLoading(true);
    setLoginUrl('');
    try {
      const d = await api.post('/api/system/claude-login/start', {});
      if (d.ok && d.url) {
        setLoginUrl(d.url);
        toast.success('Sign-in link ready — click below');
        // Start polling for auth status
        setLoginPolling(true);
        pollRef.current = setInterval(async () => {
          const s = await loadClaudeStatus();
          if (s?.authenticated) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setLoginPolling(false);
            setLoginUrl('');
            toast.success('Claude connected ✓');
          }
        }, 3000);
      } else {
        toast.error(d.error || 'Could not start sign-in');
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const openLoginUrl = () => {
    if (!loginUrl) return;
    // Explicit user click = not blocked by browser popup blocker
    window.open(loginUrl, '_blank', 'noopener,noreferrer');
  };

  const copyLoginUrl = () => {
    if (!loginUrl) return;
    navigator.clipboard.writeText(loginUrl).then(
      () => toast.success('URL copied to clipboard'),
      () => toast.error('Failed to copy — select the text manually'),
    );
  };

  const cancelOAuth = async () => {
    try { await api.post('/api/system/claude-login/cancel', {}); } catch {}
    if (pollRef.current) clearInterval(pollRef.current);
    setLoginPolling(false);
    setLoginUrl('');
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
                {!loginUrl && !loginPolling && (
                  <button
                    className="btn btn-lg"
                    onClick={startOAuth}
                    disabled={loginLoading || !claudeStatus?.installed}
                  >
                    {loginLoading ? 'Preparing sign-in…' : (
                      <>
                        <LogIn size={15} /> Sign in with Anthropic
                      </>
                    )}
                  </button>
                )}
                {(loginUrl || loginPolling) && (
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(108,99,255,.08), rgba(108,99,255,.02))',
                    border: '1px solid rgba(108,99,255,.25)',
                    borderRadius: 12,
                    padding: 20,
                  }}>
                    <div style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: 'var(--accent)',
                      textTransform: 'uppercase',
                      letterSpacing: 1.5,
                      marginBottom: 14,
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
                      Step 1: Open the Anthropic login page
                    </div>

                    {loginUrl && (
                      <>
                        {/* Big prominent button */}
                        <button
                          className="btn btn-lg"
                          onClick={openLoginUrl}
                          style={{
                            width: '100%',
                            justifyContent: 'center',
                            padding: '14px 20px',
                            fontSize: 14,
                            marginBottom: 14,
                          }}
                        >
                          <ExternalLink size={16} /> Open Anthropic Login →
                        </button>

                        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
                          Or copy the URL and open it in any browser:
                        </div>

                        {/* Copyable URL box */}
                        <div style={{
                          background: 'var(--bg)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '10px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 12,
                        }}>
                          <input
                            type="text"
                            value={loginUrl}
                            readOnly
                            onFocus={(e) => e.target.select()}
                            onClick={(e) => e.target.select()}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text)',
                              fontSize: 11,
                              fontFamily: 'Menlo, Monaco, monospace',
                              outline: 'none',
                            }}
                          />
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={copyLoginUrl}
                            style={{ flexShrink: 0 }}
                          >
                            <Copy size={12} /> Copy
                          </button>
                        </div>

                        <div style={{
                          fontSize: 11,
                          color: 'var(--text-muted)',
                          padding: '8px 10px',
                          background: 'var(--bg2)',
                          borderRadius: 6,
                          borderLeft: '2px solid var(--accent)',
                          marginBottom: 14,
                        }}>
                          💡 <strong style={{ color: 'var(--text-dim)' }}>Step 2:</strong> Sign in to Anthropic in the new tab. When done, come back here — this page will auto-detect it.
                        </div>
                      </>
                    )}

                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 0',
                      borderTop: '1px solid var(--border)',
                    }}>
                      <div className="spinner" />
                      <span style={{ fontSize: 12, color: 'var(--text-dim)', flex: 1 }}>
                        Waiting for sign-in… checking every 3 seconds
                      </span>
                      <button className="btn btn-sm btn-ghost" onClick={cancelOAuth}>
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
