/**
 * Formats an ISO timestamp as a concise relative age ("just now", "5m ago",
 * "2h ago", "3d ago", "2w ago", "4mo ago", "1y ago") relative to the viewer's
 * current local clock. Self-contained (zero imports) so it can also be
 * embedded via `.toString()` into standalone exported HTML pages.
 */
export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w ago`;
  const months = Math.max(1, Math.floor(days / 30));
  if (days < 365) return `${months}mo ago`;
  const years = Math.max(1, Math.floor(days / 365));
  return `${years}y ago`;
}

export function formatFullLocalTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}
