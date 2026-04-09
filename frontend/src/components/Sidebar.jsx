import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquareCode,
  Boxes,
  Globe,
  Settings,
  LogOut,
} from 'lucide-react';
import { api } from '../lib/api';

export default function Sidebar({ user }) {
  const navigate = useNavigate();
  const [claudeStatus, setClaudeStatus] = useState(null);

  useEffect(() => {
    const load = () =>
      api.get('/api/system/claude-status').then(setClaudeStatus).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const items = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/claude', label: 'Claude Code', icon: MessageSquareCode },
    { to: '/apps', label: 'Apps', icon: Boxes },
    { to: '/domains', label: 'Domains', icon: Globe },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  const claudeDotColor =
    claudeStatus?.installed && claudeStatus?.authenticated
      ? 'var(--green)'
      : claudeStatus?.installed
      ? 'var(--yellow)'
      : 'var(--red)';
  const claudeLabel =
    claudeStatus?.installed && claudeStatus?.authenticated
      ? 'Claude authenticated'
      : claudeStatus?.installed
      ? 'Claude not authenticated'
      : 'Claude not installed';

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">🦀</div>
        ClawPanel
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-section">Management</div>
        {items.map((it) => {
          const Ico = it.icon;
          return (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === '/'}
              className={({ isActive }) => 'sidebar-item' + (isActive ? ' active' : '')}
            >
              <Ico size={16} /> {it.label}
            </NavLink>
          );
        })}
      </nav>
      <div
        onClick={() => navigate('/settings')}
        title={claudeLabel}
        style={{
          padding: '10px 14px',
          margin: '0 10px 6px',
          background: 'var(--card2)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          fontSize: 11,
          color: 'var(--text-dim)',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: claudeDotColor,
            boxShadow: `0 0 6px ${claudeDotColor}`,
            flexShrink: 0,
          }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {claudeLabel}
        </span>
      </div>
      <div className="sidebar-footer">
        <div className="avatar">{(user?.username || 'U').charAt(0).toUpperCase()}</div>
        <div>
          <div style={{ color: 'var(--text)', fontWeight: 600 }}>{user?.username || 'admin'}</div>
        </div>
        <button
          className="logout"
          onClick={() => {
            api.setToken(null);
            navigate('/login');
          }}
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
