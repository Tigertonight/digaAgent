/**
 * 通用格式化 helper（client-side，纯函数）。
 * RFC-1 阶段 C3：从 ChatApp.tsx 内部 helper 提升到 lib。
 *
 * - formatTokens          1234 → "1.2k" / 1_234_567 → "1.2M"
 * - formatMessageTime     消息气泡时间戳（HH:MM 或 MM-DD HH:MM）
 * - formatRelativeTime    "just now" / "5m ago" / "2h ago" / "3d ago" / 日期
 * - shortCwd              /Users/xxx/foo/bar/baz → "…/bar/baz"
 */

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

/**
 * 消息气泡右下角的时间戳。
 * - 今天：HH:MM
 * - 其它：X月Y日 HH:MM
 */
export function formatMessageTime(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function formatRelativeTime(ts: number | string): string {
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("zh-CN");
}

export function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const home = cwd.match(/^\/Users\/[^/]+/)?.[0];
  const trimmed = home ? cwd.replace(home, "~") : cwd;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 2) return trimmed;
  return `…/${parts.slice(-2).join("/")}`;
}
