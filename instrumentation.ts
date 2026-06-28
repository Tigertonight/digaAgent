/**
 * Next.js instrumentation：服务进程启动时执行一次。
 *
 * 保持空壳：Next 会同时分析 node/edge instrumentation，把 server-only store
 * 模块放在这里会污染 Edge 扫描或在 dev chunk 中解析失败。Agent Team 的 stale
 * recovery 由 Team API 路径懒执行。
 */
export async function register(): Promise<void> {
  const proc = (globalThis as unknown as { process?: NodeJS.Process }).process;
  if (!proc || proc.env.NEXT_RUNTIME !== "nodejs") return;
  return;
}
