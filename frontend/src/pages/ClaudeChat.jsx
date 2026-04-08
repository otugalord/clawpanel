import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Send, Eye, EyeOff, RotateCw, Trash2 } from 'lucide-react';
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
  const initialProject = searchParams.get('project');

  const [apps, setApps] = useState([]);
  const [projectId, setProjectId] = useState(initialProject ? parseInt(initialProject, 10) : null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const onWsMessage = useCallback((msg) => {
    if (msg.type === 'claude_output' && msg.projectId === projectId) {
      setStreaming(true);
      setStreamBuffer((b) => (b + msg.data).slice(-50000));
    } else if (msg.type === 'claude_done' && msg.projectId === projectId) {
      setStreaming(false);
      setStreamBuffer((buf) => {
        const clean = cleanPtyOutput(buf).trim();
        if (clean) {
          setMessages((m) => [...m, { role: 'assistant', content: clean, at: new Date().toISOString() }]);
        }
        return '';
      });
    } else if (msg.type === 'claude_exit' && msg.projectId === projectId) {
      setStreaming(false);
      setMessages((m) => [...m, { role: 'system', content: 'Sessão Claude terminou.', at: new Date().toISOString() }]);
    }
  }, [projectId]);

  const { send, connected } = useWebSocket(onWsMessage);

  useEffect(() => {
    api.get('/api/apps').then((d) => setApps(d.apps || [])).catch(() => {});
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
      toast.success('Chat limpo');
      return;
    }
    if (text === '/restart') {
      await api.post(`/api/claude/session/${projectId}/restart`);
      setMessages((m) => [...m, { role: 'system', content: 'A reiniciar sessão Claude...' }]);
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
        <h3>Projectos</h3>
        {apps.length === 0 && (
          <div className="text-xs text-dim" style={{ padding: 10 }}>
            Cria uma app primeiro em <strong>Apps</strong>.
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
              {activeApp ? activeApp.name : 'Escolha um projecto'}
            </div>
            <div className="chat-header-sub">
              {activeApp?.folder} {connected ? '' : '· ws offline'}
            </div>
          </div>
          <div className="flex gap-8">
            <button className="btn btn-sm btn-ghost" onClick={() => setShowPreview((v) => !v)} title="Preview">
              {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                if (!projectId) return;
                await api.post(`/api/claude/session/${projectId}/restart`);
                toast('Sessão Claude reiniciada');
              }}
              title="Restart"
            >
              <RotateCw size={14} />
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                if (!projectId) return;
                if (!window.confirm('Limpar histórico de chat?')) return;
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
          {!projectId && (
            <div className="empty">
              <div className="emoji">🤖</div>
              <div>Escolhe um projecto à esquerda para começar a falar com o Claude.</div>
            </div>
          )}
          {messages.map((m, i) => {
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
          {streaming && streamBuffer && (
            <div className="chat-msg assistant">
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                {cleanPtyOutput(streamBuffer).slice(-4000)}
              </pre>
            </div>
          )}
          {streaming && (
            <div className="chat-typing"><span></span><span></span><span></span></div>
          )}
        </div>

        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={projectId ? 'Escreve para o Claude...  (/clear /restart /preview)' : 'Escolhe um projecto primeiro'}
            disabled={!projectId}
            rows={1}
          />
          <button className="send-btn" onClick={sendMessage} disabled={!input.trim() || !projectId}>
            <Send size={16} />
          </button>
        </div>
      </div>

      {showPreview && <LivePreview initialUrl={previewUrl} />}
    </div>
  );
}
