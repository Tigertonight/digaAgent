"use client";

/**
 * 右侧文件浏览器面板（接 /api/files）。
 *
 * 行为：
 * - 起点 = props.initialPath（一般是 session.cwd）
 * - 上方 toolbar：返回上级 / 路径输入框 / 刷新 / 关闭
 * - 列表：懒加载（点击文件夹展开）
 * - 点击文件 → 下半部分显示内容（Markdown 高亮）
 * - 文本文件可编辑保存（PUT /api/files）
 */
import Image from "next/image";
import { CornerDownRight, File, FileText, Folder, Link2, WrapText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";
import {
  previewStore,
  parseVirtualPath,
  isVirtualPath,
} from "@/lib/preview-store";

interface Props {
  initialPath: string;
  /** 外部指定要立即打开的文件绝对路径。 */
  initialFile?: string;
  onClose: () => void;
  /** 若提供，文件/目录条目会显示一个 ↪ 按钮，点击后把绝对路径传给回调（用于"插入到对话"） */
  onPickPath?: (absPath: string) => void;
  /** 若提供，顶栏会显示"用此目录"按钮，点击后把当前 root 传出（用于切换 cwd） */
  onPickDir?: (absPath: string) => void;
  /** 当 tree/viewer 折叠状态变化时通知外层,以便外层容器同步收缩宽度 */
  onLayoutChange?: (state: {
    treeCollapsed: boolean;
    viewerHidden: boolean;
  }) => void;
  /** 渲染模式:
   *  - "full"   (默认) 主界面右侧:tree + viewer 双栏,带预览/编辑
   *  - "picker"        弹窗:仅 tree,顶部加搜索框,无预览面板  */
  mode?: "full" | "picker";
}

interface DirEntry {
  name: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface DirResponse {
  kind: "dir";
  path: string;
  entries: DirEntry[];
}

interface FileResponse {
  kind: "file";
  path: string;
  size: number;
  modified: string;
  content: string;
  binary?: boolean;
  mime?: string;
  dataBase64?: string;
}

type FetchResp = DirResponse | FileResponse | { error: string };

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  rb: "ruby",
  php: "php",
};

function langFor(name: string): string {
  const m = name.toLowerCase().match(/\.([^.]+)$/);
  if (!m) return "";
  return LANG_BY_EXT[m[1]] ?? "";
}

function isProbablyText(name: string, content: string): boolean {
  // /api/files 已经 utf8 读了，再做一道粗判：含 NUL byte 视为 binary
  if (content.indexOf("\u0000") >= 0) return false;
  return true;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p: string): string {
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return "/";
  return trimmed.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** ============ 单个目录节点（递归） ============ */
function DirNode({
  path,
  level,
  selectedFile,
  onSelectFile,
  onPickPath,
  onEnterDir,
  filter,
}: {
  path: string;
  level: number;
  selectedFile: string | null;
  onSelectFile: (p: string) => void;
  onPickPath?: (absPath: string) => void;
  /** 双击文件夹时调用：把该路径设为新 root */
  onEnterDir?: (absPath: string) => void;
  /** 仅根层应用:按名字 substring 过滤(大小写不敏感)。空字符串 = 不过滤 */
  filter?: string;
}) {
  const [open, setOpen] = useState(level === 0); // 根默认展开
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const resp = await fetch(
        `/api/files?path=${encodeURIComponent(path)}`
      );
      const data: FetchResp = await resp.json();
      if (!resp.ok || "error" in data) {
        throw new Error("error" in data ? data.error : `HTTP ${resp.status}`);
      }
      if (data.kind !== "dir") throw new Error("not a directory");
      // 排序：文件夹在前，按名字
      const sorted = [...data.entries].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (open && entries === null && !loading) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) void load();
      });
      return () => {
        cancelled = true;
      };
    }
  }, [open, entries, loading, load]);

  // 父路径变化（例如根 path 改了）时重置
  useEffect(() => {
    queueMicrotask(() => setEntries(null));
  }, [path]);

  const indent = { paddingLeft: level * 12 };

  return (
    <div>
      <div
        className="w-full flex items-center gap-1 px-2 py-0.5 text-xs hover:opacity-80"
        style={{ ...indent, color: "var(--fg)" }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onDoubleClick={() => {
            if (level > 0 && onEnterDir) onEnterDir(path);
          }}
          className="flex-1 min-w-0 flex items-center gap-1 text-left"
          title={
            level > 0 && onEnterDir
              ? `${path}\n双击进入此目录`
              : path
          }
        >
          <span
            className="w-3 inline-block text-center"
            style={{ color: "var(--fg-muted)" }}
          >
            {open ? "▾" : "▸"}
          </span>
          <Folder size={12} style={{ color: "var(--fg-muted)" }} />
          <span className="truncate">
            {level === 0 ? path : basename(path)}
          </span>
        </button>
        {level === 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void load();
            }}
            className="ml-auto px-1 text-token-xs"
            style={{ color: "var(--fg-faint)" }}
            title="reload"
          >
            ↻
          </button>
        )}
      </div>
      {open && (
        <div>
          {loading && (
            <div
              className="px-2 py-0.5 text-token-xs"
              style={{ ...indent, paddingLeft: (level + 1) * 12, color: "var(--fg-faint)" }}
            >
              loading…
            </div>
          )}
          {err && (
            <div
              className="px-2 py-0.5 text-token-xs text-[color:var(--color-danger)]"
              style={{ paddingLeft: (level + 1) * 12 }}
            >
              {err}
            </div>
          )}
          {entries &&
            entries
              .filter((e) => {
                // filter 仅在根层(level===0)生效:用户在 picker 模式顶部输入的关键词
                if (!filter || level !== 0) return true;
                return e.name.toLowerCase().includes(filter.toLowerCase());
              })
              .map((e) => {
              const child = joinPath(path, e.name);
              if (e.isDir) {
                return (
                  <DirNode
                    key={child}
                    path={child}
                    level={level + 1}
                    selectedFile={selectedFile}
                    onSelectFile={onSelectFile}
                    onPickPath={onPickPath}
                    onEnterDir={onEnterDir}
                    filter={filter}
                  />
                );
              }
              const active = selectedFile === child;
              return (
                <div
                  key={child}
                  className="w-full flex items-center gap-1 text-xs hover:opacity-90"
                  style={{
                    paddingLeft: (level + 1) * 12 + 14,
                    background: active ? "var(--bg-panel-2)" : "transparent",
                    color: "var(--fg)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectFile(child)}
                    className="flex-1 min-w-0 flex items-center gap-1 px-2 py-0.5 text-left"
                    title={child}
                  >
                    {e.isSymlink ? (
                      <Link2 size={11} style={{ color: "var(--fg-muted)" }} />
                    ) : (
                      <File size={11} style={{ color: "var(--fg-muted)" }} />
                    )}
                    <span className="truncate">{e.name}</span>
                  </button>
                  {onPickPath && (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onPickPath(child);
                      }}
                      className="px-1 text-token-xs opacity-70 hover:opacity-100"
                      style={{ color: "var(--fg-faint)" }}
                      title="Insert path into chat"
                    >
                      <CornerDownRight size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          {entries && entries.length === 0 && (
            <div
              className="px-2 py-0.5 text-token-xs"
              style={{ paddingLeft: (level + 1) * 12, color: "var(--fg-faint)" }}
            >
              (empty)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** ============ picker 模式下的递归搜索结果列表 ============ */
function SearchResultList({
  hits,
  truncated,
  loading,
  query,
  onPick,
  onEnterDir,
}: {
  hits: { path: string; name: string; isDir: boolean }[];
  truncated: boolean;
  loading: boolean;
  query: string;
  onPick: (absPath: string) => void;
  onEnterDir: (absPath: string) => void;
}) {
  if (loading && hits.length === 0) {
    return (
      <div
        className="px-2 py-1 text-token-xs"
        style={{ color: "var(--fg-faint)" }}
      >
        searching…
      </div>
    );
  }
  if (hits.length === 0) {
    return (
      <div
        className="px-2 py-1 text-token-xs"
        style={{ color: "var(--fg-faint)" }}
      >
        无匹配 “{query}”
      </div>
    );
  }
  return (
    <div>
      {hits.map((h) => (
        <button
          key={h.path}
          type="button"
          onClick={() => (h.isDir ? onEnterDir(h.path) : onPick(h.path))}
          className="w-full text-left flex flex-col gap-0 px-2 py-1 text-xs hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--fg)" }}
          title={h.path}
        >
          <span className="flex items-center gap-1 truncate">
            {h.isDir ? (
              <Folder size={11} style={{ color: "var(--fg-muted)" }} />
            ) : (
              <File size={11} style={{ color: "var(--fg-muted)" }} />
            )}
            <span className="truncate">{h.name}</span>
          </span>
          <span
            className="truncate text-token-xs"
            style={{ color: "var(--fg-faint)", paddingLeft: 14 }}
          >
            {h.path}
          </span>
        </button>
      ))}
      {truncated && (
        <div
          className="px-2 py-1 text-token-xs"
          style={{ color: "var(--fg-faint)" }}
        >
          只显示前 200 条,精确关键词以缩小范围
        </div>
      )}
    </div>
  );
}

/** ============ 文件 viewer ============ */
function FileViewer({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FileResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [wrap, setWrap] = useState(true);
  // html 文件可在源码 / 渲染两种视图切换
  const [htmlRendered, setHtmlRendered] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const resp = await fetch(
        `/api/files?path=${encodeURIComponent(path)}`
      );
      const data: FetchResp = await resp.json();
      if (!resp.ok || "error" in data) {
        throw new Error("error" in data ? data.error : `HTTP ${resp.status}`);
      }
      if (data.kind !== "file") throw new Error("not a file");
      setFile(data);
      setDraft(data.content);
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const save = useCallback(async () => {
    if (!file) return;
    setSaving(true);
    setErr(null);
    try {
      const resp = await fetch(
        `/api/files?path=${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: draft,
        }
      );
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt}`);
      }
      // 重新加载以刷新 size/modified
      await load();
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [file, draft, load]);

  const language = useMemo(() => (file ? langFor(file.path) : ""), [file]);
  const text = file?.content ?? "";
  const isImage = !!file?.binary && !!file?.mime?.startsWith("image/");
  const isAudio = !!file?.binary && !!file?.mime?.startsWith("audio/");
  const isHtml =
    !!file &&
    !file.binary &&
    /\.(html?|xhtml)$/i.test(file.path);
  const isText = file
    ? !file.binary && isProbablyText(file.path, text)
    : true;

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{
        background: "var(--bg-panel)",
      }}
    >
      <div
        className="flex items-center gap-2 px-2 py-1 border-b text-xs"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <span className="truncate flex-1 inline-flex items-center gap-1" title={path}>
          <FileText size={12} style={{ color: "var(--fg-muted)" }} />
          {basename(path)}
        </span>
        {file && !editing && (
          <>
            <span style={{ color: "var(--fg-faint)" }}>
              {file.size}B
            </span>
            {isText && !language && (
              <button
                type="button"
                onClick={() => setWrap((w) => !w)}
                className="px-1.5 py-0.5 rounded border hover:opacity-80"
                style={{
                  borderColor: "var(--border)",
                  background: wrap ? "var(--bg-panel-2)" : "transparent",
                }}
                title={wrap ? "关闭自动换行" : "开启自动换行"}
              >
                <WrapText size={11} />
              </button>
            )}
            {isHtml && (
              <button
                type="button"
                onClick={() => setHtmlRendered((v) => !v)}
                className="px-1.5 py-0.5 rounded border hover:opacity-80"
                style={{
                  borderColor: "var(--border)",
                  background: htmlRendered
                    ? "var(--bg-panel-2)"
                    : "transparent",
                }}
                title={htmlRendered ? "查看源码" : "渲染 HTML"}
              >
                {htmlRendered ? "</>" : "👁"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="px-1.5 py-0.5 rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
              disabled={!isText}
              title={isText ? "edit" : "binary file, edit disabled"}
            >
              ✎
            </button>
          </>
        )}
        {editing && (
          <>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(file?.content ?? "");
              }}
              className="px-1.5 py-0.5 rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
              disabled={saving}
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              className="px-1.5 py-0.5 rounded text-white"
              style={{ background: "var(--accent)" }}
              disabled={saving}
            >
              {saving ? "saving…" : "save"}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          title="reload"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          title="close viewer"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="p-3 text-xs" style={{ color: "var(--fg-faint)" }}>
            loading…
          </div>
        )}
        {err && (
          <div className="p-3 text-xs text-[color:var(--color-danger)]">{err}</div>
        )}
        {!loading && !err && file && !editing && (
          isImage ? (
            <div
              className="p-3 flex items-center justify-center"
              style={{ minHeight: "100%", background: "var(--bg-app)" }}
            >
              <Image
                src={`data:${file.mime};base64,${file.dataBase64}`}
                alt={basename(file.path)}
                width={1200}
                height={800}
                unoptimized
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).replaceWith(
                    document.createTextNode("Failed to load image")
                  );
                }}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  imageRendering: "auto",
                }}
              />
            </div>
          ) : isAudio ? (
            <div
              className="p-3 flex flex-col items-center justify-center gap-2"
              style={{ minHeight: "100%", background: "var(--bg-app)" }}
            >
              <audio
                controls
                src={`data:${file.mime};base64,${file.dataBase64}`}
                onError={(e) =>
                  (e.currentTarget as HTMLAudioElement).replaceWith(
                    document.createTextNode("Failed to load audio")
                  )
                }
                style={{ width: "100%", maxWidth: 480 }}
              />
              <div
                className="text-token-xs"
                style={{ color: "var(--fg-faint)" }}
              >
                {file.mime} · {file.size}B
              </div>
            </div>
          ) : isHtml && htmlRendered ? (
            <iframe
              title={basename(file.path)}
              srcDoc={text}
              sandbox=""
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "var(--bg)",
              }}
            />
          ) : isText ? (
            language ? (
              <div className="p-2 text-token-sm">
                <Markdown
                  size="small"
                  text={`\`\`\`${language}\n${text}\n\`\`\``}
                />
              </div>
            ) : (
              <pre
                className={
                  wrap
                    ? "p-3 text-token-sm whitespace-pre-wrap break-words"
                    : "p-3 text-token-sm whitespace-pre"
                }
                style={{ color: "var(--fg)" }}
              >
                {text}
              </pre>
            )
          ) : (
            <div className="p-3 text-xs" style={{ color: "var(--fg-faint)" }}>
              (binary file, {file.size} bytes — preview disabled)
            </div>
          )
        )}
        {!loading && !err && file && editing && (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-full p-2 text-token-sm font-mono outline-none resize-none"
            style={{
              background: "var(--bg-panel)",
              color: "var(--fg)",
              minHeight: 200,
            }}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

/** ============ 虚拟预览:HTML 字符串 ============ */
function HtmlPreviewViewer({
  content,
  onClose,
}: {
  content: string;
  onClose: () => void;
}) {
  const [showSource, setShowSource] = useState(false);
  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--bg-panel)" }}
    >
      <div
        className="flex items-center gap-2 px-2 py-1 border-b text-xs"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <span
          className="truncate flex-1 inline-flex items-center gap-1"
          style={{ color: "var(--fg-muted)" }}
        >
          <FileText size={12} />
          HTML 预览
        </span>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{
            borderColor: "var(--border)",
            background: showSource ? "var(--bg-panel-2)" : "transparent",
          }}
          title={showSource ? "渲染" : "查看源码"}
        >
          {showSource ? "👁" : "</>"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          title="关闭"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {showSource ? (
          <pre
            className="p-3 text-token-sm whitespace-pre-wrap break-words"
            style={{ color: "var(--fg)" }}
          >
            {content}
          </pre>
        ) : (
          <iframe
            title="HTML 预览"
            srcDoc={content}
            sandbox="allow-scripts allow-forms"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "var(--browser-preview-bg)",
            }}
          />
        )}
      </div>
    </div>
  );
}

/** ============ 虚拟预览:URL ============ */
function UrlPreviewViewer({
  href,
  onClose,
}: {
  href: string;
  onClose: () => void;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [, setLoading] = useState(true);
  const [bumpKey, setBumpKey] = useState(0);

  // X-Frame-Options/CSP 拒绝时,iframe load 不会触发 error,但不会成功;
  // 用 8s 超时兜底:仍 loading 视作可能被拒绝
  useEffect(() => {
    queueMicrotask(() => {
      setLoading(true);
      setLoadFailed(false);
    });
    const t = setTimeout(() => {
      setLoading((cur) => {
        if (cur) setLoadFailed(true);
        return cur;
      });
    }, 8000);
    return () => clearTimeout(t);
  }, [href, bumpKey]);

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--bg-panel)" }}
    >
      <div
        className="flex items-center gap-2 px-2 py-1 border-b text-xs"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <Link2 size={12} style={{ color: "var(--fg-muted)" }} />
        <span
          className="truncate flex-1"
          title={href}
          style={{ color: "var(--fg)" }}
        >
          {href}
        </span>
        <button
          type="button"
          onClick={() => setBumpKey((v) => v + 1)}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          title="reload"
        >
          ↻
        </button>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)", color: "var(--fg)" }}
          title="在浏览器打开"
        >
          ↗
        </a>
        <button
          type="button"
          onClick={onClose}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          title="关闭"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {loadFailed ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-xs text-center"
            style={{ color: "var(--fg-muted)" }}
          >
            <span>该网站拒绝在框架内嵌入(X-Frame-Options / CSP)</span>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded px-3 py-1"
              style={{ background: "var(--accent)", color: "var(--color-bg)" }}
            >
              在浏览器打开
            </a>
          </div>
        ) : (
          <iframe
            key={bumpKey}
            title={href}
            src={href}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            onLoad={() => {
              setLoading(false);
            }}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "var(--browser-preview-bg)",
            }}
          />
        )}
      </div>
    </div>
  );
}

/** ============ 虚拟预览:图片 ============ */
function ImagePreviewViewer({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--bg-panel)" }}
    >
      <div
        className="flex items-center gap-2 px-2 py-1 border-b text-xs"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <span
          className="truncate flex-1"
          style={{ color: "var(--fg-muted)" }}
          title={src}
        >
          图片预览
        </span>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)", color: "var(--fg)" }}
          title="在新标签页打开"
        >
          ↗
        </a>
        <button
          type="button"
          onClick={onClose}
          className="px-1.5 py-0.5 rounded border hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
          title="关闭"
        >
          ✕
        </button>
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-3"
        style={{ background: "var(--bg-app)" }}
      >
        <Image
          src={src}
          alt=""
          width={1200}
          height={800}
          unoptimized
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
          }}
        />
      </div>
    </div>
  );
}

/** ============ 主面板（tree 左 + viewer 右，viewer 顶部 tab 多开） ============ */
export default function FileBrowser({
  initialPath,
  initialFile,
  onClose,
  onPickPath,
  onPickDir,
  onLayoutChange,
  mode = "full",
}: Props) {
  const isPicker = mode === "picker";
  const [root, setRoot] = useState(initialPath);
  const [pathDraft, setPathDraft] = useState(initialPath);
  /** picker 模式下顶部搜索框,< 2 字符按当前层 substring 过滤,>= 2 字符走递归搜索 */
  const [filter, setFilter] = useState("");
  /** 递归搜索结果(picker 模式专用)。null = 还没搜或不在搜索态;[] = 搜了无结果 */
  const [searchHits, setSearchHits] = useState<
    | { hits: { path: string; name: string; isDir: boolean }[]; truncated: boolean }
    | null
  >(null);
  const [searching, setSearching] = useState(false);
  /** picker 模式:最近用过的 root 路径(用于跨项目跳转) */
  const [recentRoots, setRecentRoots] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem("fileBrowser.recentRoots");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const pushRecentRoot = useCallback((p: string) => {
    setRecentRoots((cur) => {
      const next = [p, ...cur.filter((x) => x !== p)].slice(0, 8);
      try {
        localStorage.setItem("fileBrowser.recentRoots", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  /** 已打开的预览 tabs（按打开顺序）。可能是文件绝对路径,或虚拟 path(html:// / url:// / image://) */
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** 虚拟 tab 的标题映射(文件类 tab 不放,直接用 basename) */
  const [tabTitles, setTabTitles] = useState<Record<string, string>>({});
  const [bumpKey, setBumpKey] = useState(0);

  /** tree 列宽（带二级 splitter） */
  const [treeWidth, setTreeWidth] = useState(240);
  /** tree 列折叠到 28px 窄条
   *  用 lazy init 直接从 localStorage 读初值；放到 useEffect 里读会出现"先 false 再 true"的回旋,
   *  且会和 previewStore.subscribe 的 setViewerHidden(false) 抢同一个 commit 周期 → 第二次 preview 看着像没打开。 */
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("fileBrowser.treeCollapsed") === "1";
    } catch {
      return false;
    }
  });
  /** viewer 区域整体隐藏(无 tab 时点 ✕ 收起,新 tab 触发时自动恢复) */
  const [viewerHidden, setViewerHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("fileBrowser.viewerHidden") === "1";
    } catch {
      return false;
    }
  });

  /** 订阅 previewStore:外部触发 html/url/image 预览
   *  注意:此 effect 必须放在 viewerHidden state 声明之后；要在每次 mount 时
   *  先确保 viewer 不被 localStorage 持久化的 hidden 状态盖掉 —— 见上方 lazy init。 */
  useEffect(() => {
    return previewStore.subscribe((req) => {
      setTabs((cur) => (cur.includes(req.id) ? cur : [...cur, req.id]));
      setActiveTab(req.id);
      if (req.title) {
        setTabTitles((m) => ({ ...m, [req.id]: req.title! }));
      }
      // 有新预览来:viewer 必须可见
      setViewerHidden(false);
    });
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "fileBrowser.treeCollapsed",
        treeCollapsed ? "1" : "0"
      );
    } catch {}
  }, [treeCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "fileBrowser.viewerHidden",
        viewerHidden ? "1" : "0"
      );
    } catch {}
  }, [viewerHidden]);
  // 把折叠状态向外汇报,让 ChatApp 容器跟着收缩
  useEffect(() => {
    onLayoutChange?.({ treeCollapsed, viewerHidden });
  }, [treeCollapsed, viewerHidden, onLayoutChange]);
  useEffect(() => {
    try {
      const v = localStorage.getItem("fileBrowser.treeWidth");
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 160) setTreeWidth(n);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("fileBrowser.treeWidth", String(treeWidth));
    } catch {}
  }, [treeWidth]);
  const treeDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onTreeSplitterDown = (e: React.MouseEvent) => {
    e.preventDefault();
    treeDragRef.current = { startX: e.clientX, startW: treeWidth };
    const onMove = (ev: MouseEvent) => {
      const ref = treeDragRef.current;
      if (!ref) return;
      const dx = ev.clientX - ref.startX;
      setTreeWidth(Math.min(480, Math.max(160, ref.startW + dx)));
    };
    const onUp = () => {
      treeDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  // initialPath 变了（session 切换） → 同步
  const prevInitial = useRef(initialPath);
  useEffect(() => {
    if (prevInitial.current !== initialPath) {
      prevInitial.current = initialPath;
      setRoot(initialPath);
      setPathDraft(initialPath);
      setTabs([]);
      setActiveTab(null);
      setTabTitles({});
      setFilter("");
    }
  }, [initialPath]);

  const prevInitialFile = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialFile || prevInitialFile.current === initialFile) return;
    prevInitialFile.current = initialFile;
    const nextRoot = dirname(initialFile);
    setRoot(nextRoot);
    setPathDraft(nextRoot);
    setTabs((cur) => (cur.includes(initialFile) ? cur : [...cur, initialFile]));
    setActiveTab(initialFile);
    setViewerHidden(false);
    setTreeCollapsed(false);
  }, [initialFile]);

  // picker 模式:首次挂载时把当前 cwd 进 recents,作为"回家"快捷入口
  useEffect(() => {
    if (isPicker && initialPath) pushRecentRoot(initialPath);
  }, [initialPath, isPicker, pushRecentRoot]);

  // root 切换 → 清空搜索 filter,避免上一层的关键词把新层卡空
  useEffect(() => {
    setFilter("");
    setSearchHits(null);
  }, [root]);

  // 递归搜索:filter >= 2 字符触发,300ms debounce,< 2 退出搜索态
  useEffect(() => {
    if (!isPicker) return;
    if (filter.length < 2) {
      setSearchHits(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const resp = await fetch(
          `/api/files?path=${encodeURIComponent(root)}&q=${encodeURIComponent(filter)}`
        );
        const data = await resp.json();
        if (cancelled) return;
        if ("error" in data) {
          setSearchHits({ hits: [], truncated: false });
        } else {
          setSearchHits({
            hits: data.entries ?? [],
            truncated: !!data.truncated,
          });
        }
      } catch {
        if (!cancelled) setSearchHits({ hits: [], truncated: false });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filter, root, isPicker]);

  const goUp = useCallback(() => {
    const up = dirname(root);
    setRoot(up);
    setPathDraft(up);
  }, [root]);

  const applyDraft = useCallback(() => {
    if (pathDraft && pathDraft !== root) {
      setRoot(pathDraft);
      if (isPicker) pushRecentRoot(pathDraft);
    }
  }, [pathDraft, root, isPicker, pushRecentRoot]);

  const openFile = useCallback((p: string) => {
    setTabs((cur) => (cur.includes(p) ? cur : [...cur, p]));
    setActiveTab(p);
    setViewerHidden(false);
  }, []);

  const closeTab = useCallback(
    (p: string) => {
      setTabs((cur) => {
        const idx = cur.indexOf(p);
        if (idx === -1) return cur;
        const next = [...cur.slice(0, idx), ...cur.slice(idx + 1)];
        if (activeTab === p) {
          const fallback = next[idx] ?? next[idx - 1] ?? null;
          setActiveTab(fallback);
        }
        return next;
      });
      setTabTitles((m) => {
        if (!(p in m)) return m;
        const { [p]: removedTitle, ...rest } = m;
        void removedTitle;
        return rest;
      });
    },
    [activeTab]
  );

  return (
    <aside
      className="border-l flex w-full min-w-0 h-full min-h-0"
      style={{
        borderColor: "var(--border-soft)",
        background: "var(--bg-app)",
      }}
    >
      {/* 左：tree */}
      {!isPicker && treeCollapsed ? (
        <div
          className="flex flex-col items-center py-1.5 gap-2"
          style={{
            width: 28,
            flexShrink: 0,
            borderRight: "1px solid var(--border-soft)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            type="button"
            onClick={() => setTreeCollapsed(false)}
            title="展开文件列表"
            className="px-1 py-0.5 rounded hover:bg-[color:var(--bg-hover)]"
            style={{ color: "var(--fg-muted)", fontSize: 12 }}
          >
            »
          </button>
          <div
            style={{
              writingMode: "vertical-rl",
              fontSize: 11,
              color: "var(--fg-muted)",
              userSelect: "none",
            }}
          >
            Files
          </div>
        </div>
      ) : (
      <div
        className="flex flex-col min-h-0"
        style={
          isPicker
            ? { flex: 1, minWidth: 0 }
            : viewerHidden
              ? {
                  // viewer 隐藏时,tree 撑满剩余空间(不再固定 treeWidth)
                  flex: 1,
                  minWidth: 0,
                  borderRight: "1px solid var(--border-soft)",
                }
              : {
                  width: treeWidth,
                  flexShrink: 0,
                  borderRight: "1px solid var(--border-soft)",
                }
        }
      >
        <div
          className="px-2 py-1.5 border-b flex items-center gap-1 text-xs"
          style={{ borderColor: "var(--border-soft)" }}
        >
          {!isPicker && (
            <button
              type="button"
              onClick={() => setTreeCollapsed(true)}
              className="px-1 py-0.5 rounded hover:bg-[color:var(--bg-hover)]"
              style={{ color: "var(--fg-muted)" }}
              title="折叠文件列表"
            >
              «
            </button>
          )}
          <span className="font-semibold flex-1">Files</span>
          <button
            type="button"
            onClick={goUp}
            className="px-1.5 py-0.5 rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
            title="up"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => setBumpKey((v) => v + 1)}
            className="px-1.5 py-0.5 rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
            title="reload root"
          >
            ↻
          </button>
          {onPickDir && (
            <button
              type="button"
              onClick={() => onPickDir(root)}
              className="px-2 py-0.5 rounded text-white"
              style={{ background: "var(--accent)" }}
              title={`使用此目录作为 cwd: ${root}`}
            >
              用此目录
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-1.5 py-0.5 rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
            title="close panel"
          >
            ✕
          </button>
        </div>
        <div
          className="px-2 py-1 border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyDraft();
            }}
            onBlur={applyDraft}
            className="w-full rounded border px-1 py-0.5 text-token-xs outline-none"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border)",
              color: "var(--fg)",
            }}
            spellCheck={false}
          />
        </div>
        {isPicker && recentRoots.length > 0 && (
          <div
            className="px-2 py-1 border-b flex flex-wrap gap-1"
            style={{ borderColor: "var(--border-soft)" }}
            title="最近用过的目录"
          >
            {recentRoots.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setRoot(p);
                  setPathDraft(p);
                  pushRecentRoot(p);
                }}
                className="max-w-[180px] truncate rounded border px-1.5 py-0.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                style={{
                  borderColor: "var(--border)",
                  color: p === root ? "var(--fg)" : "var(--fg-muted)",
                  background:
                    p === root ? "var(--bg-panel-2)" : "transparent",
                }}
                title={p}
              >
                {basename(p) || p}
              </button>
            ))}
          </div>
        )}
        {isPicker && (
          <div
            className="px-2 py-1 border-b"
            style={{ borderColor: "var(--border-soft)" }}
          >
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索文件名(≥2 字符递归)…"
              className="w-full rounded border px-1 py-0.5 text-token-xs outline-none"
              style={{
                background: "var(--bg-panel)",
                borderColor: "var(--border)",
                color: "var(--fg)",
              }}
              spellCheck={false}
            />
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto py-1">
          {isPicker && searchHits ? (
            <SearchResultList
              hits={searchHits.hits}
              truncated={searchHits.truncated}
              loading={searching}
              query={filter}
              onPick={(p) => onPickPath?.(p)}
              onEnterDir={(p) => {
                setRoot(p);
                setPathDraft(p);
                if (isPicker) pushRecentRoot(p);
              }}
            />
          ) : (
            <DirNode
              key={`${root}#${bumpKey}`}
              path={root}
              level={0}
              selectedFile={activeTab}
              onSelectFile={isPicker ? (p) => onPickPath?.(p) : openFile}
              onPickPath={onPickPath}
              onEnterDir={(p) => {
                setRoot(p);
                setPathDraft(p);
                if (isPicker) pushRecentRoot(p);
              }}
              filter={isPicker ? filter : undefined}
            />
          )}
        </div>
      </div>
      )}

      {/* tree/viewer 之间的 splitter — 仅当两侧都展示时才渲染 */}
      {!isPicker && !treeCollapsed && !viewerHidden && (
        <div
          onMouseDown={onTreeSplitterDown}
          title="拖动调整列宽"
          style={{
            width: 4,
            cursor: "ew-resize",
            background: "transparent",
            flexShrink: 0,
            transition: "background 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        />
      )}

      {/* 右：tabs + viewer(可被整体隐藏) */}
      {!isPicker && !viewerHidden && (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {tabs.length > 0 ? (
          <>
            <div
              className="flex items-stretch border-b text-xs overflow-x-auto"
              style={{
                borderColor: "var(--border-soft)",
                background: "var(--bg-panel)",
              }}
            >
              {tabs.map((p) => {
                const active = p === activeTab;
                return (
                  <div
                    key={p}
                    className="flex items-center gap-1 px-2 py-1 cursor-pointer border-r"
                    style={{
                      borderColor: "var(--border-soft)",
                      background: active
                        ? "var(--bg-app)"
                        : "var(--bg-panel)",
                      color: active ? "var(--fg)" : "var(--fg-muted)",
                      minWidth: 0,
                      boxShadow: active
                        ? "inset 0 -2px 0 0 var(--accent)"
                        : undefined,
                    }}
                    onClick={() => setActiveTab(p)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        closeTab(p);
                      }
                    }}
                    title={p}
                  >
                    <span
                      className="truncate"
                      style={{ maxWidth: 200, fontFamily: "var(--font-mono)" }}
                    >
                      {tabTitles[p] ?? basename(p)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(p);
                      }}
                      className="ml-1 px-1 opacity-50 hover:opacity-100 rounded hover:bg-[color:var(--bg-hover)]"
                      title="关闭"
                      aria-label={`Close ${basename(p)}`}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {activeTab &&
                (() => {
                  if (isVirtualPath(activeTab)) {
                    const v = parseVirtualPath(activeTab);
                    if (!v) {
                      return (
                        <div
                          className="p-3 text-xs"
                          style={{ color: "var(--fg-faint)" }}
                        >
                          预览内容已失效,请重新打开
                        </div>
                      );
                    }
                    if (v.kind === "html")
                      return (
                        <HtmlPreviewViewer
                          key={activeTab}
                          content={v.payload}
                          onClose={() => closeTab(activeTab)}
                        />
                      );
                    if (v.kind === "url")
                      return (
                        <UrlPreviewViewer
                          key={activeTab}
                          href={v.payload}
                          onClose={() => closeTab(activeTab)}
                        />
                      );
                    return (
                      <ImagePreviewViewer
                        key={activeTab}
                        src={v.payload}
                        onClose={() => closeTab(activeTab)}
                      />
                    );
                  }
                  return (
                    <FileViewer
                      key={activeTab}
                      path={activeTab}
                      onClose={() => closeTab(activeTab)}
                    />
                  );
                })()}
            </div>
          </>
        ) : (
          <div
            className="flex-1 flex flex-col items-center justify-center gap-3 text-xs"
            style={{ color: "var(--fg-faint)" }}
          >
            <span>选择文件预览</span>
            <button
              type="button"
              onClick={() => setViewerHidden(true)}
              className="px-2 py-0.5 rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
              title="收起预览区"
            >
              ✕ 收起预览区
            </button>
          </div>
        )}
      </div>
      )}

      {/* viewer 隐藏时,在边缘提供一个重新打开预览入口 */}
      {!isPicker && viewerHidden && (
        <div
          className="flex flex-col items-center py-1.5 gap-2"
          style={{
            width: 28,
            flexShrink: 0,
            borderLeft: "1px solid var(--border-soft)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            type="button"
            onClick={() => setViewerHidden(false)}
            title="展开预览区"
            className="px-1 py-0.5 rounded hover:bg-[color:var(--bg-hover)]"
            style={{ color: "var(--fg-muted)", fontSize: 12 }}
          >
            «
          </button>
          <div
            style={{
              writingMode: "vertical-rl",
              fontSize: 11,
              color: "var(--fg-muted)",
              userSelect: "none",
            }}
          >
            预览
          </div>
        </div>
      )}
    </aside>
  );
}
