import type { SessionInfoLite } from "@/lib/types";

function normalizeSessionPath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function normalizeComparablePath(value: string): string {
  return normalizeSessionPath(value).replace(/\\/g, "/").replace(/\/+/g, "/");
}

function sessionIdFromPath(value: string): string | null {
  const base = normalizeComparablePath(value).split("/").pop() ?? "";
  const noExt = base.replace(/\.jsonl$/i, "");
  const uuid = noExt.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  if (uuid?.[1]) return uuid[1];
  return noExt || null;
}

function basename(value: string): string {
  return normalizeComparablePath(value).split("/").filter(Boolean).pop() ?? "";
}

export function findSessionForFile(
  sessions: readonly SessionInfoLite[],
  sessionFile: string
): SessionInfoLite | null {
  if (!sessionFile) return null;
  const exact = sessions.find((session) => session.path === sessionFile);
  if (exact) return exact;

  const normalizedTarget = normalizeComparablePath(sessionFile);
  const normalized = sessions.find(
    (session) => normalizeComparablePath(session.path) === normalizedTarget
  );
  if (normalized) return normalized;

  const targetId = sessionIdFromPath(sessionFile);
  if (targetId) {
    const byId = sessions.find((session) => session.id === targetId);
    if (byId) return byId;
  }

  const targetBase = basename(sessionFile);
  if (!targetBase) return null;
  const basenameMatches = sessions.filter(
    (session) => basename(session.path) === targetBase
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}
