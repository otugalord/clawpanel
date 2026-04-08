export default function StatusBadge({ status }) {
  const s = (status || '').toLowerCase();
  let cls = 'badge-gray';
  let label = s || 'unknown';
  if (s === 'online') { cls = 'badge-green'; label = 'online'; }
  else if (s === 'stopped') { cls = 'badge-gray'; label = 'stopped'; }
  else if (s === 'errored' || s === 'error') { cls = 'badge-red'; label = 'erro'; }
  else if (s === 'launching' || s === 'starting') { cls = 'badge-yellow'; label = 'a iniciar'; }
  return <span className={`badge ${cls}`}>● {label}</span>;
}
