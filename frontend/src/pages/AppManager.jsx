import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import AppCard from '../components/AppCard';
import { api } from '../lib/api';

export default function AppManager() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', port: '', script: '' });

  const load = async () => {
    try {
      const d = await api.get('/api/apps');
      setApps(d.apps || []);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const openNew = async () => {
    setForm({ name: '', port: '', script: '' });
    try {
      const d = await api.get('/api/apps/free-port');
      setForm((f) => ({ ...f, port: String(d.port) }));
    } catch {}
    setShowNew(true);
  };

  const createApp = async () => {
    try {
      const d = await api.post('/api/apps', form);
      toast.success('App created — open Claude to start building');
      setShowNew(false);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onAction = async (action, app) => {
    setBusyId(app.id);
    try {
      if (action === 'delete') {
        if (!window.confirm(`Delete "${app.name}"? Files in ${app.folder} will NOT be removed.`)) { setBusyId(null); return; }
        await api.del(`/api/apps/${app.id}`);
        toast.success('Deleted');
      } else {
        await api.post(`/api/apps/${app.id}/${action}`);
        toast.success(action + ' ok');
      }
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Apps</h1>
          <p>{apps.length} apps registered · PM2 manages the processes</p>
        </div>
        <div className="page-header-actions">
          <button className="btn" onClick={openNew}>
            <Plus size={14} /> New App
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /></div>
      ) : apps.length === 0 ? (
        <div className="card empty">
          <div className="emoji">📦</div>
          <div>No apps yet. Click "New App" to create one.</div>
        </div>
      ) : (
        <div className="grid grid-cards">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} onAction={onAction} busy={busyId === app.id} />
          ))}
        </div>
      )}

      <div className={'modal-bg' + (showNew ? ' show' : '')} onClick={(e) => e.target === e.currentTarget && setShowNew(false)}>
        <div className="modal">
          <div className="flex-between">
            <h2>New App</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowNew(false)}><X size={14} /></button>
          </div>
          <p className="sub">Creates the folder on the server and registers it in the DB. Then open Claude to start building.</p>
          <div className="field">
            <label className="label">Name</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-site" autoFocus />
          </div>
          <div className="grid grid-2" style={{ marginTop: 14 }}>
            <div>
              <label className="label">Port</label>
              <input className="input" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="3001" />
            </div>
            <div>
              <label className="label">Script (optional)</label>
              <input className="input" value={form.script} onChange={(e) => setForm({ ...form, script: e.target.value })} placeholder="index.js or npm" />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
            <button className="btn" onClick={createApp} disabled={!form.name.trim()}>Create</button>
          </div>
        </div>
      </div>
    </div>
  );
}
