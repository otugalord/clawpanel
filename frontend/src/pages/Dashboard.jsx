import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cpu, MemoryStick, HardDrive, Clock, Boxes, Globe,
  MessageSquareCode, TerminalSquare, Plus, Activity,
} from 'lucide-react';
import { api } from '../lib/api';

function bytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + u[i];
}

function uptime(s) {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.get('/api/system/dashboard').then((d) => { if (alive) setData(d); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!data) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>Dashboard</h1>
            <p>A carregar…</p>
          </div>
        </div>
      </div>
    );
  }

  const s = data.stats || {};
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>
            {s.hostname} · {s.distro || s.platform} · up {uptime(s.uptime)}
          </p>
        </div>
        <div className="page-header-actions">
          <button className="btn" onClick={() => navigate('/claude')}>
            <MessageSquareCode size={14} /> Claude
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/apps')}>
            <Plus size={14} /> Nova App
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/terminal')}>
            <TerminalSquare size={14} /> Terminal
          </button>
        </div>
      </div>

      <div className="grid grid-stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="stat-label"><Cpu size={11} style={{ verticalAlign: 'middle' }} /> CPU</div>
          <div className="stat-value">{s.cpu?.load ?? 0}%</div>
          <div className="stat-sub">{s.cpu?.brand?.split(' ').slice(-2).join(' ') || `${s.cpu?.cores || '—'} cores`}</div>
        </div>
        <div className="stat">
          <div className="stat-label"><MemoryStick size={11} style={{ verticalAlign: 'middle' }} /> RAM</div>
          <div className="stat-value">{s.ram?.pct ?? 0}%</div>
          <div className="stat-sub">{bytes(s.ram?.used)} / {bytes(s.ram?.total)}</div>
        </div>
        <div className="stat">
          <div className="stat-label"><HardDrive size={11} style={{ verticalAlign: 'middle' }} /> Disco</div>
          <div className="stat-value">{s.disk?.pct ?? 0}%</div>
          <div className="stat-sub">{bytes(s.disk?.used)} / {bytes(s.disk?.total)}</div>
        </div>
        <div className="stat">
          <div className="stat-label"><Clock size={11} style={{ verticalAlign: 'middle' }} /> Uptime</div>
          <div className="stat-value">{uptime(s.uptime)}</div>
          <div className="stat-sub">desde o último boot</div>
        </div>
      </div>

      <div className="grid grid-stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="stat-label"><Boxes size={11} style={{ verticalAlign: 'middle' }} /> Apps</div>
          <div className="stat-value">{data.runningApps || 0}<span style={{ fontSize: 14, color: 'var(--text-dim)' }}>/{data.apps || 0}</span></div>
          <div className="stat-sub">{data.runningApps || 0} online</div>
        </div>
        <div className="stat">
          <div className="stat-label"><Globe size={11} style={{ verticalAlign: 'middle' }} /> Domínios</div>
          <div className="stat-value">{data.domains || 0}</div>
          <div className="stat-sub">configurados</div>
        </div>
        <div className="stat">
          <div className="stat-label"><Activity size={11} style={{ verticalAlign: 'middle' }} /> PM2</div>
          <div className="stat-value">{data.procs || 0}</div>
          <div className="stat-sub">processos totais</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Actividade Claude Code recente</div>
        {data.claudeActivity?.length > 0 ? (
          data.claudeActivity.map((a) => (
            <div
              key={a.project_id}
              onClick={() => navigate(`/claude?project=${a.project_id}`)}
              style={{
                padding: '12px 0',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <strong style={{ fontSize: 13 }}>{a.project_name}</strong>
                <span className="text-xs text-dim">{new Date(a.updated_at).toLocaleString('pt-PT')}</span>
              </div>
              <div className="text-xs text-dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.last_role === 'user' ? '👤 ' : '🤖 '}{a.last_snippet || '(sem mensagens)'}
              </div>
            </div>
          ))
        ) : (
          <div className="empty">
            <div className="emoji">🤖</div>
            <div>Sem actividade. Abre o Claude para começares.</div>
          </div>
        )}
      </div>
    </div>
  );
}
