import { useEffect, useState } from 'react';
import { Plus, Link2, Link2Off, Shield, ShieldOff, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';

export default function DomainManager() {
  const [domains, setDomains] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [linkModal, setLinkModal] = useState(null);

  const load = async () => {
    try {
      const [d, a] = await Promise.all([api.get('/api/domains'), api.get('/api/apps')]);
      setDomains(d.domains || []);
      setApps(a.apps || []);
    } catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const add = async () => {
    try {
      await api.post('/api/domains', { domain: newDomain.trim() });
      toast.success('Domínio adicionado');
      setNewDomain('');
      setShowAdd(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const link = async (appId) => {
    if (!linkModal) return;
    try {
      await api.post(`/api/domains/${linkModal.id}/link`, { app_id: appId });
      toast.success('Linked + nginx reload');
      setLinkModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const unlink = async (d) => {
    if (!window.confirm(`Desligar ${d.domain}?`)) return;
    try {
      await api.post(`/api/domains/${d.id}/unlink`);
      toast.success('Unlinked');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const installSSL = async (d) => {
    const email = window.prompt(`Email para Let's Encrypt (para ${d.domain}):`, `admin@${d.domain}`);
    if (!email) return;
    toast.loading('A instalar SSL...', { id: 'ssl' });
    try {
      const res = await api.post(`/api/domains/${d.id}/ssl`, { email });
      toast.dismiss('ssl');
      if (res.ok) toast.success('SSL instalado'); else toast.error('SSL falhou — ver logs');
      load();
    } catch (e) {
      toast.dismiss('ssl');
      toast.error(e.message);
    }
  };

  const removeSSL = async (d) => {
    if (!window.confirm(`Remover SSL de ${d.domain}?`)) return;
    try {
      await api.post(`/api/domains/${d.id}/ssl/remove`);
      toast.success('SSL removido');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const del = async (d) => {
    if (!window.confirm(`Apagar ${d.domain} da base de dados?`)) return;
    try {
      await api.del(`/api/domains/${d.id}`);
      toast.success('Apagado');
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Domínios</h1>
          <p>{domains.length} domínios · nginx + certbot</p>
        </div>
        <div className="page-header-actions">
          <button className="btn" onClick={() => setShowAdd(true)}><Plus size={14} /> Adicionar</button>
        </div>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /></div>
      ) : domains.length === 0 ? (
        <div className="card empty">
          <div className="emoji">🌐</div>
          <div>Sem domínios. Adiciona um para começar.</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Domínio</th>
                <th>App</th>
                <th>SSL</th>
                <th>Adicionado</th>
                <th style={{ textAlign: 'right' }}>Acções</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.domain}</strong></td>
                  <td>
                    {d.app_name ? (
                      <span className="badge badge-blue">{d.app_name} :{d.app_port}</span>
                    ) : (
                      <span className="text-dim text-xs">não ligado</span>
                    )}
                  </td>
                  <td>
                    {d.ssl_enabled ? (
                      <span className="badge badge-green">● HTTPS</span>
                    ) : (
                      <span className="badge badge-gray">HTTP</span>
                    )}
                  </td>
                  <td className="text-xs text-dim">{new Date(d.added_at).toLocaleDateString('pt-PT')}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="flex gap-8" style={{ justifyContent: 'flex-end' }}>
                      {d.linked_app_id ? (
                        <button className="btn btn-sm btn-secondary" title="Desligar" onClick={() => unlink(d)}>
                          <Link2Off size={13} />
                        </button>
                      ) : (
                        <button className="btn btn-sm" title="Ligar a app" onClick={() => setLinkModal(d)}>
                          <Link2 size={13} /> Ligar
                        </button>
                      )}
                      {d.ssl_enabled ? (
                        <button className="btn btn-sm btn-secondary" title="Remover SSL" onClick={() => removeSSL(d)}>
                          <ShieldOff size={13} />
                        </button>
                      ) : (
                        <button className="btn btn-sm btn-secondary" title="Instalar SSL" onClick={() => installSSL(d)}>
                          <Shield size={13} />
                        </button>
                      )}
                      <button className="btn btn-sm btn-danger" title="Apagar" onClick={() => del(d)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal */}
      <div className={'modal-bg' + (showAdd ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
        <div className="modal">
          <div className="flex-between">
            <h2>Adicionar domínio</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)}><X size={14} /></button>
          </div>
          <p className="sub">O DNS deve apontar para este servidor antes de instalares SSL.</p>
          <div className="field">
            <label className="label">Domínio</label>
            <input className="input" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="meusite.pt" autoFocus />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancelar</button>
            <button className="btn" onClick={add} disabled={!newDomain.trim()}>Adicionar</button>
          </div>
        </div>
      </div>

      {/* Link modal */}
      <div className={'modal-bg' + (linkModal ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && setLinkModal(null)}>
        <div className="modal">
          <div className="flex-between">
            <h2>Ligar {linkModal?.domain} a uma app</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setLinkModal(null)}><X size={14} /></button>
          </div>
          <p className="sub">A configuração nginx é gerada automaticamente.</p>
          <div className="grid" style={{ gap: 8 }}>
            {apps.filter((a) => a.port).map((a) => (
              <button
                key={a.id}
                className="btn btn-secondary"
                style={{ justifyContent: 'space-between' }}
                onClick={() => link(a.id)}
              >
                <span>{a.name}</span>
                <span className="text-xs text-dim">:{a.port}</span>
              </button>
            ))}
            {apps.filter((a) => a.port).length === 0 && (
              <div className="empty">Sem apps com porta definida</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
