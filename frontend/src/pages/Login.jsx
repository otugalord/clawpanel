import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export default function Login({ onAuth }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState('loading'); // loading | login | setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/api/auth/status').then((d) => {
      setMode(d.setup ? 'setup' : 'login');
    }).catch(() => setMode('login'));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
      const d = await api.post(endpoint, { username, password });
      api.setToken(d.token);
      onAuth?.(d.user);
      navigate('/');
    } catch (e) {
      setErr(e.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'loading') {
    return <div className="auth-wrap"><div className="spinner" /></div>;
  }

  return (
    <div className="auth-wrap">
      <form className="auth-box" onSubmit={submit}>
        <h1>
          <span className="logo-icon">🦀</span>
          ClawPanel
        </h1>
        <p>
          {mode === 'setup'
            ? 'Create your admin account to get started.'
            : 'Sign in to manage your server.'}
        </p>
        <div className="field">
          <label className="label">Username</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === 'setup' ? 6 : 1}
          />
        </div>
        {err && <div className="auth-error">{err}</div>}
        <button className="btn btn-lg" type="submit" disabled={loading}>
          {loading ? 'Please wait...' : mode === 'setup' ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
