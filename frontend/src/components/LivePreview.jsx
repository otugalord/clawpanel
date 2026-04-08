import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';

export default function LivePreview({ initialUrl = '' }) {
  const [url, setUrl] = useState(initialUrl);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [bust, setBust] = useState(0);
  const iframeRef = useRef(null);

  useEffect(() => setUrl(initialUrl), [initialUrl]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => setBust((b) => b + 1), 5000);
    return () => clearInterval(t);
  }, [autoRefresh]);

  const full = url ? url + (url.includes('?') ? '&' : '?') + '_t=' + bust : '';

  return (
    <div className="preview-pane">
      <div className="preview-head">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://localhost:3001"
        />
        <button className="btn btn-sm btn-ghost" onClick={() => setBust((b) => b + 1)} title="Refresh">
          <RefreshCw size={13} />
        </button>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          auto
        </label>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-ghost">
            <ExternalLink size={13} />
          </a>
        )}
      </div>
      <div className="preview-body">
        {full ? (
          <iframe ref={iframeRef} src={full} title="Live preview" />
        ) : (
          <div className="empty" style={{ background: '#fff', color: '#888' }}>
            Set a URL to see the preview
          </div>
        )}
      </div>
    </div>
  );
}
