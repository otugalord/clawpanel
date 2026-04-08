import { useEffect, useState } from 'react';
import { Plus, Copy, Trash2, RefreshCw, CheckCircle2, XCircle, TerminalSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../lib/api';

export default function Settings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState({});
  const [keys, setKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [revealedKey, setRevealedKey] = useState(null);
  const [passwords, setPasswords] = useState({ old: '', new: '', confirm: '' });
  const [claudeStatus, setClaudeStatus] = useState(null);
  const [claudeLoading, setClaudeLoading] = useState(false);

  const load = async () => {
    try {
      const [s, k] = await Promise.all([api.get('/api/system/settings'), api.get('/api/auth/api-keys')]);
      setSettings(s.settings || {});
      setKeys(k.keys || []);
    } catch (e) { toast.error(e.message); }
    loadClaudeStatus();
  };

  const loadClaudeStatus = async () => {
    setClaudeLoading(true);
    try {
      const d = await api.get('/api/system/claude-status');
      setClaudeStatus(d);
    } catch (e) {
      setClaudeStatus({ installed: false, authenticated: false, error: e.message });
    } finally {
      setClaudeLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const saveSettings = async () => {
    try {
      await api.put('/api/system/settings', { apps_dir: settings.apps_dir });
      toast.success('Saved');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const changePassword = async () => {
    if (passwords.new !== passwords.confirm) return toast.error('Passwords do not match');
    if (passwords.new.length < 6) return toast.error('Minimum 6 characters');
    try {
      await api.post('/api/auth/change-password', { oldPassword: passwords.old, newPassword: passwords.new });
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
      load();
    } catch (e) { toast.error(e.message); }
  };

  const deleteKey = async (id) => {
    if (!window.confirm('Delete this key?')) return;
    try {
      await api.del(`/api/auth/api-keys/${id}`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const copy = (txt) => {
    navigator.clipboard.writeText(txt).then(() => toast.success('Copied'));
  };

  const claudeBadge = () => {
    if (claudeLoading) return <span className="badge badge-gray">checking…</span>;
    if (!claudeStatus) return null;
    if (claudeStatus.installed && claudeStatus.authenticated) {
      return <span className="badge badge-green"><CheckCircle2 size={11} /> Authenticated</span>;
    }
    if (claudeStatus.installed && !claudeStatus.authenticated) {
      return <span className="badge badge-yellow"><XCircle size={11} /> Not authenticated</span>;
    }
    return <span className="badge badge-red"><XCircle size={11} /> Not installed</span>;
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>General ClawPanel configuration</p>
        </div>
      </div>

      <div className="grid" style={{ gap: 18 }}>
        {/* Claude Code Status */}
        <div className="card">
          <div className="card-title">
            <span>Claude Code CLI</span>
            {claudeBadge()}
          </div>
          {claudeStatus && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', display: 'grid', gap: 4, marginBottom: 14 }}>
              <div>binary: <code>{claudeStatus.binary || '—'}</code></div>
              <div>version: <code>{claudeStatus.version || '—'}</code></div>
              <div>config: <code>{claudeStatus.configDir || '—'}</code></div>
              {claudeStatus.error && <div style={{ color: 'var(--red)' }}>error: {claudeStatus.error}</div>}
            </div>
          )}
          {claudeStatus && !claudeStatus.installed && (
            <div style={{
              padding: 12, marginBottom: 12,
              background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.22)',
              borderRadius: 8, fontSize: 12,
            }}>
              The <strong>Claude Code CLI</strong> is not installed. On the server terminal, run:
              <code style={{ display: 'block', marginTop: 6, padding: 8, background: 'var(--bg2)', borderRadius: 6 }}>
                npm install -g @anthropic-ai/claude-code
              </code>
            </div>
          )}
          {claudeStatus && claudeStatus.installed && !claudeStatus.authenticated && (
            <div style={{
              padding: 12, marginBottom: 12,
              background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.22)',
              borderRadius: 8, fontSize: 12,
            }}>
              Claude is installed but <strong>not yet authenticated</strong>. Open the ClawPanel
              Terminal and run <code>claude</code> — it will start the OAuth flow in your browser.
            </div>
          )}
          <div className="flex gap-8">
            <button className="btn btn-secondary" onClick={loadClaudeStatus}>
              <RefreshCw size={13} /> Re-check
            </button>
            {claudeStatus && !claudeStatus.authenticated && (
              <button className="btn" onClick={() => navigate('/terminal')}>
                <TerminalSquare size={13} /> Authenticate Claude (Terminal)
              </button>
            )}
          </div>
        </div>

        {/* Apps Directory */}
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
            <div><button className="btn" onClick={saveSettings}>Save</button></div>
          </div>
        </div>

        {/* Password */}
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

        {/* API Keys */}
        <div className="card">
          <div className="card-title">API Keys</div>
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
