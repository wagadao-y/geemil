export function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 100) return `${m.toFixed(0)} m`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  return `${m.toFixed(2)} m`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 時間前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 日前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}
