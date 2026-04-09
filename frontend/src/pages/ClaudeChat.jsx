import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Send, Eye, EyeOff, RotateCw, Trash2, Sparkles, Settings as SettingsIcon, ExternalLink } from 'lucide-react';
import { marked } from 'marked';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import LivePreview from '../components/LivePreview';

marked.setOptions({ breaks: true, gfm: true });

/**
 * Strip ANSI escape codes and normalize CR-based terminal updates to just the final line.
 */
function cleanPtyOutput(str) {
  if (!str) return '';
  // Remove ANSI
  let s = str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  // Handle \r: take only text after the last \r on each line
  s = s.split('\n').map((line) => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  }).join('\n');
  return s;
}

export default function ClaudeChat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialProject = searchParams.get('project');

  const [apps, setApps] = useState([]);
  const [projectId, setProjectId] = useState(initialProject ? parseInt(initialProject, 10) : null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [claudeCliError, setClaudeCliError] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState(null);
  const [serverInfo, setServerInfo] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Detect CLI issues from stream content
  const detectCliError = useCallback((text) => {
    if (!text) return false;
    const lower = text.toLowerCase();
    return (
      lower.includes('execvp') ||
      lower.includes('no such file') ||
      lower.includes('command not found') ||
      lower.includes('enoent') ||
      lower.includes('claude: not found')
    );
  }, []);

  // Load Claude status on mount and re-check every 30 seconds
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/system/claude-status').then((d) => {
      if (!alive) return;
      setClaudeStatus(d);
      const ok = d.installed && d.authenticated;
      setClaudeCliError(!ok);
    }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const onWsMessage = useCallback((msg) => {
    if (msg.type === 'claude_output' && msg.projectId === projectId) {
      setStreaming(true);
      setStreamBuffer((b) => {
        const next = (b + msg.data).slice(-50000);
        if (detectCliError(next)) setClaudeCliError(true);
        return next;
      });
    } else if (msg.type === 'claude_exit' && msg.projectId === projectId) {
      setStreaming(false);
      setClaudeCliError(true);
      return;
    } else if (msg.type === 'claude_done' && msg.projectId === projectId) {
      setStreaming(false);
      setStreamBuffer((buf) => {
        const clean = cleanPtyOutput(buf).trim();
        if (clean) {
          if (detectCliError(clean)) setClaudeCliError(true);
          setMessages((m) => [...m, { role: 'assistant', content: clean, at: new Date().toISOString() }]);
        }
        return '';
      });
    }
  }, [projectId, detectCliError]);

  const { send, connected } = useWebSocket(onWsMessage);

  useEffect(() => {
    api.get('/api/apps').then((d) => setApps(d.apps || [])).catch(() => {});
    api.get('/api/system/info').then(setServerInfo).catch(() => {});
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api.get(`/api/claude/session/${projectId}`).then((d) => {
      setMessages(d.session?.messages || []);
    }).catch(() => setMessages([]));
    // Subscribe via WS
    send({ type: 'claude_subscribe', projectId });
    setSearchParams({ project: String(projectId) });
  }, [projectId, send, setSearchParams]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamBuffer]);

  const activeApp = apps.find((a) => a.id === projectId);
  const previewUrl = activeApp?.domain
    ? `https://${activeApp.domain}`
    : activeApp?.port
    ? `http://${window.location.hostname}:${activeApp.port}`
    : '';

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || !projectId) return;
    // Slash commands
    if (text === '/clear') {
      await api.post(`/api/claude/session/${projectId}/clear`);
      setMessages([]);
      setInput('');
      toast.success('Chat cleared');
      return;
    }
    if (text === '/restart') {
      await api.post(`/api/claude/session/${projectId}/restart`);
      setMessages((m) => [...m, { role: 'system', content: 'Restarting Claude session...' }]);
      setInput('');
      return;
    }
    if (text === '/preview') {
      setShowPreview((v) => !v);
      setInput('');
      return;
    }

    setMessages((m) => [...m, { role: 'user', content: text, at: new Date().toISOString() }]);
    setInput('');
    setStreaming(true);
    setStreamBuffer('');
    send({ type: 'claude_message', projectId, message: text });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className={'chat-wrap' + (showPreview ? '' : ' no-preview')}>
      {/* Sidebar with projects */}
      <div className="chat-sidebar">
        <h3>Projects</h3>
        {apps.length === 0 && (
          <div className="text-xs text-dim" style={{ padding: 10 }}>
            Create an app first in <strong>Apps</strong>.
          </div>
        )}
        {apps.map((a) => (
          <div
            key={a.id}
            className={'chat-project' + (a.id === projectId ? ' active' : '')}
            onClick={() => setProjectId(a.id)}
          >
            {a.name}
            <div className="text-xs text-dim" style={{ marginTop: 2 }}>
              :{a.port || '—'}
            </div>
          </div>
        ))}
      </div>

      {/* Main chat */}
      <div className="chat-main">
        <div className="chat-header">
          <div>
            <div className="chat-header-title">
              {activeApp ? activeApp.name : 'Select a project'}
            </div>
            <div className="chat-header-sub">
              {activeApp?.folder} {connected ? '' : '· ws offline'}
            </div>
          </div>
          <div className="flex gap-8">
            {activeApp?.port && serverInfo?.ip && (
              <a
                href={activeApp.domain ? `https://${activeApp.domain}` : `http://${serverInfo.ip}:${activeApp.port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm btn-secondary"
                style={{ textDecoration: 'none', fontSize: 11 }}
              >
                <ExternalLink size={12} />
                {activeApp.domain || `${serverInfo.ip}:${activeApp.port}`}
              </a>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => setShowPreview((v) => !v)} title="Preview">
              {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                if (!projectId) return;
                await api.post(`/api/claude/session/${projectId}/restart`);
                toast('Claude session restarted');
              }}
              title="Restart"
            >
              <RotateCw size={14} />
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                if (!projectId) return;
                if (!window.confirm('Clear chat history?')) return;
                await api.post(`/api/claude/session/${projectId}/clear`);
                setMessages([]);
              }}
              title="Clear"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="chat-messages" ref={scrollRef}>
          {claudeCliError && (
            <div style={{
              maxWidth: 460,
              margin: '40px auto',
              textAlign: 'center',
              padding: '40px 32px',
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 14,
            }}>
              <div style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: 'linear-gradient(135deg, var(--accent), var(--accent2, #8b5cf6))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 18px',
                boxShadow: '0 8px 28px rgba(108,99,255,.35)',
              }}>
                <Sparkles size={32} color="#fff" />
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>
                Connect Claude to get started
              </h3>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.65, marginBottom: 24 }}>
                {claudeStatus && !claudeStatus.installed
                  ? 'The Claude Code CLI needs to be installed on your server. We can guide you through it.'
                  : 'Sign in with your Anthropic account or add an API key to start building with Claude.'}
              </p>
              <button className="btn btn-lg" onClick={() => navigate('/settings')}>
                <SettingsIcon size={15} /> Configure Claude →
              </button>
              <div style={{ marginTop: 14 }}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    const d = await api.get('/api/system/claude-status').catch(() => null);
                    if (d) setClaudeStatus(d);
                    if (d?.installed && d?.authenticated) {
                      setClaudeCliError(false);
                      toast.success('Claude is ready');
                    }
                  }}
                >
                  <RotateCw size={12} /> Re-check
                </button>
              </div>
            </div>
          )}
          {!projectId && !claudeCliError && (
            <div className="empty">
              <div className="emoji">🤖</div>
              <div>Pick a project on the left to start chatting with Claude.</div>
            </div>
          )}
          {!claudeCliError && messages.map((m, i) => {
            if (m.role === 'system') {
              return <div key={i} className="chat-msg system">{m.content}</div>;
            }
            if (m.role === 'assistant') {
              return (
                <div key={i} className="chat-msg assistant" dangerouslySetInnerHTML={{ __html: marked.parse(m.content || '') }} />
              );
            }
            return (
              <div key={i} className="chat-msg user">{m.content}</div>
            );
          })}
          {!claudeCliError && streaming && streamBuffer && (
            <div className="chat-msg assistant">
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                {cleanPtyOutput(streamBuffer).slice(-4000)}
              </pre>
            </div>
          )}
          {!claudeCliError && streaming && (
            <div className="chat-typing"><span></span><span></span><span></span></div>
          )}
        </div>

        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              claudeCliError
                ? 'Configure Claude in Settings first'
                : projectId
                ? 'Message Claude...  (/clear /restart /preview)'
                : 'Pick a project first'
            }
            disabled={!projectId || claudeCliError}
            rows={1}
          />
          <button className="send-btn" onClick={sendMessage} disabled={!input.trim() || !projectId || claudeCliError}>
            <Send size={16} />
          </button>
        </div>
      </div>

      {showPreview && <LivePreview initialUrl={previewUrl} />}
    </div>
  );
}
