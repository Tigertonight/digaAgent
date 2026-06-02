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
 *   5. 底部：Models / Skills 双标签
 *
 * 设计要点：
 *   - 纯受控：所有 state / setter / action 走 props
 *   - 1:1 复制原 JSX，零行为改动
 *   - renderRow 保留为内部闭包（依赖太多 props，提取意义不大）
 */

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Plus, GitBranch, Settings, Brain, Pin, Search, X } from "lucide-react";
import type { SessionInfoLite } from "@/lib/types";
import { formatRelativeTime, shortCwd } from "@/lib/format";
import { BrandLogo } from "./BrandLogo";
import SidebarExplorer from "./SidebarExplorer";

export interface SidebarProps {
  // ===== 开合 =====
  sidebarOpen: boolean;

  // ===== cwd =====
  cwd: string;
  setShowCwdPicker: Dispatch<SetStateAction<boolean>>;

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

  // ===== 底部 Models / Skills =====
  setShowModelsConfig: Dispatch<SetStateAction<boolean>>;
  showSkills: boolean;
  toggleSkills: () => void;

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

export function Sidebar(props: SidebarProps) {
  const {
    sidebarOpen,
    cwd,
    setShowCwdPicker,
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
    setShowModelsConfig,
    showSkills,
    toggleSkills,
    searchQuery,
    onSearchQueryChange,
    searchView,
  } = props;

  const searchEnabled = onSearchQueryChange != null;

  return (
    <aside
      className={`sidebar-container ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}
    >
      {/* sidebar 头：brand + new + (theme toggle) */}
      <div
        className="px-2.5 pt-3 pb-2.5 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between mb-2">
          <span
            className="font-mono text-[15px] font-bold tracking-tight inline-flex items-center gap-1.5"
            style={{ color: "var(--text)" }}
          >
            <BrandLogo size={32} />
            Diga Agent
          </span>
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
          const renderRow = (s: SessionInfoLite, depth: number) => {
            const active = selectedId === s.id;
            const isRenaming = renamingFor === s.id;
            const menuOpen = menuFor === s.id;
            const isPendingDelete = pendingDeleteId === s.id;
            // 状态点：运行中（转圈） > 未读（蓝点） > 无
            // v2：未读判定不再因 active 自动忽略——active 也可能"用户没看到"
            // （主窗口失焦/被遮挡）。markSessionSeen 在用户真聚焦时已写
            // lastSeenMap，所以聚焦着的 active session 这里自然不会 unread。
            const isRunning = !!s.isRunning;
            const seenAt = lastSeenMap[s.id];
            const isUnread = !isRunning && (!seenAt || seenAt < s.modified);
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
                  {depth > 0 && (
                    <GitBranch
                      size={12}
                      className="mt-0.5 shrink-0"
                      style={{ color: "var(--text-muted)" }}
                    />
                  )}
                  {isRunning ? (
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
                      {depth === 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{shortCwd(s.cwd)}</span>
                        </>
                      )}
                    </div>
                  </span>
                </button>
                {/* ⋯ 触发 */}
                <button
                  type="button"
                  data-session-menu
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
                  <div
                    data-session-menu
                    className="absolute right-1 top-7 z-20 rounded border text-xs min-w-[140px] py-1"
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
                  </div>
                )}
              </div>
            );
          };
          const out: React.ReactNode[] = [];
          for (const p of groupedSessions.parents) {
            out.push(renderRow(p, 0));
            const kids = groupedSessions.childrenByParent.get(p.path);
            if (kids) {
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
      {/* sidebar 底：Models / Skills 双标签 */}
      <div
        className="flex items-stretch border-t h-12 shrink-0"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={() => setShowModelsConfig(true)}
          title="配置 models.json"
          className="flex-1 inline-flex items-center justify-center gap-1.5 text-[12px] hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--text)" }}
        >
          <Settings size={14} />
          <span>Models</span>
        </button>
        <div className="w-px" style={{ background: "var(--border)" }} />
        <button
          type="button"
          onClick={toggleSkills}
          title={showSkills ? "关闭 Skills 面板" : "打开 Skills 面板"}
          className="flex-1 inline-flex items-center justify-center gap-1.5 text-[12px] hover:bg-[color:var(--bg-hover)]"
          style={{
            color: "var(--text)",
            background: showSkills ? "var(--bg-hover)" : "transparent",
          }}
        >
          <Brain size={14} />
          <span>Skills</span>
        </button>
      </div>
    </aside>
  );
}
