import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import { HelpButton, WelcomeModal } from './components/HelpPanel';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import AppManager from './pages/AppManager';
import ClaudeChat from './pages/ClaudeChat';
import DomainManager from './pages/DomainManager';
import Settings from './pages/Settings';
import { api } from './lib/api';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('cp_welcomed'));
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const token = api.getToken();
    if (!token) {
      setLoading(false);
      if (location.pathname !== '/login') navigate('/login');
      return;
    }
    api.get('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => {
        api.setToken(null);
        navigate('/login');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <div className="auth-wrap"><div className="spinner" /></div>;
  }

  if (location.pathname === '/login' || !user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onAuth={setUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="app">
      {showWelcome && (
        <WelcomeModal onClose={() => {
          setShowWelcome(false);
          localStorage.setItem('cp_welcomed', '1');
        }} />
      )}
      <HelpButton />
      <Sidebar user={user} />
      <div className="main">
        <Topbar />
        <div className="content" style={location.pathname === '/claude' ? { padding: 0, overflow: 'hidden' } : {}}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/apps" element={<AppManager />} />
            <Route path="/claude" element={<ClaudeChat />} />
            <Route path="/domains" element={<DomainManager />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
