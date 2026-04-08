import { Play, Square, RotateCw, Trash2, MessageSquareCode } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { useNavigate } from 'react-router-dom';

function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + u[i];
}

function uptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export default function AppCard({ app, onAction, busy }) {
  const navigate = useNavigate();
  const status = app.live?.status || app.status || 'stopped';
  return (
    <div className="app-card">
      <div className="app-card-head">
        <div>
          <div className="app-card-name">{app.name}</div>
          <div className="app-card-meta">
            :{app.port || '—'}{app.domain ? ` · ${app.domain}` : ''}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="app-card-stats">
        <div className="app-card-stat">
          <div className="app-card-stat-label">CPU</div>
          <div className="app-card-stat-value">{app.live?.cpu ?? 0}%</div>
        </div>
        <div className="app-card-stat">
          <div className="app-card-stat-label">RAM</div>
          <div className="app-card-stat-value">{bytes(app.live?.memory)}</div>
        </div>
        <div className="app-card-stat">
          <div className="app-card-stat-label">Uptime</div>
          <div className="app-card-stat-value">{uptime(app.live?.uptime)}</div>
        </div>
      </div>
      <div className="app-card-actions">
        {status === 'online' ? (
          <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => onAction('stop', app)}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="btn btn-sm" disabled={busy} onClick={() => onAction('start', app)}>
            <Play size={13} /> Start
          </button>
        )}
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => onAction('restart', app)} title="Restart">
          <RotateCw size={13} />
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/claude?project=${app.id}`)} title="Claude">
          <MessageSquareCode size={13} />
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => onAction('delete', app)} title="Apagar">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
