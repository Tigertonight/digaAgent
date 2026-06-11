"use client";

/**
 * 左侧 EXPLORER。直接平铺 cwd 下的条目（pi-web FileExplorer 风格），
 * 不再用一个外层 DirNode 把 cwd 包成"根"，避免 EXPLORER 标题和外层节点重复。
 *
 * 子目录懒加载展开；hover 出现 @ mention 按钮把绝对路径抛给父组件。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Paperclip,
} from "lucide-react";

interface Entry {
  name: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface DirResponse {
  kind: "dir";
  path: string;
  entries: Entry[];
}

interface Props {
  root: string;
  onPickPath: (absPath: string) => void;
  /** 选附件入口:打开搜索式 file picker,把所选路径塞进对话输入框 */
  onOpenFilePicker?: () => void;
  /** 父组件可在外部触发刷新（如 cwd 改变时） */
  refreshKey?: number;
}

async function fetchDir(path: string): Promise<Entry[]> {
  const r = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
  const d = (await r.json()) as DirResponse | { error: string };
  if ("error" in d) throw new Error(d.error);
  return d.entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export default function SidebarExplorer({
  root,
  onPickPath,
  onOpenFilePicker,
  refreshKey,
}: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!root) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      setEntries(await fetchDir(root));
    } catch (e) {
      setErr((e as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [collapsed, load, refreshKey]);

  return (
    <div className="text-token-sm" style={{ color: "var(--text)" }}>
      <div
        className="flex items-center justify-between px-2 py-1.5 sticky top-0 z-10"
        style={{
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center gap-1 text-token-xs font-semibold uppercase tracking-wide hover:opacity-80"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
          Explorer
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            title="刷新"
            disabled={loading}
            className="opacity-60 hover:opacity-100 inline-flex items-center disabled:opacity-30"
          >
            ↻
          </button>
          {onOpenFilePicker && (
            <button
              type="button"
              onClick={onOpenFilePicker}
              title="选附件(搜索文件加入对话)"
              className="opacity-60 hover:opacity-100 inline-flex items-center"
            >
              <Paperclip size={12} />
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div>
          {loading && entries === null && (
            <div
              className="px-2 py-1 text-token-xs"
              style={{ color: "var(--text-muted)" }}
            >
              loading…
            </div>
          )}
          {err && (
            <div
              className="px-2 py-1 text-token-xs"
              style={{ color: "var(--color-danger)" }}
              title={err}
            >
              {err}
            </div>
          )}
          {entries?.map((e) => {
            const child = `${root.endsWith("/") ? root : root + "/"}${e.name}`;
            if (e.isDir) {
              return (
                <DirNode
                  key={child}
                  path={child}
                  depth={0}
                  onPickPath={onPickPath}
                />
              );
            }
            return (
              <FileRow
                key={child}
                path={child}
                name={e.name}
                depth={0}
                onPickPath={onPickPath}
              />
            );
          })}
          {entries && entries.length === 0 && !loading && !err && (
            <div
              className="px-2 py-1 text-token-xs"
              style={{ color: "var(--text-muted)" }}
            >
              (empty)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({
  path,
  name,
  depth,
  onPickPath,
}: {
  path: string;
  name: string;
  depth: number;
  onPickPath: (absPath: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPickPath(path)}
      className="group w-full text-left flex items-center gap-1 px-2 py-0.5 hover:bg-[color:var(--bg-hover)]"
      style={{
        paddingLeft: 8 + depth * 12 + 11 + 12,
        paddingRight: 8,
        color: "var(--text)",
      }}
      title={`插入引用：@${path}`}
    >
      <span className="truncate flex-1 min-w-0">{name}</span>
      <span
        className="hidden group-hover:inline-flex shrink-0 items-center gap-0.5 text-token-xs px-1.5 py-[1px] rounded font-medium"
        style={{
          color: "var(--accent)",
          background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        }}
        aria-hidden="true"
      >
        @ mention
      </span>
    </button>
  );
}

function DirNode({
  path,
  depth,
  onPickPath,
}: {
  path: string;
  depth: number;
  onPickPath: (absPath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setEntries(await fetchDir(path));
    } catch (e) {
      setErr((e as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (open && entries === null) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) void load();
      });
      return () => {
        cancelled = true;
      };
    }
  }, [open, entries, load]);

  const name = path.split("/").filter(Boolean).pop() || path;

  return (
    <div>
      <div
        className="group relative flex items-center"
        style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left flex items-center gap-1 py-0.5 hover:bg-[color:var(--bg-hover)] rounded-sm"
          title={path}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Folder size={12} style={{ color: "var(--text-muted)" }} />
          <span className="truncate">{name}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPickPath(path);
          }}
          className="hidden group-hover:inline-flex shrink-0 items-center gap-0.5 text-token-xs ml-1 px-1.5 py-[1px] rounded font-medium hover:opacity-80"
          style={{
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
          }}
          title={`插入引用：@${path}`}
        >
          @ mention
        </button>
      </div>
      {open && (
        <div>
          {loading && (
            <div
              className="px-2 py-0.5 text-token-xs"
              style={{
                paddingLeft: 8 + (depth + 1) * 12,
                color: "var(--text-muted)",
              }}
            >
              loading…
            </div>
          )}
          {err && (
            <div
              className="px-2 py-0.5 text-token-xs"
              style={{
                paddingLeft: 8 + (depth + 1) * 12,
                color: "var(--color-danger)",
              }}
              title={err}
            >
              error
            </div>
          )}
          {entries?.map((e) => {
            const child = `${path.endsWith("/") ? path : path + "/"}${e.name}`;
            if (e.isDir) {
              return (
                <DirNode
                  key={child}
                  path={child}
                  depth={depth + 1}
                  onPickPath={onPickPath}
                />
              );
            }
            return (
              <FileRow
                key={child}
                path={child}
                name={e.name}
                depth={depth + 1}
                onPickPath={onPickPath}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
