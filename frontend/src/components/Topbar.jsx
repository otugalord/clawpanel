import { useEffect, useState } from 'react';
import { Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';

function bytes(n) {
  if (!n) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + units[i];
}

export default function Topbar() {
  const [stats, setStats] = useState(null);
  const { send } = useWebSocket((msg) => {
    if (msg.type === 'stats') setStats(msg);
    if (msg.type === 'ready') send?.({ type: 'subscribe_stats' });
  });

  useEffect(() => {
    send({ type: 'subscribe_stats' });
  }, [send]);

  return (
    <div className="topbar">
      <div className="topbar-brand">{stats?.hostname || 'clawpanel'}</div>
      <div className="topbar-mini-stats">
        <span><Cpu size={11} style={{ verticalAlign: 'middle' }} /> <strong>{stats?.cpu?.load ?? '—'}%</strong> CPU</span>
        <span><MemoryStick size={11} style={{ verticalAlign: 'middle' }} /> <strong>{stats?.ram?.pct ?? '—'}%</strong> RAM</span>
        <span><HardDrive size={11} style={{ verticalAlign: 'middle' }} /> <strong>{stats?.disk?.pct ?? '—'}%</strong> Disk</span>
      </div>
    </div>
  );
}
