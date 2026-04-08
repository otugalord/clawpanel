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
      toast.success('Domain added');
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
    if (!window.confirm(`Unlink ${d.domain}?`)) return;
    try {
      await api.post(`/api/domains/${d.id}/unlink`);
      toast.success('Unlinked');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const installSSL = async (d) => {
    const email = window.prompt(`Email for Let's Encrypt (for ${d.domain}):`, `admin@${d.domain}`);
    if (!email) return;
    toast.loading('Installing SSL...', { id: 'ssl' });
    try {
      const res = await api.post(`/api/domains/${d.id}/ssl`, { email });
      toast.dismiss('ssl');
      if (res.ok) toast.success('SSL installed'); else toast.error('SSL failed — check logs');
      load();
    } catch (e) {
      toast.dismiss('ssl');
      toast.error(e.message);
    }
  };

  const removeSSL = async (d) => {
    if (!window.confirm(`Remove SSL from ${d.domain}?`)) return;
    try {
      await api.post(`/api/domains/${d.id}/ssl/remove`);
      toast.success('SSL removed');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const del = async (d) => {
    if (!window.confirm(`Delete ${d.domain} from the database?`)) return;
    try {
      await api.del(`/api/domains/${d.id}`);
      toast.success('Deleted');
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Domains</h1>
          <p>{domains.length} domains · nginx + certbot</p>
        </div>
        <div className="page-header-actions">
          <button className="btn" onClick={() => setShowAdd(true)}><Plus size={14} /> Add</button>
        </div>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /></div>
      ) : domains.length === 0 ? (
        <div className="card empty">
          <div className="emoji">🌐</div>
          <div>No domains yet. Add one to get started.</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>App</th>
                <th>SSL</th>
                <th>Added</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
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
                      <span className="text-dim text-xs">not linked</span>
                    )}
                  </td>
                  <td>
                    {d.ssl_enabled ? (
                      <span className="badge badge-green">● HTTPS</span>
                    ) : (
                      <span className="badge badge-gray">HTTP</span>
                    )}
                  </td>
                  <td className="text-xs text-dim">{new Date(d.added_at).toLocaleDateString('en-GB')}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="flex gap-8" style={{ justifyContent: 'flex-end' }}>
                      {d.linked_app_id ? (
                        <button className="btn btn-sm btn-secondary" title="Unlink" onClick={() => unlink(d)}>
                          <Link2Off size={13} />
                        </button>
                      ) : (
                        <button className="btn btn-sm" title="Link to app" onClick={() => setLinkModal(d)}>
                          <Link2 size={13} /> Link
                        </button>
                      )}
                      {d.ssl_enabled ? (
                        <button className="btn btn-sm btn-secondary" title="Remove SSL" onClick={() => removeSSL(d)}>
                          <ShieldOff size={13} />
                        </button>
                      ) : (
                        <button className="btn btn-sm btn-secondary" title="Install SSL" onClick={() => installSSL(d)}>
                          <Shield size={13} />
                        </button>
                      )}
                      <button className="btn btn-sm btn-danger" title="Delete" onClick={() => del(d)}>
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
            <h2>Add domain</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)}><X size={14} /></button>
          </div>
          <p className="sub">DNS must already point to this server before installing SSL.</p>
          <div className="field">
            <label className="label">Domain</label>
            <input className="input" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="mysite.com" autoFocus />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn" onClick={add} disabled={!newDomain.trim()}>Add</button>
          </div>
        </div>
      </div>

      {/* Link modal */}
      <div className={'modal-bg' + (linkModal ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && setLinkModal(null)}>
        <div className="modal">
          <div className="flex-between">
            <h2>Link {linkModal?.domain} to an app</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setLinkModal(null)}><X size={14} /></button>
          </div>
          <p className="sub">nginx config is generated automatically.</p>
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
              <div className="empty">No apps with a port defined</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
