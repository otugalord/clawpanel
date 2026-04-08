import { useEffect, useState } from 'react';
import { Plus, Copy, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [keys, setKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [revealedKey, setRevealedKey] = useState(null);
  const [passwords, setPasswords] = useState({ old: '', new: '', confirm: '' });

  const load = async () => {
    try {
      const [s, k] = await Promise.all([api.get('/api/system/settings'), api.get('/api/auth/api-keys')]);
      setSettings(s.settings || {});
      setKeys(k.keys || []);
    } catch (e) { toast.error(e.message); }
  };

  useEffect(() => { load(); }, []);

  const saveSettings = async () => {
    try {
      await api.put('/api/system/settings', settings);
      toast.success('Guardado');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const changePassword = async () => {
    if (passwords.new !== passwords.confirm) return toast.error('Passwords não coincidem');
    if (passwords.new.length < 6) return toast.error('Mínimo 6 caracteres');
    try {
      await api.post('/api/auth/change-password', { oldPassword: passwords.old, newPassword: passwords.new });
      toast.success('Password alterada');
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
    if (!window.confirm('Apagar esta chave?')) return;
    try {
      await api.del(`/api/auth/api-keys/${id}`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const copy = (txt) => {
    navigator.clipboard.writeText(txt).then(() => toast.success('Copiado'));
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Definições</h1>
          <p>Configurações gerais do ClawPanel</p>
        </div>
      </div>

      <div className="grid" style={{ gap: 18 }}>
        {/* Integrations */}
        <div className="card">
          <div className="card-title">Integrações</div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div>
              <label className="label">Anthropic API Key</label>
              <input
                className="input"
                type="password"
                placeholder={settings.anthropic_api_key || 'sk-ant-...'}
                onChange={(e) => setSettings({ ...settings, anthropic_api_key: e.target.value })}
              />
              <div className="text-xs text-dim" style={{ marginTop: 4 }}>Usado ao lançar sessões Claude Code</div>
            </div>
            <div>
              <label className="label">Namecheap API User</label>
              <input
                className="input"
                placeholder={settings.namecheap_user || 'username'}
                onChange={(e) => setSettings({ ...settings, namecheap_user: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Namecheap API Key</label>
              <input
                className="input"
                type="password"
                placeholder={settings.namecheap_api_key || ''}
                onChange={(e) => setSettings({ ...settings, namecheap_api_key: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Apps Directory</label>
              <input
                className="input"
                value={settings.apps_dir || ''}
                onChange={(e) => setSettings({ ...settings, apps_dir: e.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn" onClick={saveSettings}>Guardar</button>
          </div>
        </div>

        {/* Password */}
        <div className="card">
          <div className="card-title">Alterar Password</div>
          <div className="grid" style={{ gap: 12, maxWidth: 420 }}>
            <div>
              <label className="label">Password actual</label>
              <input className="input" type="password" value={passwords.old} onChange={(e) => setPasswords({ ...passwords, old: e.target.value })} />
            </div>
            <div>
              <label className="label">Nova password</label>
              <input className="input" type="password" value={passwords.new} onChange={(e) => setPasswords({ ...passwords, new: e.target.value })} />
            </div>
            <div>
              <label className="label">Confirmar</label>
              <input className="input" type="password" value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
            </div>
            <div><button className="btn" onClick={changePassword}>Alterar</button></div>
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
                ⚠ Copia esta chave agora — não será mostrada outra vez
              </div>
              {revealedKey}
              <button className="btn btn-sm btn-ghost" style={{ marginLeft: 10 }} onClick={() => copy(revealedKey)}><Copy size={12} /></button>
              <button className="btn btn-sm btn-ghost" onClick={() => setRevealedKey(null)}>fechar</button>
            </div>
          )}
          <div className="flex gap-8" style={{ marginBottom: 14 }}>
            <input
              className="input"
              placeholder="Nome da chave (ex: deploy-ci)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
            />
            <button className="btn" onClick={createKey}><Plus size={14} /> Criar</button>
          </div>
          {keys.length === 0 ? (
            <div className="empty">Sem chaves criadas</div>
          ) : (
            <table className="table">
              <thead><tr><th>Nome</th><th>Criada</th><th>Último uso</th><th></th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td><strong>{k.name}</strong></td>
                    <td className="text-xs text-dim">{new Date(k.created_at).toLocaleString('pt-PT')}</td>
                    <td className="text-xs text-dim">{k.last_used ? new Date(k.last_used).toLocaleString('pt-PT') : '—'}</td>
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
          <div className="card-title">Sobre</div>
          <div className="text-sm text-dim">
            ClawPanel v{settings.version || '0.1.0'} · self-hosted VPS management<br />
            Stack: Node.js + Express + SQLite + React + node-pty
          </div>
        </div>
      </div>
    </div>
  );
}
