export const DEFAULT_CLIENT_REQUEST_TTL_MS = 2 * 60 * 1000;

export function claimRecentClientRequest(
  requests: Map<string, number>,
  clientRequestId: string | null | undefined,
  now = Date.now(),
  ttlMs = DEFAULT_CLIENT_REQUEST_TTL_MS
): boolean {
  const requestId = clientRequestId?.trim();
  if (!requestId) return true;
  for (const [key, ts] of requests) {
    if (now - ts > ttlMs) requests.delete(key);
  }
  if (requests.has(requestId)) return false;
  requests.set(requestId, now);
  return true;
}
