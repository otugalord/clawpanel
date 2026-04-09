import { useEffect, useState, useCallback } from 'react';
import { Plus, Link2, Link2Off, Shield, ShieldOff, Trash2, X, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

export default function DomainManager() {
  const [domains, setDomains] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [linkModal, setLinkModal] = useState(null);

  // SSL log modal
  const [sslModal, setSslModal] = useState(null); // { domain, logs: [], done, ok }

  const onWsMessage = useCallback((msg) => {
    if (msg.type === 'ssl_log' && sslModal && msg.domain === sslModal.domain) {
      setSslModal((prev) => prev ? { ...prev, logs: [...prev.logs, msg.data] } : prev);
    }
  }, [sslModal?.domain]);

  const { connected } = useWebSocket(onWsMessage);

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
    const val = newDomain.trim().toLowerCase();
    if (!val) return;
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(val)) {
      toast.error('Invalid domain format');
      return;
    }
    try {
      await api.post('/api/domains', { domain: val });
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
      toast.success('Linked — nginx configured');
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
    // Open the log modal
    setSslModal({ domain: d.domain, logs: ['Starting SSL installation...\n'], done: false, ok: null });
    try {
      const res = await api.post(`/api/domains/${d.id}/ssl`, { email });
      setSslModal((prev) => prev ? {
        ...prev,
        done: true,
        ok: res.ok,
        logs: [...prev.logs, res.ok ? '\n✓ SSL installed successfully!\n' : `\n✗ SSL installation failed.\n${res.log || ''}\n`],
      } : prev);
      if (res.ok) toast.success('SSL installed');
      load();
    } catch (e) {
      const errMsg = e.data?.error || e.message;
      setSslModal((prev) => prev ? {
        ...prev,
        done: true,
        ok: false,
        logs: [...prev.logs, `\n✗ Error: ${errMsg}\n`],
      } : prev);
      toast.error(errMsg);
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
    if (!window.confirm(`Delete ${d.domain}?`)) return;
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
          <p>{domains.length} domain{domains.length !== 1 ? 's' : ''} · Link to apps, install SSL</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-sm btn-ghost" onClick={load}><RefreshCw size={13} /></button>
          <button className="btn" onClick={() => setShowAdd(true)}><Plus size={14} /> Add Domain</button>
        </div>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /></div>
      ) : domains.length === 0 ? (
        <div className="card empty">
          <div className="emoji">🌐</div>
          <div>No domains yet. Point your domain's A record to this server, then add it here.</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>App</th>
                <th>DNS</th>
                <th>SSL</th>
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
                    {d.dns_ok ? (
                      <span className="badge badge-green" title={`Resolves to ${d.dns_resolved?.join(', ')}`}>
                        <CheckCircle2 size={10} /> Pointed here
                      </span>
                    ) : (
                      <span className="badge badge-red" title={`Resolves to ${d.dns_resolved?.join(', ') || 'nothing'}. Server is ${d.server_ip}`}>
                        <XCircle size={10} /> Not pointed
                      </span>
                    )}
                  </td>
                  <td>
                    {d.ssl_enabled ? (
                      <span className="badge badge-green">● HTTPS</span>
                    ) : (
                      <span className="badge badge-gray">HTTP</span>
                    )}
                  </td>
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
                        <button className="btn btn-sm btn-secondary" title="Install SSL" onClick={() => installSSL(d)} disabled={!d.dns_ok}>
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

      {/* Add domain modal */}
      <div className={'modal-bg' + (showAdd ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
        <div className="modal">
          <div className="flex-between">
            <h2>Add Domain</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)}><X size={14} /></button>
          </div>
          <p className="sub">Make sure the domain's A record already points to this server before adding.</p>
          <div className="field">
            <label className="label">Domain</label>
            <input
              className="input"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="mysite.com"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn" onClick={add} disabled={!newDomain.trim()}>Add</button>
          </div>
        </div>
      </div>

      {/* Link to app modal */}
      <div className={'modal-bg' + (linkModal ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && setLinkModal(null)}>
        <div className="modal">
          <div className="flex-between">
            <h2>Link {linkModal?.domain}</h2>
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

      {/* SSL log modal */}
      <div className={'modal-bg' + (sslModal ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && sslModal?.done && setSslModal(null)}>
        <div className="modal" style={{ maxWidth: 600 }}>
          <div className="flex-between">
            <h2>SSL Installation — {sslModal?.domain}</h2>
            {sslModal?.done && (
              <button className="btn btn-ghost btn-sm" onClick={() => setSslModal(null)}><X size={14} /></button>
            )}
          </div>
          <div style={{
            background: '#0a0e14',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 14,
            maxHeight: 350,
            overflow: 'auto',
            fontFamily: 'Menlo, Monaco, monospace',
            fontSize: 11,
            lineHeight: 1.6,
            color: '#c8d0dc',
            whiteSpace: 'pre-wrap',
            marginTop: 14,
          }}>
            {sslModal?.logs.map((l, i) => {
              const isErr = l.includes('✗') || l.toLowerCase().includes('error') || l.toLowerCase().includes('fail');
              const isOk = l.includes('✓') || l.toLowerCase().includes('success');
              return (
                <span key={i} style={{ color: isErr ? 'var(--red)' : isOk ? 'var(--green)' : 'inherit' }}>
                  {l}
                </span>
              );
            })}
            {!sslModal?.done && <span className="spinner" style={{ display: 'inline-block', width: 14, height: 14, verticalAlign: 'middle', marginLeft: 4 }} />}
          </div>
          {sslModal?.done && (
            <div className="modal-footer">
              <button className="btn" onClick={() => setSslModal(null)}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
