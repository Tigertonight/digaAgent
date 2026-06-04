import path from "node:path";

const WRITE_TOOL_PATTERN = /write|edit|patch|apply|delete|move|rename|mkdir|touch/i;
const PATH_KEY_PATTERN = /^(path|file|filename|filepath|target|destination|dest|from|to)$/i;

export interface WriteBoundary {
  requested: string;
  absolute: string;
}

export interface WriteBoundaryViolation {
  reason: string;
  paths: string[];
  allowedPaths: string[];
}

export function isWriteBoundaryTool(toolName: string): boolean {
  return WRITE_TOOL_PATTERN.test(toolName);
}

export function normalizeWriteBoundaries(
  cwd: string,
  writePaths: string[] | undefined
): WriteBoundary[] {
  return (writePaths ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.includes("\0"))
    .map((requested) => ({
      requested,
      absolute: path.resolve(cwd, requested),
    }));
}

function isInsideBoundary(target: string, boundary: string): boolean {
  const relative = path.relative(boundary, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectStringPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  if (trimmed.length > 1000) return null;
  return trimmed;
}

function collectPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  const fileLine = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = fileLine.exec(patchText)) !== null) {
    const item = collectStringPath(match[1] ?? "");
    if (item) paths.push(item);
  }
  return paths;
}

function collectInputPaths(value: unknown, parentKey = ""): string[] {
  if (typeof value === "string") {
    if (parentKey === "patch") return collectPatchPaths(value);
    if (!PATH_KEY_PATTERN.test(parentKey)) return [];
    const item = collectStringPath(value);
    return item ? [item] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectInputPaths(item, parentKey));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    collectInputPaths(item, key)
  );
}

export function findWriteBoundaryViolation(params: {
  toolName: string;
  input: unknown;
  cwd: string;
  writePaths?: string[];
}): WriteBoundaryViolation | null {
  if (!isWriteBoundaryTool(params.toolName)) return null;
  const boundaries = normalizeWriteBoundaries(params.cwd, params.writePaths);
  const allowedPaths = boundaries.map((item) => item.requested);
  if (boundaries.length === 0) {
    return {
      reason: "write-capable tool is not allowed because no writePaths boundary was declared",
      paths: [],
      allowedPaths,
    };
  }

  const rawPaths = Array.from(new Set(collectInputPaths(params.input)));
  if (rawPaths.length === 0) {
    return {
      reason: "write target path could not be verified against writePaths",
      paths: [],
      allowedPaths,
    };
  }

  const outside = rawPaths.filter((item) => {
    const absolute = path.resolve(params.cwd, item);
    return !boundaries.some((boundary) => isInsideBoundary(absolute, boundary.absolute));
  });
  if (outside.length === 0) return null;
  return {
    reason: "write target is outside declared writePaths",
    paths: outside,
    allowedPaths,
  };
}
