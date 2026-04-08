import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquareCode,
  Boxes,
  Globe,
  TerminalSquare,
  Settings,
  LogOut,
} from 'lucide-react';
import { api } from '../lib/api';

export default function Sidebar({ user }) {
  const navigate = useNavigate();

  const items = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/claude', label: 'Claude Code', icon: MessageSquareCode },
    { to: '/apps', label: 'Apps', icon: Boxes },
    { to: '/domains', label: 'Domínios', icon: Globe },
    { to: '/terminal', label: 'Terminal', icon: TerminalSquare },
    { to: '/settings', label: 'Definições', icon: Settings },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">C</div>
        ClawPanel
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-section">Gestão</div>
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
          title="Sair"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
