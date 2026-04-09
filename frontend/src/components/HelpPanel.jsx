import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HelpCircle, X, Lightbulb } from 'lucide-react';

const TIPS = {
  '/': [
    'Your apps are managed by PM2 — they restart automatically if they crash.',
    'Add a domain in the Domains tab to make your app accessible via URL.',
    'Click Claude Code in the sidebar to start building an app with AI.',
  ],
  '/claude': [
    "Be specific! Tell Claude what stack to use: 'Build a Node.js Express app with SQLite'.",
    'Claude knows your server IP and port — it will configure everything correctly.',
    'After Claude builds your app, go to Apps and click Start.',
    "Ask Claude to 'start the app with PM2' to have it running immediately.",
  ],
  '/apps': [
    'Click Start after Claude builds your app.',
    "If Start fails, ask Claude to 'start the app with PM2 --name appname'.",
    'Apps in stopped state don\'t use any resources.',
  ],
  '/domains': [
    "Point your domain's A record to this server IP before linking.",
    'SSL requires your domain DNS to be already pointing here.',
    'After linking a domain, your app is accessible on port 80/443.',
  ],
  '/settings': [
    'Sign in once with Anthropic — your Claude Pro subscription covers Claude Code usage.',
    'API Keys let you access ClawPanel programmatically.',
  ],
};

export function HelpButton() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const tips = TIPS[location.pathname] || TIPS['/'];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px var(--accent-glow)',
          zIndex: 400,
        }}
        title="Help"
      >
        <HelpCircle size={20} />
      </button>

      {open && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            width: 340,
            height: '100vh',
            background: 'var(--card)',
            borderLeft: '1px solid var(--border)',
            zIndex: 500,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '-8px 0 32px rgba(0,0,0,.3)',
          }}
        >
          <div style={{
            padding: '18px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Lightbulb size={16} color="var(--accent)" /> Tips & Help
            </div>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}>
              <X size={18} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            {tips.map((tip, i) => (
              <div
                key={i}
                style={{
                  padding: '14px 16px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  marginBottom: 10,
                  fontSize: 13,
                  color: 'var(--text-dim)',
                  lineHeight: 1.55,
                  display: 'flex',
                  gap: 10,
                }}
              >
                <span style={{ color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>💡</span>
                <span>{tip}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function WelcomeModal({ onClose }) {
  const navigate = useNavigate();
  const steps = [
    { emoji: '🔑', title: 'Sign in with Anthropic', desc: 'Go to Settings and connect your Anthropic account.', action: () => { navigate('/settings'); onClose(); } },
    { emoji: '🤖', title: 'Create an app & chat with Claude', desc: 'Create a new app, then ask Claude to build it for you.', action: () => { navigate('/claude'); onClose(); } },
    { emoji: '🚀', title: 'Start & share', desc: 'Start your app in the Apps tab and share the URL.', action: () => { navigate('/apps'); onClose(); } },
  ];

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(10,22,40,.8)',
      zIndex: 600,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '36px 32px',
        maxWidth: 480,
        width: '100%',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 48, marginBottom: 10 }}>🦀</div>
        <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Welcome to ClawPanel</h2>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 28 }}>
          Your AI-powered VPS control panel. Get started in 3 steps:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
          {steps.map((s, i) => (
            <button
              key={i}
              onClick={s.action}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 18px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color .15s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
            >
              <div style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: 'var(--card2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                flexShrink: 0,
              }}>{s.emoji}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>
                  Step {i + 1}: {s.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{s.desc}</div>
              </div>
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 12 }}>
          Skip — I'll figure it out
        </button>
      </div>
    </div>
  );
}
