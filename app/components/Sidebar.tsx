"use client";

/**
 * Sidebar —— 左侧栏整体（aside）。
 * RFC-1 阶段 C6：从 ChatApp.tsx 抽出，纯展示+受控组件。
 *
 * 结构：
 *   1. 头：BrandLogo + "Diga Agent" 标题 + New chat 按钮
 *   2. cwd 显示条（点击切换工作目录）
 *   3. sessions 列表（含 renderRow：父/子嵌套、状态点、⋯ 菜单、内联删除确认）
 *   4. EXPLORER 文件树（SidebarExplorer 包装）
 *   5. 底部：Settings 入口
 *
 * 设计要点：
 *   - 纯受控：所有 state / setter / action 走 props
 *   - 1:1 复制原 JSX，零行为改动
 *   - renderRow 保留为内部闭包（依赖太多 props，提取意义不大）
 */

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useRef, useState, useSyncExternalStore } from "react";
import { FloatingLayer } from "./FloatingLayer";
import {
  ChevronRight,
  Download,
  Ellipsis,
  GitBranch,
  Moon,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import type { SessionInfoLite } from "@/lib/types";
import { formatRelativeTime, shortCwd } from "@/lib/format";
import { BrandLogo } from "./BrandLogo";
import SidebarExplorer from "./SidebarExplorer";

export interface SidebarProps {
  // ===== 开合 =====
  sidebarOpen: boolean;
  onToggleSidebar: () => void;

  // ===== cwd =====
  cwd: string;
  setShowCwdPicker: Dispatch<SetStateAction<boolean>>;

  // ===== quick actions =====
  theme: "light" | "dark";
  onToggleTheme: () => void;
  updateAvailable?: boolean;
  updateLatestVersion?: string | null;
  onDownloadUpdate?: () => void;

  // ===== action menu =====
  onSkipUpdateVersion?: () => void;
  onOpenSettings: () => void;

  // ===== sessions =====
  sessions: SessionInfoLite[];
  groupedSessions: {
    parents: SessionInfoLite[];
    childrenByParent: Map<string, SessionInfoLite[]>;
  };
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  lastSeenMap: Record<string, string>;

  // ===== sidebar 临时态（renamingFor / menuFor / pendingDeleteId） =====
  renamingFor: string | null;
  setRenamingFor: Dispatch<SetStateAction<string | null>>;
  renameDraft: string;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  menuFor: string | null;
  setMenuFor: Dispatch<SetStateAction<string | null>>;
  pendingDeleteId: string | null;
  setPendingDeleteId: Dispatch<SetStateAction<string | null>>;

  // ===== sessions actions =====
  startNewSession: () => Promise<void> | void;
  submitRename: (id: string, name: string) => Promise<void> | void;
  executeDeleteSession: (id: string) => Promise<void> | void;
  requestDeleteSession: (id: string) => void;
  handleExportSession: (id: string) => void;
  /**
   * RFC-3 A4：切换 session 置顶。实现：调 PATCH /api/sessions/[id]/meta，
   * 成功后由调用方负责 refreshSessions 拉回最新列表（meta 已通过 A2 聚合在列表里）。
   */
  toggleSessionPin: (id: string, nextPinned: boolean) => Promise<void> | void;

  // ===== explorer =====
  setInput: (v: string | ((cur: string) => string)) => void;
  setShowFilePicker: Dispatch<SetStateAction<boolean>>;

  // ===== RFC-3 Phase B / F2：搜索（可选，未传则不渲染搜索框） =====
  /** 搜索框当前值 */
  searchQuery?: string;
  /** 改变搜索框值 */
  onSearchQueryChange?: (q: string) => void;
  /**
   * 搜索结果视图。非 null 时替代 sessions 列表渲染。
   * 由父组件根据 useSearch().isActive 决定传 null 还是 <SidebarSearch />。
   */
  searchView?: ReactNode | null;
}

// useSyncExternalStore 配套 helpers：仅用于"是否已 hydrate"的标记。
// 客户端永远返回 true（store 无变化所以无需重订阅），服务端返回 false。
// React 会在 client commit 后比对快照差异并自动 re-render，达到与
// `useEffect(()=>setMounted(true))` 等价但不触发 cascading-renders 警告。
const noopUnsubscribe = () => {};
function subscribeHydrated(): () => void {
  return noopUnsubscribe;
}
function getHydratedClient(): boolean {
  return true;
}
function getHydratedServer(): boolean {
  return false;
}

function SidebarActionMenuItem({
  icon,
  label,
  description,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[color:var(--border)] bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-[color:var(--text)]">
          {label}
        </span>
        {description ? (
          <span className="block truncate text-[11px] text-[color:var(--text-muted)]">
            {description}
          </span>
        ) : null}
      </span>
      <ChevronRight
        size={13}
        className="shrink-0 text-[color:var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

export function Sidebar(props: SidebarProps) {
  const {
    sidebarOpen,
    onToggleSidebar,
    cwd,
    setShowCwdPicker,
    theme,
    onToggleTheme,
    updateAvailable,
    updateLatestVersion,
    onDownloadUpdate,
    onSkipUpdateVersion,
    onOpenSettings,
    sessions,
    groupedSessions,
    selectedId,
    setSelectedId,
    lastSeenMap,
    renamingFor,
    setRenamingFor,
    renameDraft,
    setRenameDraft,
    menuFor,
    setMenuFor,
    pendingDeleteId,
    setPendingDeleteId,
    startNewSession,
    submitRename,
    executeDeleteSession,
    requestDeleteSession,
    handleExportSession,
    toggleSessionPin,
    setInput,
    setShowFilePicker,
    searchQuery,
    onSearchQueryChange,
    searchView,
  } = props;

  // SSR 时 lastSeenMap 还没从 localStorage 注水（持久态在 store 里），
  // 直接用会导致服务端误判"全部未读"渲染红点，hydrate 后又消失，触发
  // hydration mismatch。用 useSyncExternalStore 实现 hydrated gate：
  // getServerSnapshot 返回 false（SSR + 首次 hydrate 都是 false），
  // getSnapshot 返回 true（commit 后 React 自动 schedule re-render），
  // 第二帧才开始计算未读。这是 React 19 官方推荐的 SSR-safe 写法，
  // 不触发 React Compiler 的 cascading-renders 警告。
  const hydrated = useSyncExternalStore(
    subscribeHydrated,
    getHydratedClient,
    getHydratedServer,
  );
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    () => new Set()
  );
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  // session ⋯ popover 触发器 DOM 引用 —— FloatingLayer 需要 anchor 元素
  const sessionMenuTriggerRefs = useRef<Map<string, HTMLButtonElement>>(
    new Map()
  );

  const runAction = (fn: () => void) => {
    setActionMenuOpen(false);
    fn();
  };

  const searchEnabled = onSearchQueryChange != null;
  const selectedSession = selectedId
    ? sessions.find((session) => session.id === selectedId)
    : null;
  const selectedParentPath = selectedSession?.parentSessionPath;
  const hasMaintenanceActions = Boolean(
    updateAvailable && (onDownloadUpdate || onSkipUpdateVersion)
  );

  const toggleParentExpanded = (parentPath: string) => {
    setExpandedParents((cur) => {
      const next = new Set(cur);
      if (next.has(parentPath)) next.delete(parentPath);
      else next.add(parentPath);
      return next;
    });
  };

  return (
    <aside
      className={`sidebar-container ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}
    >
      {/* sidebar 头：brand + new + (theme toggle) */}
      <div
        className="px-2.5 pt-3 pb-2.5 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between mb-2 gap-2">
          <span
            className="min-w-0 font-mono text-[15px] font-bold tracking-tight inline-flex items-center gap-1.5"
            style={{ color: "var(--text)" }}
          >
            <BrandLogo size={32} />
            <span className="truncate">Diga Agent</span>
          </span>
          <div
            className="relative inline-flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
            style={{ borderColor: "var(--border-soft)", background: "var(--bg)" }}
          >
            {hasMaintenanceActions ? (
              <button
                type="button"
                ref={actionMenuTriggerRef}
                onClick={() => setActionMenuOpen((value) => !value)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--bg-hover)]"
                style={{ color: "var(--text-muted)" }}
                title="更多操作"
                aria-label="更多操作"
              >
                <Ellipsis size={16} />
              </button>
            ) : null}
            {actionMenuOpen && hasMaintenanceActions ? (
              <FloatingLayer
                anchor={actionMenuTriggerRef.current}
                open={actionMenuOpen}
                onClose={() => setActionMenuOpen(false)}
                placement="bottom-end"
                minWidth={240}
                className="w-[240px] rounded-lg border bg-[color:var(--bg-panel)] p-2 shadow-xl"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="px-2 pb-1.5 pt-0.5 text-[11px] font-medium uppercase text-[color:var(--text-dim)]">
                  App
                </div>
                {updateAvailable && onDownloadUpdate ? (
                  <SidebarActionMenuItem icon={<Download size={15} />} label="Download DMG" description="打开新版本下载页" onClick={() => runAction(onDownloadUpdate)} />
                ) : null}
                {updateAvailable && onSkipUpdateVersion ? (
                  <SidebarActionMenuItem icon={<X size={15} />} label="Ignore this version" description="这个版本不再提醒" onClick={() => runAction(onSkipUpdateVersion)} />
                ) : null}
              </FloatingLayer>
            ) : null}
            {updateAvailable && onDownloadUpdate ? (
              <button
                type="button"
                onClick={onDownloadUpdate}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--bg-hover)]"
                style={{ color: "#2563eb" }}
                title={
                  updateLatestVersion
                    ? `下载最新版 ${updateLatestVersion}`
                    : "下载最新版"
                }
                aria-label="下载最新版"
              >
                <Download size={15} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onToggleTheme}
              className="group/theme inline-flex h-7 w-7 items-center justify-center rounded-md transition-all duration-200 hover:scale-105 hover:bg-[color:var(--bg-hover)] active:scale-95"
              style={{ color: "var(--text-muted)" }}
              title={theme === "dark" ? "切换到 Light" : "切换到 Dark"}
              aria-label="切换 Light/Dark 主题"
            >
              <span
                key={theme}
                className="theme-icon-swap inline-flex transition-transform duration-300 ease-out group-hover/theme:rotate-12"
              >
                {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              </span>
            </button>
            <button
              type="button"
              onClick={onToggleSidebar}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[color:var(--bg-hover)]"
              style={{ color: "var(--text-muted)" }}
              title="收起左侧栏"
              aria-label="收起左侧栏"
            >
              <PanelLeft size={15} />
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={startNewSession}
          className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-md text-[12px] font-medium transition-colors"
          style={{
            background: "var(--bg-hover)",
            color: "var(--text)",
          }}
        >
          <Plus size={14} />
          <span>New chat</span>
        </button>
      </div>
      {/* cwd 显示（点击切换） */}
      <button
        type="button"
        onClick={() => setShowCwdPicker(true)}
        className="w-full px-2.5 py-2 border-b text-[11px] truncate font-mono text-left transition-colors hover:bg-[color:var(--bg-hover)]"
        style={{
          borderColor: "var(--border)",
          color: "var(--text-muted)",
          background: "transparent",
        }}
        title={`${cwd}\n点击切换工作目录`}
      >
        {shortCwd(cwd) || "~"}
      </button>
      {/* 搜索框（RFC-3 Phase B / F2） */}
      {searchEnabled && (
        <div
          className="px-2 py-1.5 border-b relative"
          style={{ borderColor: "var(--border)" }}
        >
          <Search
            size={12}
            className="absolute pointer-events-none"
            style={{
              top: "50%",
              left: 14,
              transform: "translateY(-50%)",
              color: "var(--fg-faint)",
            }}
          />
          <input
            type="text"
            value={searchQuery ?? ""}
            onChange={(e) => onSearchQueryChange?.(e.target.value)}
            placeholder="搜索全部 session…"
            className="w-full pl-7 pr-7 py-1 rounded text-[12px] border"
            style={{
              background: "var(--bg-app)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
          />
          {(searchQuery ?? "").length > 0 && (
            <button
              type="button"
              onClick={() => onSearchQueryChange?.("")}
              className="absolute"
              style={{
                top: "50%",
                right: 12,
                transform: "translateY(-50%)",
                color: "var(--fg-faint)",
              }}
              title="清除搜索"
              aria-label="清除搜索"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {/* 搜索结果视图（非 null 时替代 sessions 列表） */}
      {searchView ?? null}
      {/* sessions 列表（仅当搜索视图为 null 时渲染） */}
      {!searchView && (
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 && (
          <div className="p-4 text-xs" style={{ color: "var(--fg-faint)" }}>
            暂无会话。点击 + New 开始。
          </div>
        )}
        {(() => {
          const renderRow = (
            s: SessionInfoLite,
            depth: number,
            childCount = 0
          ) => {
            const active = selectedId === s.id;
            const isRenaming = renamingFor === s.id;
            const menuOpen = menuFor === s.id;
            const isPendingDelete = pendingDeleteId === s.id;
            const hasChildren = depth === 0 && childCount > 0;
            const childrenExpanded =
              hasChildren &&
              (expandedParents.has(s.path) || selectedParentPath === s.path);
            // 状态点：运行中（转圈） > 未读（蓝点） > 无
            // v2：未读判定不再因 active 自动忽略——active 也可能"用户没看到"
            // （主窗口失焦/被遮挡）。markSessionSeen 在用户真聚焦时已写
            // lastSeenMap，所以聚焦着的 active session 这里自然不会 unread。
            const isRunning = !!s.isRunning;
            const isWaitingUser = s.runtimeState === "waiting_user";
            const seenAt = lastSeenMap[s.id];
            // hydrated gate：SSR/首次 hydrate 时强制 false，避免 lastSeenMap
            // 在客户端注水前误判全部未读。
            const isUnread =
              hydrated && !isRunning && !isWaitingUser && (!seenAt || seenAt < s.modified);
            if (isPendingDelete) {
              return (
                <div
                  key={s.id}
                  className="relative border-b px-3 py-2 text-xs flex items-center gap-2"
                  style={{
                    borderColor: "rgba(248,113,113,0.4)",
                    background: "rgba(248,113,113,0.08)",
                    paddingLeft: 12 + depth * 14,
                  }}
                >
                  <span
                    className="flex-1 truncate"
                    style={{ color: "var(--text)" }}
                    title={s.name || s.firstMessage}
                  >
                    删除「{s.name || s.firstMessage || s.id.slice(0, 8)}」？
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void executeDeleteSession(s.id);
                    }}
                    className="px-2 py-0.5 rounded text-[11px] text-white"
                    style={{ background: "#ef4444" }}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteId(null);
                    }}
                    className="px-2 py-0.5 rounded text-[11px] border"
                    style={{
                      borderColor: "var(--border)",
                      background: "var(--bg-panel)",
                      color: "var(--text-muted)",
                    }}
                  >
                    取消
                  </button>
                </div>
              );
            }
            return (
              <div
                key={s.id}
                className="relative border-b"
                style={{ borderColor: "var(--border-soft)" }}
              >
                <button
                  onClick={() => setSelectedId(s.id)}
                  className="w-full text-left py-1.5 hover:opacity-90 flex items-start gap-1.5"
                  style={{
                    background: active ? "var(--bg-panel-2)" : "transparent",
                    paddingLeft: 12 + depth * 14,
                    paddingRight: 12,
                  }}
                  title={s.cwd}
                >
                  {hasChildren && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleParentExpanded(s.path);
                      }}
                      className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
                      title={childrenExpanded ? "收起子 agent" : "展开子 agent"}
                      aria-label={
                        childrenExpanded ? "收起子 agent" : "展开子 agent"
                      }
                      aria-expanded={childrenExpanded}
                    >
                      <ChevronRight
                        size={13}
                        className="transition-transform"
                        style={{
                          color: "var(--text-muted)",
                          transform: childrenExpanded
                            ? "rotate(90deg)"
                            : "rotate(0deg)",
                        }}
                      />
                    </span>
                  )}
                  {depth > 0 && (
                    <GitBranch
                      size={12}
                      className="mt-0.5 shrink-0"
                      style={{ color: "var(--text-muted)" }}
                    />
                  )}
                  {isWaitingUser ? (
                    <span
                      className="mt-1 shrink-0 inline-block rounded-full"
                      title="需确认"
                      aria-label="需确认"
                      style={{
                        width: 7,
                        height: 7,
                        background: "#f59e0b",
                      }}
                    />
                  ) : isRunning ? (
                    <span
                      className="mt-1 shrink-0 inline-block rounded-full"
                      title="运行中"
                      aria-label="运行中"
                      style={{
                        width: 7,
                        height: 7,
                        background: "#fbbf24",
                        boxShadow: "0 0 0 0 rgba(251,191,36,0.6)",
                        animation: "session-pulse 1.4s ease-in-out infinite",
                      }}
                    />
                  ) : isUnread ? (
                    <span
                      className="mt-1 shrink-0 inline-block rounded-full"
                      title="有新消息"
                      aria-label="有新消息"
                      style={{
                        width: 7,
                        height: 7,
                        background: "#3b82f6",
                      }}
                    />
                  ) : null}
                  <span className="flex-1 min-w-0">
                    {isRenaming ? (
                      <input
                        autoFocus
                        defaultValue={
                          renameDraft || s.name || s.firstMessage
                        }
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitRename(s.id, e.currentTarget.value);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRenamingFor(null);
                          }
                        }}
                        onBlur={(e) =>
                          void submitRename(s.id, e.currentTarget.value)
                        }
                        className="w-full px-1.5 py-0.5 rounded border text-sm"
                        style={{
                          background: "var(--bg-app)",
                          borderColor: "var(--border)",
                          color: "var(--fg)",
                        }}
                      />
                    ) : (
                      <div className="text-sm truncate flex items-center gap-1">
                        {s.meta?.pinned && (
                          <Pin
                            size={11}
                            className="shrink-0"
                            style={{ color: "var(--text-muted)" }}
                            aria-label="已置顶"
                          />
                        )}
                        <span className="truncate">
                          {s.meta?.title ||
                            s.name ||
                            s.firstMessage ||
                            "(empty)"}
                        </span>
                      </div>
                    )}
                    <div
                      className="text-[10px] truncate mt-0.5 flex items-center gap-1.5"
                      style={{ color: "var(--fg-faint)" }}
                    >
                      <span className="shrink-0">
                        {formatRelativeTime(s.modified)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{s.messageCount} msgs</span>
                      {isWaitingUser && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0 font-medium text-amber-600 dark:text-amber-300">
                            需确认
                          </span>
                        </>
                      )}
                      {depth === 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{shortCwd(s.cwd)}</span>
                        </>
                      )}
                      {hasChildren && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0">
                            {childCount} subagent
                            {childCount > 1 ? "s" : ""}
                          </span>
                        </>
                      )}
                    </div>
                  </span>
                </button>
                {/* ⋯ 触发 */}
                <button
                  type="button"
                  data-session-menu
                  ref={(el) => {
                    if (el) sessionMenuTriggerRefs.current.set(s.id, el);
                    else sessionMenuTriggerRefs.current.delete(s.id);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(menuOpen ? null : s.id);
                  }}
                  title="更多操作"
                  className="absolute top-1 right-1 px-1.5 rounded hover:opacity-80 text-sm"
                  style={{ color: "var(--fg-muted)" }}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <FloatingLayer
                    anchor={sessionMenuTriggerRefs.current.get(s.id) ?? null}
                    open={menuOpen}
                    onClose={() => setMenuFor(null)}
                    placement="bottom-end"
                    minWidth={168}
                    minHeight={168}
                    className="rounded border text-xs min-w-[168px] py-1 shadow-xl"
                    style={{
                      background: "var(--bg-panel-2)",
                      borderColor: "var(--border)",
                      color: "var(--fg)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                        void toggleSessionPin(s.id, !s.meta?.pinned);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:opacity-80"
                      style={{ color: "var(--fg)" }}
                    >
                      {s.meta?.pinned ? "📌 取消置顶" : "📌 置顶"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                        setRenamingFor(s.id);
                        setRenameDraft(s.name || "");
                      }}
                      className="w-full text-left px-3 py-1.5 hover:opacity-80"
                      style={{ color: "var(--fg)" }}
                    >
                      ✎ 重命名
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExportSession(s.id);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:opacity-80"
                      style={{ color: "var(--fg)" }}
                    >
                      ⤓ 导出 HTML
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDeleteSession(s.id);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:opacity-80"
                      style={{ color: "#f87171" }}
                    >
                      ✕ 删除
                    </button>
                  </FloatingLayer>
                )}
              </div>
            );
          };
          const out: React.ReactNode[] = [];
          for (const p of groupedSessions.parents) {
            const kids = groupedSessions.childrenByParent.get(p.path);
            const childCount = kids?.length ?? 0;
            out.push(renderRow(p, 0, childCount));
            const expanded =
              childCount > 0 &&
              (expandedParents.has(p.path) || selectedParentPath === p.path);
            if (kids && expanded) {
              for (const c of kids) out.push(renderRow(c, 1));
            }
          }
          return out;
        })()}
      </div>
      )}
      {/* EXPLORER 文件树 */}
      <div
        className="border-t overflow-y-auto shrink-0"
        style={{
          borderColor: "var(--border)",
          maxHeight: "45%",
          background: "var(--bg-panel)",
        }}
      >
        <SidebarExplorer
          root={cwd}
          onPickPath={(absPath) => {
            setInput((cur) => {
              const sep =
                cur.length === 0 || cur.endsWith(" ") ? "" : " ";
              return `${cur}${sep}@${absPath} `;
            });
          }}
          onOpenFilePicker={() => setShowFilePicker(true)}
        />
      </div>
      {/* sidebar 底：低频配置统一进入 Settings */}
      <div
        className="flex items-stretch border-t h-12 shrink-0"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={onOpenSettings}
          title="打开设置"
          className="flex-1 inline-flex items-center justify-center gap-2 text-[13px] font-medium hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--text)" }}
        >
          <Settings size={15} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
