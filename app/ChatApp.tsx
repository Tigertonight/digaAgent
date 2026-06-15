"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  // P1-E：input 全局 store helpers。详见 lib/composer/input-store.ts。
  // ChatApp 只需 setter 与 LRU 淘汰清理；可视化读取走 useComposerInput hook。
  getInput as getStoreInput,
  setInput as storeSetInput,
  updateInput as storeUpdateInput,
  deleteInput as deleteStoreInput,
} from "@/lib/composer/input-store";
import { parseSlashCommand } from "@/lib/slash-command";
import { ArrowDown, CheckCircle2, Download, FileText, Loader2, RotateCcw, X } from "lucide-react";
import type {
  SessionInfoLite,
  ChatMessage,
  ImageContentLite,
  ForkableUserMessage,
} from "@/lib/types";
import type {
  WorkflowDebugBundle,
  WorkflowResumeSnapshot,
  WorkflowTraceEvent,
} from "@/lib/workflows/types";
import type { BrowserAnnotation } from "@/lib/browser/types";
import type { AgentProgress } from "@/lib/progress/types";
import { extractImagesFromClipboard } from "@/lib/image-utils";
import { extractMentionsFromPaste } from "@/lib/composer/paste-mentions";
import {
  getElectronApi,
  type AppInfo,
  type UpdateState,
} from "@/lib/electron-bridge";
import { useAudio } from "@/lib/use-audio";
import { useDragDrop } from "@/lib/use-drag-drop";
import { previewStore } from "@/lib/preview-store";
import {
  appendRestoredSubagentBatches,
  createInitialState,
  ctxToMessages,
} from "@/lib/chat-reducer";
import { userFacingMessage } from "@/lib/user-facing-error";
import type { SubagentBatch } from "@/lib/subagents/types";
import {
  emptyRunner,
  DRAFT_KEY,
  type RunnerKey,
  type PendingAttachment,
} from "@/lib/session-runner";
import { useRunners } from "./hooks/useRunners";
import { useSseManager } from "./hooks/useSseManager";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useSessions } from "./hooks/useSessions";
import { useChatStream } from "./hooks/useChatStream";
import { useComposerAttachments } from "./hooks/useComposerAttachments";
import { useMissingFileCheck } from "./hooks/useMissingFileCheck";
import { usePetPusher } from "./hooks/usePetPusher";
import { useBudget } from "./hooks/useBudget";
import { useBudgetEnforcer, type BudgetTrigger } from "./hooks/useBudgetEnforcer";
import { useForkable } from "./hooks/useForkable";
import { useApprovals } from "./hooks/useApprovals";
import { useClarifications } from "./hooks/useClarifications";
import { useSessionMeta } from "./hooks/useSessionMeta";
import { useSearch } from "./hooks/useSearch";
import { useProviderModel } from "./hooks/useProviderModel";
import { useChatModalsState } from "./hooks/useChatModalsState";
import { loadCollabSettings } from "@/lib/collab/settings";
import { useAutocomplete } from "./hooks/useAutocomplete";
import { useMessageRefs } from "./ChatMinimap";
import { EmptyState } from "./components/EmptyState";
import { SessionLoadingState } from "./components/SessionLoadingState";
import { Composer } from "./components/Composer";
import { DropOverlay } from "./components/DropOverlay";
import { Sidebar } from "./components/Sidebar";
import { SidebarSearch } from "./components/SidebarSearch";
import { TopHeader } from "./components/TopHeader";
import { MessagesScrollArea } from "./components/MessagesScrollArea";
import type { WorkflowWorktreeAction } from "./components/MessageView";
import {
  WorkbenchSidebar,
  type WorkbenchView,
} from "./components/WorkbenchSidebar";
import type { FilesLayout } from "./components/RightPanelContainer";
import { ChatModals } from "./components/ChatModals";
import { BudgetExceededModal } from "./components/BudgetExceededModal";
import { Button, TokenIconButton } from "./components/DesignPrimitives";
import { resolveRuntimeIdentity } from "@/lib/runtime/identity";

interface Props {
  initialSessions: SessionInfoLite[];
  defaultCwd: string;
}

type Theme = "dark" | "light";
const INPUT_HISTORY_KEY = "diga:composer:history:v1";
const INPUT_HISTORY_LIMIT = 100;

// SLASH_COMMANDS / SlashName / detectAutocompleteToken 已搬到 hooks/useAutocomplete.ts（RFC-1 阶段 C2）。

function formatWorkflowTime(ms: number | undefined): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function shortWorkflowJson(value: unknown, maxChars = 5000): string {
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (!text) return "(empty)";
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
  } catch {
    return String(value);
  }
}

function workflowTraceSummary(event: WorkflowTraceEvent): string {
  switch (event.type) {
    case "agent_start":
      return [
        event.title,
        event.agentType ? `type=${event.agentType}` : "",
        event.role ? `role=${event.role}` : "",
        event.isolation ? `isolation=${event.isolation}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "agent_end":
      return [
        event.title,
        `status=${event.status}`,
        event.schemaValid === undefined ? "" : `schema=${event.schemaValid}`,
        event.error ?? "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "schema_validation":
      return event.valid ? "schema valid" : event.errors.join("; ");
    case "approval":
      return `${event.capability} · ${event.decision}`;
    default:
      return shortWorkflowJson(event, 800);
  }
}

function UpdateNotice({
  state,
  onView,
  onClose,
}: {
  state: UpdateState;
  onView: () => void;
  onClose: () => void;
}) {
  const latest = state.latestVersion ?? state.releaseName ?? "新版本";
  return (
    <div className="absolute right-4 top-12 z-40 w-[300px] rounded-token-lg border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-2.5 text-[color:var(--text)] shadow-popover">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-[var(--control-sm)] w-[var(--control-sm)] shrink-0 items-center justify-center rounded-token border border-[color:var(--color-info)] bg-[color:var(--color-info-bg)] text-[color:var(--color-info)]">
          <Download size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-token-ui font-semibold">
            Diga Agent {latest} 可安装
          </div>
          <div className="mt-0.5 text-token-sm text-[color:var(--text-muted)]">
            当前版本 {state.currentVersion}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              onClick={onView}
              tone="info"
              variant="soft"
              size="sm"
              leading={<Download size={13} />}
            >
              查看
            </Button>
          </div>
        </div>
        <TokenIconButton
          onClick={onClose}
          icon={<X size={14} />}
          size="xs"
          variant="ghost"
          title="关闭"
          aria-label="关闭更新提醒"
        />
      </div>
    </div>
  );
}

function UpdateLatestNotice({
  state,
  onClose,
}: {
  state: UpdateState;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-4 top-12 z-40 w-[300px] rounded-token-lg border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-2.5 text-[color:var(--text)] shadow-popover">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-[var(--control-sm)] w-[var(--control-sm)] shrink-0 items-center justify-center rounded-token border border-[color:var(--color-success)] bg-[color:var(--color-success-bg)] text-[color:var(--color-success)]">
          <CheckCircle2 size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-token-ui font-semibold">当前已经是最新版本</div>
          <div className="mt-0.5 text-token-sm text-[color:var(--text-muted)]">
            Diga Agent {state.currentVersion}
          </div>
        </div>
        <TokenIconButton
          onClick={onClose}
          icon={<X size={14} />}
          size="xs"
          variant="ghost"
          title="关闭"
          aria-label="关闭更新状态提示"
        />
      </div>
    </div>
  );
}

function formatWorkflowResumeSummaries(
  snapshot: WorkflowResumeSnapshot | undefined,
  checkpointName: string | undefined
): string[] {
  if (!snapshot) return [];
  const selectedCheckpoint = checkpointName
    ? snapshot.checkpointSummaries.find((item) => item.name === checkpointName)
    : snapshot.checkpointSummaries.at(-1);
  const checkpointSummaries = snapshot.checkpointSummaries.slice(-5);
  const artifactSummaries = snapshot.artifactSummaries.slice(-5);
  const lines: string[] = [];
  if (selectedCheckpoint) {
    lines.push(
      "Selected checkpoint preview:",
      `- ${selectedCheckpoint.name}: ${selectedCheckpoint.preview || "(empty)"}`
    );
  }
  if (checkpointSummaries.length > 0) {
    lines.push(
      "",
      "Recent checkpoints:",
      ...checkpointSummaries.map(
        (item) => `- ${item.name}: ${item.preview || "(empty)"}`
      )
    );
  }
  if (artifactSummaries.length > 0) {
    lines.push(
      "",
      "Recent artifacts:",
      ...artifactSummaries.map(
        (item) => `- ${item.name}: ${item.preview || "(empty)"}`
      )
    );
  }
  return lines;
}

function WorkflowDebugInspector({
  bundle,
  loading,
  error,
  onClose,
}: {
  bundle: WorkflowDebugBundle | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <aside
      className="min-h-0 overflow-auto border-t p-3 md:border-l md:border-t-0"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Workflow inspector</div>
          <div className="truncate text-token-xs text-[color:var(--text-muted)]">
            Trace, logs, artifacts, checkpoints, and script
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded border"
          style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
          aria-label="Close workflow inspector"
          title="Close inspector"
        >
          <X size={14} />
        </button>
      </div>
      {loading ? (
        <div className="flex h-32 items-center justify-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
          <Loader2 size={15} className="animate-spin" />
          Loading debug bundle
        </div>
      ) : error ? (
        <div className="rounded-token border border-[color:var(--color-danger)] bg-[color:var(--color-danger-bg)] px-3 py-2 text-token-sm text-[color:var(--color-danger)]">
          {error}
        </div>
      ) : !bundle ? (
        <div className="flex h-32 items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>
          Select a workflow to inspect
        </div>
      ) : (
        <div className="space-y-3 text-token-sm">
          <section className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-subtle)] px-3 py-2">
            <div className="truncate font-semibold">{bundle.workflow.objective}</div>
            <div className="mt-1 grid gap-1 text-token-xs text-[color:var(--text-muted)]">
              <span>{bundle.workflow.status} · {formatWorkflowTime(bundle.workflow.createdAt)}</span>
              <span>
                {bundle.counts.traceEvents} trace · {bundle.counts.logs} logs · {bundle.counts.artifacts} artifacts · {bundle.counts.checkpoints} checkpoints
              </span>
              <span>Capabilities: {bundle.workflow.manifest.capabilities.join(", ")}</span>
            </div>
          </section>

          <section className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-subtle)] px-3 py-2">
            <div className="mb-1 font-semibold">Trace</div>
            {bundle.traceEvents.length ? (
              <div className="space-y-1">
                {bundle.traceEvents.map((event, index) => (
                  <div key={`${event.type}-${index}`} className="rounded-token-sm border border-[color:var(--border-soft)] px-2 py-1">
                    <div className="flex gap-2">
                      <span className="shrink-0 font-medium">{event.type}</span>
                      <span className="min-w-0 truncate text-[color:var(--text-muted)]">
                        {workflowTraceSummary(event)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-token-xs text-[color:var(--text-muted)]">
                      {formatWorkflowTime(event.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[color:var(--text-muted)]">No trace events</div>
            )}
          </section>

          {bundle.logs.length > 0 && (
            <section className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-subtle)] px-3 py-2">
              <div className="mb-1 font-semibold">Logs</div>
              <div className="space-y-1">
                {bundle.logs.slice(-20).map((log, index) => (
                  <div key={index} className="text-[color:var(--text-muted)]">
                    [{log.level}] {log.message}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-subtle)] px-3 py-2">
            <div className="mb-1 font-semibold">Artifacts & checkpoints</div>
            {[...bundle.artifacts, ...bundle.checkpoints].length ? (
              <div className="space-y-1">
                {[...bundle.artifacts, ...bundle.checkpoints].slice(-12).map((item, index) => (
                  <details key={`${item.name}-${index}`}>
                    <summary className="cursor-pointer list-none truncate [&::-webkit-details-marker]:hidden">
                      {item.name}
                    </summary>
                    <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-token-xs text-[color:var(--text-muted)]">
                      {shortWorkflowJson(item.value)}
                    </pre>
                  </details>
                ))}
              </div>
            ) : (
              <div className="text-[color:var(--text-muted)]">No artifacts or checkpoints</div>
            )}
          </section>

          <details className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-subtle)] px-3 py-2">
            <summary className="cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden">
              Script
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-token-xs text-[color:var(--text-muted)]">
              {bundle.script}
            </pre>
          </details>
        </div>
      )}
    </aside>
  );
}

function WorkflowHistoryPanel({
  items,
  loading,
  debugBundle,
  debugLoading,
  debugError,
  onRefresh,
  onClose,
  onResume,
  onInspect,
  onCloseInspector,
}: {
  items: WorkflowResumeSnapshot[];
  loading: boolean;
  debugBundle: WorkflowDebugBundle | null;
  debugLoading: boolean;
  debugError: string | null;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
  onResume: (snapshot: WorkflowResumeSnapshot, checkpointName?: string) => void;
  onInspect: (snapshot: WorkflowResumeSnapshot) => void | Promise<void>;
  onCloseInspector: () => void;
}) {
  const visible = items.slice(0, 50);
  const [selectedCheckpoints, setSelectedCheckpoints] = useState<
    Record<string, string>
  >({});
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-12"
      style={{ background: "var(--color-overlay)" }}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border shadow-2xl"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text)",
        }}
      >
        <div
          className="flex h-11 items-center gap-2 border-b px-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">Workflow history</div>
            <div className="truncate text-token-xs" style={{ color: "var(--text-muted)" }}>
              Resume from persisted checkpoints and artifacts
            </div>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void onRefresh()}
            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs disabled:opacity-50"
            style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded border"
            style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
            aria-label="Close workflow history"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
          <div className="min-h-0 overflow-auto p-2">
            {loading && visible.length === 0 ? (
              <div className="flex h-32 items-center justify-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
                <Loader2 size={15} className="animate-spin" />
                Loading workflows
              </div>
            ) : visible.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>
                No resumable workflow history yet
              </div>
            ) : (
              <div className="space-y-1.5">
                {visible.map((item) => (
                  <div
                    key={item.workflowId}
                    className="rounded border px-3 py-2"
                    style={{
                      borderColor: "var(--border-soft)",
                      background: "color-mix(in srgb, var(--text) 2%, transparent)",
                    }}
                  >
                    <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {item.objective || item.workflowId}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                        <span>{item.status}</span>
                        <span>{item.checkpointNames.length} checkpoints</span>
                        <span>{item.artifactNames.length} artifacts</span>
                        {item.lastCheckpoint ? (
                          <span>Latest: {item.lastCheckpoint.name}</span>
                        ) : null}
                        <span>{formatWorkflowTime(item.lastCheckpoint?.createdAt)}</span>
                      </div>
                      {!item.canResume && item.reason ? (
                        <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                          {item.reason}
                        </div>
                      ) : null}
                      {item.canResume && item.checkpointNames.length > 1 ? (
                        <label className="mt-2 flex max-w-sm items-center gap-2 text-token-xs" style={{ color: "var(--text-muted)" }}>
                          <span className="shrink-0">Checkpoint</span>
                          <select
                            value={
                              selectedCheckpoints[item.workflowId] ??
                              item.lastCheckpoint?.name ??
                              item.checkpointNames[item.checkpointNames.length - 1] ??
                              ""
                            }
                            onChange={(event) =>
                              setSelectedCheckpoints((cur) => ({
                                ...cur,
                                [item.workflowId]: event.target.value,
                              }))
                            }
                            className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-token-xs outline-none"
                            style={{
                              borderColor: "var(--border-soft)",
                              color: "var(--text)",
                            }}
                          >
                            {item.checkpointNames.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {(item.checkpointSummaries.at(-1)?.preview ||
                        item.artifactSummaries.at(-1)?.preview) && (
                        <div
                          className="mt-2 line-clamp-2 text-token-xs"
                          style={{ color: "var(--text-muted)" }}
                          title={
                            item.checkpointSummaries.at(-1)?.preview ??
                            item.artifactSummaries.at(-1)?.preview
                          }
                        >
                          {item.checkpointSummaries.at(-1)?.preview ??
                            item.artifactSummaries.at(-1)?.preview}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => void onInspect(item)}
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs"
                        style={{
                          borderColor: "var(--border-soft)",
                          color: "var(--text-muted)",
                        }}
                      >
                        <FileText size={13} />
                        Inspect
                      </button>
                      <button
                        type="button"
                        disabled={!item.canResume}
                        onClick={() =>
                          onResume(
                            item,
                            selectedCheckpoints[item.workflowId] ??
                              item.lastCheckpoint?.name
                          )
                        }
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-45"
                        style={{
                          borderColor: "var(--border-soft)",
                          color: item.canResume ? "var(--text)" : "var(--text-muted)",
                        }}
                      >
                        <RotateCcw size={13} />
                        Resume
                      </button>
                    </div>
                  </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <WorkflowDebugInspector
            bundle={debugBundle}
            loading={debugLoading}
            error={debugError}
            onClose={onCloseInspector}
          />
        </div>
      </div>
    </div>
  );
}

export default function ChatApp({ initialSessions, defaultCwd }: Props) {
  // setError 需要在 useSessions（B1）之前声明，作为 onError 回调注入。
  // 顶层 error 用于 UI banner 展示；useState setter 身份稳定，可安全提前。
  const [error, setError] = useState<string | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(INPUT_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  });
  const historyCursorRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");

  // ===== 多会话核心容器与 SSE 连接池（RFC-1 阶段 A1 + A2） =====
  // - runnersRef（useRunners）：所有会话工作面的"权威存储"
  // - esMapRef（useSseManager）：每个 runner 的 SSE 连接；切换会话时不关，后台流式继续
  // - LRU 淘汰 runner 时，useRunners 通过 onEvict 直接调到 useSseManager.closeSseFor
  //
  // hook 调用顺序：useSseManager 先 → useRunners 后（onEvict 直传 closeSseFor）
  // 但 useSseManager.onStatusChange 又需要 updateRunner（来自 useRunners）—— 循环依赖。
  // 解法：updateRunner 走 ref 转发；handleAgentEvent 是函数声明（hoisted）+ 也走 ref，
  //       让 useSseManager 内部回调闭包不直接依赖未定义的标识符。
  const updateRunnerRef = useRef<
    ((key: RunnerKey, patch: import("@/lib/session-runner").RunnerPatch) => void) | null
  >(null);
  const handleAgentEventRef = useRef<
    | ((
        event: { type: string; [k: string]: unknown },
        agentId: string,
        key: RunnerKey
      ) => void)
    | null
  >(null);
  // refreshForkList 来自 useForkable（声明在 useAgentEvents 之后）；
  // 同 handleAgentEvent / updateRunner，用 ref 转发避免时序倒置。
  const refreshForkListRef = useRef<
    ((agentId: string, ownerKey: RunnerKey) => void) | null
  >(null);

  const { esMapRef, attachSseFor, closeSseFor } = useSseManager({
    onEvent: (event, agentId, key) => {
      // useSseManager 的 onEvent event 类型是 unknown（hook 不知道业务结构）；
      // 这里 cast 到 handleAgentEvent 期望的形状。SSE envelope 一定有 type 字段。
      handleAgentEventRef.current?.(
        event as { type: string; [k: string]: unknown },
        agentId,
        key
      );
    },
    onStatusChange: (key, patch) => {
      updateRunnerRef.current?.(key, patch);
    },
  });

  const handleEvictRunner = useCallback(
    (key: RunnerKey) => {
      // LRU 淘汰 runner 时同步清理该 key 在 input store 里的草稿，
      // 避免留下“孤儿” input slot。
      deleteStoreInput(key);
      closeSseFor(key);
    },
    [closeSseFor]
  );

  const {
    runnersRef,
    activeKey,
    activeSnapshot,
    activeKeyRef,
    updateRunner,
    updateActive,
    switchTo,
    setRunner,
  } = useRunners({
    onEvict: handleEvictRunner,
  });

  // 把 updateRunner 绑到 ref，供 useSseManager 的 onStatusChange 回调使用
  useEffect(() => {
    updateRunnerRef.current = updateRunner;
    return () => {
      updateRunnerRef.current = null;
    };
  }, [updateRunner]);

  // E2E 诊断钩子:仅在 window.__E2E__=true 时挂载,把 runner 状态暴露给测试断言。
  // 不影响 prod 行为,默认 noop。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { __E2E__?: boolean; __chatAppDiag?: unknown };
    if (!w.__E2E__) return;
    w.__chatAppDiag = {
      runners: runnersRef,
      esMap: esMapRef,
      activeKey: () => activeKeyRef.current,
      runnerCount: () => runnersRef.current.size,
      runnerKeys: () => [...runnersRef.current.keys()],
      sseKeys: () => [...esMapRef.current.keys()],
      inputFor: (key: RunnerKey) => getStoreInput(key),
    };
  }, [activeKeyRef, esMapRef, runnersRef]);

  // ===== Session 列表 + 已读追踪 + CRUD（RFC-1 阶段 B1） =====
  // 持有 sessions / selectedId / lastSeenMap（localStorage 持久化，lazy init 修复刷新已读丢失）；
  // 提供 groupedSessions / refreshSessions / submitRename / executeDeleteSession 等。
  const {
    sessions,
    setSessions,
    selectedId,
    setSelectedId,
    lastSeenMap,
    groupedSessions,
    refreshSessions,
    submitRename: submitRenameImpl,
    executeDeleteSession: executeDeleteSessionImpl,
    lastSeenMapRef,
  } = useSessions({
    initialSessions,
    closeSseFor,
    runnersRef,
    activeKeyRef,
    switchTo,
    onError: setError,
  });

  // chatState / forkable* 等 per-runner 字段已挪到 RunnerState。
  // messages / visibleMessageCount / messageRefs 依赖 chatState/forkableUserMessages,
  // 已下移到 activeSnapshot 解构之后(否则用前先声明会报错)。

  // agentId / agentSessionId / input / pending* / streaming / phase / compacting /
  // compactError / retryInfo / stats / toolsCount 已挪到 RunnerState(见下方解构区)。
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 输入框 @ / 自动补全已挪到 hooks/useAutocomplete.ts（RFC-1 阶段 C2）。
  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();
  const [cwd, setCwd] = useState(defaultCwd);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 图片/文件附件相关 hook 调用挪到 setter wrappers 之后（依赖 setPendingImages/setPendingFiles）

  const {
    visibleProviders,
    currentProvider,
    providerId,
    setProviderId,
    modelId,
    setModelId,
    reloadProviders,
  } = useProviderModel();

  // thinking 字段(thinkingLevel / availableThinkingLevels / supportsThinking)
  // 已挪到 RunnerState。见下方 activeSnapshot 解构区。

  // theme: 首屏固定 light，避免服务端/客户端因 localStorage 差异导致 hydration mismatch。
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      let next: Theme = "light";
      try {
        const stored = localStorage.getItem("pi-theme");
        if (stored === "light" || stored === "dark") next = stored;
      } catch {
        /* noop */
      }
      setTheme(next);
      document.documentElement.setAttribute("data-theme", next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const apply = () => {
      setTheme(next);
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("pi-theme", next);
      } catch {
        /* noop */
      }
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches;
    const doc = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<void> };
    };
    if (!reduceMotion && typeof doc.startViewTransition === "function") {
      void doc.startViewTransition(apply).finished.catch(() => {});
      return;
    }
    apply();
  };

  const initialWorkbenchView = (): WorkbenchView => {
    if (typeof window === "undefined") return { type: "overview" };
    if (window.location.search.includes("e2e=1")) return { type: "overview" };
    try {
      const stored = localStorage.getItem("pi-workbench-view");
      if (
        stored === "overview" ||
        stored === "progress" ||
        stored === "outputs" ||
        stored === "files" ||
        stored === "context" ||
        stored === "browser"
      ) {
        return { type: stored };
      }
      const legacy = localStorage.getItem("pi-right-panel");
      if (legacy === "files" || localStorage.getItem("pi-show-files") === "1") {
        return { type: "files" };
      }
      if (legacy === "browser") return { type: "browser" };
    } catch {
      /* noop */
    }
    return { type: "overview" };
  };
  const initialWorkbenchOpen = (): boolean => {
    if (typeof window === "undefined") return false;
    if (window.location.search.includes("e2e=1")) return false;
    try {
      const stored = localStorage.getItem("pi-workbench-open");
      if (stored === "1") return true;
      if (stored === "0") return false;
      const legacy = localStorage.getItem("pi-right-panel");
      return (
        legacy === "files" ||
        legacy === "browser" ||
        localStorage.getItem("pi-show-files") === "1"
      );
    } catch {
      return false;
    }
  };
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>({
    type: "overview",
  });
  const [showSkills, setShowSkills] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [browserOpenRequest, setBrowserOpenRequest] = useState<{
    id: number;
    url: string;
  } | null>(null);

  // sidebar 开合－— 提前声明供右侧面板宽度计算使用
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 右侧 panel 宽度（仅 files/tools 用 inline 形态需要，skills 是 modal）
  const [rightPanelWidth, setRightPanelWidth] = useState(480);
  /** FileBrowser 内部折叠状态:不再影响外层宽度,仅 56px 极窄态特殊处理
   *  (FileBrowser 内部用 flex:1 自适应,外层一直用 rightPanelWidth) */
  const [filesLayout, setFilesLayout] = useState<FilesLayout>({
    treeCollapsed: false,
    viewerHidden: false,
  });
  useEffect(() => {
    queueMicrotask(() => {
      const view = initialWorkbenchView();
      setWorkbenchView(view);
      setWorkbenchOpen(initialWorkbenchOpen());
      try {
        const stored = localStorage.getItem("rightPanelWidth");
        const n = stored ? Number(stored) : NaN;
        if (Number.isFinite(n) && n >= 320) {
          // 注水时就拿当前 viewport / sidebar 状态下的 max 做一次 clamp，
          // 避免“stored 是上次大窗口里拖出的 1100”在小窗口里首帧先
          // 按 1100 画一下、下一帧才被 clamp 压回。
          // 这里重新计算 max，不能用闭包里的 rightPanelMaxWidth（那个
          // 依赖于 viewportWidth state，本函数体是首载时调的）。
          const liveSidebarWidth = 260;
          const liveMax = Math.max(
            320,
            window.innerWidth - liveSidebarWidth - 4 - 360,
          );
          setRightPanelWidth(Math.min(n, liveMax));
        }
      } catch {
        /* noop */
      }
    });
  }, []);
  const [viewportWidth, setViewportWidth] = useState(1440);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 右侧面板宽度上限：减去 sidebar 、splitter 、chat 区最小宽度，
  // 保证拖到左极限时不会越过“中间区最小宽度”。
  // 否则 rightPanelWidth 会被存成一个远大于实际可用空间的值，
  // flex 布局会压回去，但 aside 内部仍按 props.width 排版，
  // 导致“容器被压缩 + 内容变宽”的堆叠错位。
  const SIDEBAR_WIDTH_OPEN = 260; // 同 globals.css 里的 .sidebar-container
  const SIDEBAR_WIDTH_CLOSED = 0;
  const SPLITTER_WIDTH = 4;
  const CHAT_MIN_WIDTH = 360; // 中间 chat 区最小可用宽
  const sidebarWidth = sidebarOpen ? SIDEBAR_WIDTH_OPEN : SIDEBAR_WIDTH_CLOSED;
  const rightPanelMaxWidth = Math.max(
    320,
    viewportWidth - sidebarWidth - SPLITTER_WIDTH - CHAT_MIN_WIDTH,
  );
  /** 两侧都收起时容器收成 56px 窄条,其它情况都用统一 clamp 后的 rightPanelWidth */
  const filesContainerWidth =
    filesLayout.viewerHidden && filesLayout.treeCollapsed
      ? 56
      : Math.min(rightPanelWidth, rightPanelMaxWidth);
  const rightPanelStoredWidth = Math.min(rightPanelWidth, rightPanelMaxWidth);
  useEffect(() => {
    try {
      localStorage.setItem("rightPanelWidth", String(rightPanelStoredWidth));
    } catch {}
  }, [rightPanelStoredWidth]);
  const splitterDragRef = useRef<{ startX: number; startW: number } | null>(
    null
  );
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  // 拖拽时读最新的 max 宽度，避免 onMove 闭包拿到老值
  //（拖动过程中窗口 resize 、sidebar 开合变化都会调整 max）。
  const rightPanelMaxWidthRef = useRef(rightPanelMaxWidth);
  useEffect(() => {
    rightPanelMaxWidthRef.current = rightPanelMaxWidth;
  }, [rightPanelMaxWidth]);
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setRightPanelResizing(true);
    splitterDragRef.current = {
      startX: e.clientX,
      // 关键：startW 不能取 state 里可能被 clamp 过的值，
      // 用当前真实可见宽度（filesContainerWidth）作起点。
      // 拖到极限后反向拖，必须越过起点才会改变宽度，从根本上消除“虚增 dx”。
      startW: filesContainerWidth,
    };
    const onMove = (ev: MouseEvent) => {
      const ref = splitterDragRef.current;
      if (!ref) return;
      const dx = ref.startX - ev.clientX;
      const liveMax = rightPanelMaxWidthRef.current;
      const next = Math.min(liveMax, Math.max(320, ref.startW + dx));
      // 如果 clamp 后与当前 state 相同，不触发 re-render。
      setRightPanelWidth((prev) => (prev === next ? prev : next));
    };
    const onUp = () => {
      splitterDragRef.current = null;
      setRightPanelResizing(false);
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
  const {
    showAuth,
    authInitialProvider,
    showCompanyClaude3PConfig,
    showModelsConfig,
    showProviderSetup,
    showSystemPrompt,
    systemPromptText,
    showCwdPicker,
    showFilePicker,
    showBranches,
    setShowAuth,
    openAuth,
    closeAuth,
    setShowCompanyClaude3PConfig,
    setShowModelsConfig,
    setShowProviderSetup,
    setShowSystemPrompt,
    setShowCwdPicker,
    setShowFilePicker,
    setShowBranches,
    setSystemPromptText,
    closeSystemPrompt,
  } = useChatModalsState();
  const [providerSetupChild, setProviderSetupChild] = useState<
    "auth" | "company3p" | "models" | null
  >(null);
  /** RFC-2 Phase A3：Budget 命中后由 useBudgetEnforcer 设置；非 null 时弹 BudgetExceededModal */
  const [budgetPausedTrigger, setBudgetPausedTrigger] =
    useState<BudgetTrigger | null>(null);
  // sseStatus 已挪到 RunnerState(每个会话独立的 SSE 状态)。
  // forksCollapsed / toggleForks 已挪到 useForkable hook（C1）
  /** 当前打开 ⋯ 菜单的 session id；renaming 时存 inline edit 状态 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showWorkflowHistory, setShowWorkflowHistory] = useState(false);
  const [workflowHistory, setWorkflowHistory] = useState<WorkflowResumeSnapshot[]>(
    []
  );
  const [workflowHistoryAgentId, setWorkflowHistoryAgentId] = useState<
    string | null
  >(null);
  const [workflowHistoryLoading, setWorkflowHistoryLoading] = useState(false);
  const [workflowDebugBundle, setWorkflowDebugBundle] =
    useState<WorkflowDebugBundle | null>(null);
  const [workflowDebugLoading, setWorkflowDebugLoading] = useState(false);
  const [workflowDebugError, setWorkflowDebugError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const persistWorkbench = useCallback((open: boolean, view: WorkbenchView) => {
    try {
      localStorage.setItem("pi-workbench-open", open ? "1" : "0");
      localStorage.setItem("pi-workbench-view", view.type);
    } catch {
      /* noop */
    }
  }, []);
  const openWorkbench = useCallback((view: WorkbenchView) => {
    setWorkbenchView(view);
    setWorkbenchOpen(true);
    persistWorkbench(true, view);
    if (view.type === "browser" && view.url) {
      setBrowserOpenRequest({ id: Date.now(), url: view.url });
    }
  }, [persistWorkbench]);
  const selectSessionAndCloseWorkbench = useCallback(
    (id: string) => {
      // F2：原子切换。如果这个 session 在 sessions 里有个能认出的 path，并且
      // runnersRef 里已有该 path 对应的 runner，就同步 switchTo + setSelectedId，
      // 避免 effect 异步窗口期间 send 拿到新 selectedId 但 activeKey 还是 draft。
      const target = sessions.find((s) => s.id === id);
      if (target && runnersRef.current.has(target.path)) {
        switchTo(target.path);
      }
      setSelectedId(id);
      setWorkbenchOpen(false);
      persistWorkbench(false, { type: "overview" });
    },
    [persistWorkbench, runnersRef, sessions, setSelectedId, switchTo]
  );
  const toggleWorkbench = useCallback(() => {
    setWorkbenchOpen((prev) => {
      const next = !prev;
      if (next) {
        persistWorkbench(true, workbenchView);
      } else {
        persistWorkbench(false, workbenchView);
      }
      return next;
    });
  }, [persistWorkbench, workbenchView]);
  const toggleSkills = () => setShowSkills((prev) => !prev);
  const toggleTools = () => {
    setShowTools((prev) => {
      const next = !prev;
      if (prev && agentId) void refreshToolsCount(agentId);
      return next;
    });
  };

  // 任何 previewStore 触发(html/url/image)时,确保右侧 Workbench 进入 Files。
  useEffect(() => {
    return previewStore.onOpen(() => {
      openWorkbench({ type: "files" });
    });
  }, [openWorkbench]);

  // Electron 桥
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const electronApi = useMemo(
    () => (appInfo ? getElectronApi() : null),
    [appInfo]
  );
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateNoticeHidden, setUpdateNoticeHidden] = useState(false);
  const [latestNoticeHidden, setLatestNoticeHidden] = useState(true);
  const [openCommandMenuRequest, setOpenCommandMenuRequest] = useState(0);
  useEffect(() => {
    const api = getElectronApi();
    if (!api) return;
    void api
      .getAppInfo()
      .then(setAppInfo)
      .catch((e) => console.warn("getAppInfo failed", e));
  }, []);
  useEffect(() => {
    if (!electronApi?.updater) return;
    let cancelled = false;
    void electronApi.updater
      .getState()
      .then((state) => {
        if (!cancelled) setUpdateState(state);
      })
      .catch((e) => console.warn("updater:getState failed", e));
    const unsub = electronApi.updater.onState((state) => {
      setUpdateState(state);
      if (state.status === "available") setUpdateNoticeHidden(false);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [electronApi]);
  useEffect(() => {
    if (updateState?.status !== "available" || updateNoticeHidden) return;
    const id = window.setTimeout(() => setUpdateNoticeHidden(true), 8000);
    return () => window.clearTimeout(id);
  }, [updateNoticeHidden, updateState?.status, updateState?.latestVersion]);
  useEffect(() => {
    if (updateState?.status !== "not-available" || latestNoticeHidden) return;
    const id = window.setTimeout(() => setLatestNoticeHidden(true), 5000);
    return () => window.clearTimeout(id);
  }, [latestNoticeHidden, updateState?.status, updateState?.checkedAt]);
  const checkForUpdates = useCallback(() => {
    if (!electronApi?.updater) return;
    setUpdateNoticeHidden(false);
    setLatestNoticeHidden(true);
    void electronApi.updater
      .check({ manual: true })
      .then((state) => {
        setUpdateState(state);
        if (state.status === "not-available") {
          setLatestNoticeHidden(false);
        }
      })
      .catch((e) =>
        setUpdateState((prev) => ({
          ...(prev ?? {
            currentVersion: appInfo?.version ?? "0.0.0",
            autoCheckEnabled: true,
          }),
          status: "error",
          error: String(e),
        }))
      );
  }, [appInfo?.version, electronApi]);
  const openUpdateDownload = useCallback(() => {
    if (!electronApi?.updater) return;
    void electronApi.updater
      .openDownload()
      .catch((e) => setError(userFacingMessage(e, { context: "settings" })));
  }, [electronApi]);
  const viewUpdateDetails = useCallback(() => {
    setUpdateNoticeHidden(true);
    setOpenCommandMenuRequest((value) => value + 1);
  }, []);
  const skipUpdateVersion = useCallback(() => {
    setUpdateNoticeHidden(true);
    if (!electronApi?.updater) return;
    void electronApi.updater
      .skipVersion(updateState?.latestVersion ?? undefined)
      .then(setUpdateState)
      .catch(() => {});
  }, [electronApi, updateState?.latestVersion]);

  // currentSessionFile 已挪到 RunnerState.sessionFile(下方解构提供同名别名)。

  // 点外面关闭 session ⋯ 菜单
  useEffect(() => {
    if (!menuFor) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-session-menu]")) return;
      if (t && t.closest("[data-floating-layer]")) return;
      setMenuFor(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuFor]);

  // session 菜单操作：业务由 useSessions 承担，本层 wrapper 仅负责善后 UI 状态
  // （renamingFor / menuFor / pendingDeleteId 是 sidebar 交互的临时态，
  // 不属于 session 本身的生命周期，所以留在 ChatApp 内）。
  const submitRename = useCallback(
    async (id: string, name: string) => {
      try {
        await submitRenameImpl(id, name);
      } finally {
        setRenamingFor(null);
        setMenuFor(null);
      }
    },
    [submitRenameImpl]
  );

  const executeDeleteSession = useCallback(
    async (id: string) => {
      try {
        await executeDeleteSessionImpl(id);
      } finally {
        setMenuFor(null);
        setPendingDeleteId(null);
      }
    },
    [executeDeleteSessionImpl]
  );

  /** 触发 inline 删除确认（替代原生 confirm） */
  const requestDeleteSession = useCallback((id: string) => {
    setMenuFor(null);
    setPendingDeleteId(id);
  }, []);

  const handleExportSession = useCallback((id: string) => {
    // 直接走浏览器下载
    const a = document.createElement("a");
    a.href = `/api/sessions/${id}/export`;
    a.download = `pi-session-${id}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setMenuFor(null);
  }, []);

  // RFC-3 A4：session 置顶/取消置顶。
  // 实现：PATCH meta → refresh 列表（meta 在 A2 已聚合到列表 response）。
  const { patch: patchSessionMeta } = useSessionMeta({ onError: setError });
  const toggleSessionPin = useCallback(
    async (id: string, nextPinned: boolean) => {
      const res = await patchSessionMeta(id, { pinned: nextPinned });
      if (res) {
        await refreshSessions();
      }
    },
    [patchSessionMeta, refreshSessions]
  );

  // RFC-3 Phase B / F2：Sidebar 全文检索。
  // useSearch 自带 query / status / results state；isActive 决定 SidebarSearch 是否替换普通 sessions 列表。
  const searchHook = useSearch();
  const sessionLookup = useMemo(
    () =>
      new Map(
        sessions.map((s) => [
          s.id,
          { cwd: s.cwd, title: s.meta?.title ?? s.name ?? null },
        ])
      ),
    [sessions]
  );

  // ===== 当前活跃 runner 的解构(P1-4)=====
  // 所有下游 callbacks/render 通过这些同名变量读取,行为与原 useState 完全一致。
  const {
    chatState,
    contextLoading,
    forkableUserMessages,
    forkingIndex,
    forkText,
    forkBusy,
    agentId,
    agentSessionId,
    sessionFile: currentSessionFile,
    pendingImages,
    pendingFiles,
    composerMode,
    streaming,
    agentPhase,
    compacting,
    compactError,
    retryInfo,
    stats,
    toolsCount,
    goal,
    progress,
    thinkingLevel,
    availableThinkingLevels,
    supportsThinking,
    sseStatus,
  } = activeSnapshot;
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions]
  );
  const runtimeIdentity = useMemo(
    () =>
      resolveRuntimeIdentity({
        selectedSessionId: selectedSession?.id ?? agentSessionId ?? null,
        selectedSessionPath:
          selectedSession?.path ?? currentSessionFile ?? activeKey,
        cwd,
        activeRunnerKey: activeKey,
        liveAgentId: agentId,
      }),
    [
      activeKey,
      agentId,
      agentSessionId,
      currentSessionFile,
      cwd,
      selectedSession?.id,
      selectedSession?.path,
    ]
  );

  // Composer should only enter Steer/Follow-up/Stop mode while the agent is
  // actually streaming. Progress steps may be left pending by older tool traces
  // or restored history; those should not make the input look like it is still
  // outputting after the assistant has already finished.
  const abortable = streaming;

  const openUrlInBrowserPanel = useCallback(
    (url: string) => {
      openWorkbench({ type: "browser", url });
    },
    [openWorkbench]
  );

  // ===== Setter wrappers(同名,所有调用点不动)=====
  // 通用 helper:把 React 风格的 setter (value | (prev) => value) 路由到 updateActive。
  // 为每个字段写一个 useCallback,保持稳定的函数 identity,避免下游误触发。
  type Updater<T> = T | ((prev: T) => T);
  const resolve = useCallback(
    <T,>(prev: T, v: Updater<T>): T =>
      typeof v === "function" ? (v as (p: T) => T)(prev) : v,
    []
  );

  // setChatState 在 F6 后不再使用。取而代之是在 capture ownerKey 后调 updateRunner，
  // 避免 A 请求返回后写到 当前 active 的 B。保留函数定义会被 lint 报 unused，
  // 直接刪。
  const setForkableUserMessages = useCallback(
    (v: Updater<ForkableUserMessage[]>) =>
      updateActive((s) => ({
        forkableUserMessages: resolve(s.forkableUserMessages, v),
      })),
    [resolve, updateActive]
  );
  const setForkingIndex = useCallback(
    (v: Updater<number | null>) =>
      updateActive((s) => ({ forkingIndex: resolve(s.forkingIndex, v) })),
    [resolve, updateActive]
  );
  const setForkText = useCallback(
    (v: Updater<string>) =>
      updateActive((s) => ({ forkText: resolve(s.forkText, v) })),
    [resolve, updateActive]
  );
  // setForkBusy 已下沉到 useForkable hook（C1：fork 流程内 updateRunner 直接写）
  // P1-E: input 不再写入 RunnerState，而是走全局 store。
  //   - setInput：只动 store，不再 setActiveSnapshot 、不再重建 RunnerState。
  //   - getCurrentInput：交互时点快照读（send/steer/followUp 等）。
  //   - Composer 作为叶子组件订阅 activeKey 对应的 input slot。
  const setInput = useCallback(
    (v: Updater<string>) => {
      const key = activeKeyRef.current;
      if (typeof v === "function") {
        storeUpdateInput(key, (prev) => (v as (p: string) => string)(prev));
      } else {
        storeSetInput(key, v);
      }
    },
    [activeKeyRef]
  );
  const getCurrentInput = useCallback(
    () => getStoreInput(activeKeyRef.current),
    [activeKeyRef]
  );
  const setPendingImages = useCallback(
    (v: Updater<ImageContentLite[]>) =>
      updateActive((s) => ({ pendingImages: resolve(s.pendingImages, v) })),
    [resolve, updateActive]
  );
  const setPendingFiles = useCallback(
    (v: Updater<PendingAttachment[]>) =>
      updateActive((s) => ({ pendingFiles: resolve(s.pendingFiles, v) })),
    [resolve, updateActive]
  );
  const setComposerMode = useCallback(
    (
      v: Updater<
        import("@/lib/session-runner").RunnerState["composerMode"]
      >
    ) =>
      updateActive((s) => ({ composerMode: resolve(s.composerMode, v) })),
    [resolve, updateActive]
  );
  const setCompactError = useCallback(
    (v: Updater<string | null>) =>
      updateActive((s) => ({ compactError: resolve(s.compactError, v) })),
    [resolve, updateActive]
  );

  // ===== Composer 附件子模块（RFC-1 阶段 B2-b，已抽到 useComposerAttachments） =====
  // 图片/文件拖入、粘贴、移除：依赖 setPendingImages/setPendingFiles，必须在 setter wrappers 之后
  const {
    addImageFiles,
    removePendingImage,
    onDropFiles,
    removePendingFile,
    addPathAttachment,
  } = useComposerAttachments({
    setPendingImages,
    setPendingFiles,
    setError,
  });

  // Phase C：服务端检查引用文件是否存在，驱动 FileChip warning tone。
  const { missingPaths: missingFilePaths } = useMissingFileCheck(pendingFiles);

  // F1：重复点同一 mention 时让原 chip flash 300ms。
  const [flashedFilePath, setFlashedFilePath] = useState<string | null>(null);
  const flashFilePathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const flashFilePath = useCallback((p: string) => {
    setFlashedFilePath(p);
    if (flashFilePathTimerRef.current) clearTimeout(flashFilePathTimerRef.current);
    flashFilePathTimerRef.current = setTimeout(() => {
      setFlashedFilePath(null);
      flashFilePathTimerRef.current = null;
    }, 300);
  }, []);
  useEffect(
    () => () => {
      if (flashFilePathTimerRef.current) clearTimeout(flashFilePathTimerRef.current);
    },
    []
  );

  const {
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useDragDrop(onDropFiles);

  const onPasteTextarea = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imgs = extractImagesFromClipboard(e);
      if (imgs.length > 0) {
        e.preventDefault();
        void addImageFiles(imgs);
        return;
      }
      // 结构化 Composer Phase B：粘贴含 @/abs/path 的文本 → 提为 mention。
      // 仅当粘贴的文本返回了 “路径芅取” 时才 preventDefault，避免污染普通复粘贴体验。
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      const { paths, remainingText } =
        extractMentionsFromPaste(text);
      if (paths.length === 0) return;
      e.preventDefault();
      // 多个路径递进 pendingFiles（addPathAttachment 本身会 dedupe）
      for (const p of paths) {
        const r = addPathAttachment(p);
        if (r === "duplicate") flashFilePath(p);
      }
      // 剩余文本插入到 caret 处；Composer 底层使用 store-based input，
      // 这里走 setInput(prev => before + remaining + after)。caret 位置从 textarea
      // currentTarget 取。
      if (remainingText) {
        const ta = e.currentTarget;
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? start;
        setInput((cur) => {
          const before = cur.slice(0, start);
          const after = cur.slice(end);
          return `${before}${remainingText}${after}`;
        });
      }
    },
    [addImageFiles, addPathAttachment, flashFilePath, setInput]
  );

  // compactError 3 秒自动消失（原本贴在 useState 旁,现在挪到 wrapper 之后）
  useEffect(() => {
    if (!compactError) return;
    const id = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(id);
  }, [compactError, setCompactError]);

  // RFC-2 Phase A：会话级 Budget MVP
  // 输入 activeSnapshot + agentId，输出当前预算/消耗/状态（duration 维度内部按 1s tick 刷新）
  const {
    budget,
    hasOverride: budgetHasOverride,
    status: budgetStatus,
    spent: budgetSpent,
    setSessionOverride,
  } = useBudget({ activeSnapshot, agentId });

  // RFC-2 Phase B3：工具审批 user actions（Allow / Deny POST）
  // approve/deny 直接走 fetch，server 端 resolve 后 SSE 推 approval_resolved 自然更新气泡。
  const {
    approve: approveCall,
    deny: denyCall,
    loadPending: loadPendingApprovals,
  } = useApprovals({
    agentId,
    onError: setError,
    // 问题 2：POST 成功后立即兑底刷一次 sidebar（避免 SSE 丢包时 “需确认” 不消）。
    refreshSessions,
  });

  // RFC-5：主动追问 / 推荐下一步 user actions。
  const {
    choose: chooseClarification,
    respond: respondClarification,
    loadPending: loadPendingClarifications,
  } = useClarifications({
    agentId,
    onError: setError,
    refreshSessions,
  });

  // ===== 宠物状态推送（hook 化，见 app/hooks/usePetPusher.ts）=====
  usePetPusher({
    runnersRef,
    sessions,
    selectedId,
    lastSeenMapRef,
    lastSeenMap,
    activeSnapshot,
    activeAgentId: agentId,
    budgetStatus,
    budgetPausedTrigger,
  });

  // 宠物窗口发来的 "切到指定 session" 请求
  useEffect(() => {
    const api = getElectronApi();
    if (!api?.pet?.onSwitchSession) return;
    const unsub = api.pet.onSwitchSession((sessionId) => {
      const target = sessions.find((s) => s.id === sessionId);
      if (target) setSelectedId(sessionId);
    });
    return unsub;
  }, [sessions, setSelectedId]);

  const messageRenderState = useMemo(() => {
    const shouldAttachForkIds = forkableUserMessages.length > 0;
    const renderedMessages: ChatMessage[] = shouldAttachForkIds ? [] : chatState.messages;
    let forkCursor = 0;
    let visibleMessageCount = 0;
    let userMessageCount = 0;
    let lastUserVisibleIndex = -1;

    for (const m of chatState.messages) {
      let next = m;
      if (shouldAttachForkIds && m.role === "user" && forkCursor < forkableUserMessages.length) {
        next = { ...m, entryId: forkableUserMessages[forkCursor].entryId };
        forkCursor++;
      }
      if (shouldAttachForkIds) renderedMessages.push(next);

      if (m.role === "user" || m.role === "assistant") {
        if (m.role === "user") {
          userMessageCount++;
          lastUserVisibleIndex = visibleMessageCount;
        }
        visibleMessageCount++;
      }
    }

    return {
      messages: renderedMessages,
      visibleMessageCount,
      userMessageCount,
      lastUserVisibleIndex,
    };
  }, [chatState.messages, forkableUserMessages]);

  const messages = messageRenderState.messages;
  const visibleMessageCount = messageRenderState.visibleMessageCount;
  const messageRefs = useMessageRefs(visibleMessageCount);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  // 用户是否"贴底"：贴底时新内容自动跟随，往上滚一旦离开底部 64px 就停止跟随。
  const stickToBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  // “问题 1”修复：用户刚刚手动滚动后的时间窗内（400ms）不允许自动贴底。
  // 避免 approval/clarification part 追加、progress.updatedAt 跳动、偶尔的
  // streaming token delta 在用户试图往上看时调 scrollTop 抢回底。
  const lastUserScrollAtRef = useRef(0);
  const USER_SCROLL_LOCK_MS = 400;
  // send 后锚定到刚发的 user 消息:记 send 时的 user 消息总数,
  // 等新 user 消息从 SSE 回来后扫到对应那条,把它滚到屏顶。
  // null = 不锚定(普通贴底跟随);number = 期望"这条 user 一出现就锚"
  const pendingPinUserCountRef = useRef<number | null>(null);
  // 锚定阶段:仅此期间渲染 60vh 底部占位,让最后一条 user 能被 scroll-to-top
  // 一旦锚定完成或被取消,移除占位,避免列表底部一大片空白可滚。
  const [pinSpacer, setPinSpacer] = useState(false);
  const [scrollToBottomState, setScrollToBottomState] = useState({
    key: "",
    visible: false,
  });
  const showScrollToBottom =
    scrollToBottomState.key === activeKey && scrollToBottomState.visible;

  // 类型参数：“force” 不受用户滚动锁限制。点“贴底”按钮 / send 后的主动贴底会传 force。
  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = "auto", opts?: { force?: boolean }) => {
      // “问题 1”：用户刚手动滚不久——以用户为准，跳过本次贴底。
      if (
        !opts?.force &&
        Date.now() - lastUserScrollAtRef.current < USER_SCROLL_LOCK_MS
      ) {
        return;
      }
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const el = messagesScrollRef.current;
        if (!el) return;
        if (behavior === "smooth") {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        } else {
          // Streaming token updates must be an immediate snap-to-bottom. Smooth
          // animations overlap with frequent content growth and make the scrollbar
          // visibly bounce.
          el.scrollTop = el.scrollHeight;
        }
        stickToBottomRef.current = true;
        setScrollToBottomState((state) =>
          state.visible ? { ...state, visible: false } : state,
        );
      });
    },
    []
  );

  function handleMessagesScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceToBottom < 64;
    // “问题 1”：记下一次用户手动滚动时间（包括轮子 / 拖动条 / 键盘翻页）。
    // scrollMessagesToBottom 不 force 时会看这个时间戏。这里不完全区分 “用户” 和
    // “代码主动 scrollTo”，scrollMessagesToBottom 走 force=true，scrollTo 后的
    // 事件跳不起作用 —— 反正当时 stickToBottomRef 已被设为 true，lock 对后续
    // streaming 也不会阫错人。
    lastUserScrollAtRef.current = Date.now();
    stickToBottomRef.current = atBottom;
    setScrollToBottomState((state) =>
      state.key === activeKey && state.visible === !atBottom
        ? state
        : { key: activeKey, visible: !atBottom },
    );
    // 用户主动滚动 = 取消锚定意图(占位也跟着移除,见 effect)
    if (pendingPinUserCountRef.current !== null) {
      pendingPinUserCountRef.current = null;
      setPinSpacer(false);
    }
  }

  // “问题 1”：贴底跟随只看“真正需要跟随”的信号。
  // streamSignature = 消息总数 + 末尾消息的 text/thinking 总长度。
  // 这样：approval/clarification/subagent_batch 等 part 追加不会调发贴底。
  const streamSignature = useMemo(() => {
    const list = chatState.messages;
    const last = list[list.length - 1];
    let tail = 0;
    if (last?.parts) {
      for (const p of last.parts) {
        if (p.kind === "text") tail += p.text.length;
        else if (p.kind === "thinking") tail += p.text.length;
      }
    } else if (last) {
      tail = (last.text?.length ?? 0) + (last.thinking?.length ?? 0);
    }
    return `${list.length}|${tail}`;
  }, [chatState.messages]);

  // 锁定用户消息锁顶（send 后的一次性言领则什，仅起始完上锁期内动作）。
  // 这条 effect 不走“贴底”逻辑，只负责“锁到刚发的 user”，不受 lock 控制。
  useEffect(() => {
    if (!streaming && pendingPinUserCountRef.current !== null) {
      pendingPinUserCountRef.current = null;
      queueMicrotask(() => setPinSpacer(false));
    }
    const targetCount = pendingPinUserCountRef.current;
    if (targetCount === null) return;
    if (
      messageRenderState.userMessageCount >= targetCount &&
      messageRenderState.lastUserVisibleIndex >= 0
    ) {
      const el = messageRefs.current?.[messageRenderState.lastUserVisibleIndex];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        pendingPinUserCountRef.current = null;
        queueMicrotask(() => setPinSpacer(false));
      }
    }
  }, [
    messageRenderState.userMessageCount,
    messageRenderState.lastUserVisibleIndex,
    streaming,
    messageRefs,
  ]);

  // 贴底跟随只看 streamSignature：approval / clarification / subagent_batch / progress.updatedAt
  // 都不会作为 deps 在这里出现，从而不会抢回底。
  useEffect(() => {
    if (pendingPinUserCountRef.current !== null) return; // 锁定中 — 交给上一个 effect
    if (!stickToBottomRef.current) return;
    scrollMessagesToBottom();
  }, [streamSignature, scrollMessagesToBottom]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  // progress.updatedAt 也只在“本来在底”时才跟随。各种状态类事件（优先级下调），
  // 同样会被 user-scroll lock 守住。
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollMessagesToBottom();
  }, [progress?.updatedAt, scrollMessagesToBottom]);

  // 选已有 session(P1-8):
  //  - runnersRef 已有该 session 的 runner → 直接 switchTo(不动 SSE,后台流式继续)
  //  - 没有 → 冷启动:emptyRunner + fetch context 填 chatState + switchTo
  //          (不立即 attachSse;用户发送时 send() 会走 create-with-sessionPath 路径)
  useEffect(() => {
    if (!selectedId) return;
    queueMicrotask(() => setError(null));
    const sel = sessions.find((s) => s.id === selectedId);
    if (!sel) return;
    const key: RunnerKey = sel.path;

    if (runnersRef.current.has(key)) {
      // 已有 runner —— 直接切。后台 SSE 继续,切回时累积内容立即可见。
      // P2-I: 进入 transition，让输入框不被列表 reconcile 阻塞。
      startTransition(() => {
        switchTo(key);
      });
      return;
    }

    // 冷启动:建空 runner,先切过去显示空(很快),再异步填 context
    const fresh = emptyRunner();
    fresh.sessionFile = sel.path;
    fresh.contextLoading = true;
    startTransition(() => {
      setRunner(key, fresh);
      switchTo(key);
    });

    // F4：capture ownerKey + sessionId 请求发起时的状态。返回后只在同一 ownerKey
    // 仍然处于 contextLoading=true 且 chatState 未产生 live event 时才填充，
    // 避免覆盖用户发送后 SSE 已写入的实时消息。
    const requestSessionId = selectedId;
    void fetch(`/api/sessions/${requestSessionId}/context`)
      .then((r) => r.json())
      .then((ctx) => {
        if (ctx.error) {
          // 还是在处理 loading？
          const cur = runnersRef.current.get(key);
          if (cur && cur.contextLoading) {
            updateRunner(key, { contextLoading: false, contextError: ctx.error });
          }
          setError(ctx.error);
          return;
        }
        const cur = runnersRef.current.get(key);
        if (!cur) return; // runner 已被淘汰 / 删除
        // 只有仍在 loading 且 chatState 不含实时消息时才覆盖，否则 merge。
        const hasLiveMessages = (cur.chatState?.messages?.length ?? 0) > 0;
        // P2-I: 从后端拉回的整个历史会话可能包含几百条消息；
        // 这一重重渲染量包进低优先级 transition，让输入交互优先保持响应。
        // 后端 context route 会给出 interrupted 信号（检测未配对工具调用
        // 且没 active runtime）。sel.isRunning 只是辅助“实时在跑”的信号。
        const interruptedFlag =
          (ctx as { interrupted?: boolean })?.interrupted === true;
        const restoreToolOptions =
          interruptedFlag || !sel.isRunning
            ? {
                unfinishedToolStatus: "error" as const,
                unfinishedToolResult:
                  "上次运行在工具返回前被中断。可以重新发送或继续任务。",
              }
            : undefined;
        startTransition(() => {
          if (cur.contextLoading && !hasLiveMessages) {
            updateRunner(key, {
              contextLoading: false,
              contextError: null,
              chatState: createInitialState(
                appendRestoredSubagentBatches(
                  ctxToMessages(ctx.messages ?? [], restoreToolOptions),
                  Array.isArray(ctx.subagentBatches)
                    ? (ctx.subagentBatches as SubagentBatch[])
                    : undefined
                )
              ),
              ...(Array.isArray(ctx.forkableUserMessages)
                ? {
                    forkableUserMessages:
                      ctx.forkableUserMessages as ForkableUserMessage[],
                  }
                : {}),
              ...(ctx.progress
                ? { progress: ctx.progress as AgentProgress }
                : {}),
            });
          } else {
            // 已有实时消息——只补 forkable / progress 这种仅供辅助 UI 用途的字段。
            updateRunner(key, {
              contextLoading: false,
              contextError: null,
              ...(Array.isArray(ctx.forkableUserMessages)
                ? {
                    forkableUserMessages:
                      ctx.forkableUserMessages as ForkableUserMessage[],
                  }
                : {}),
              ...(ctx.progress
                ? { progress: ctx.progress as AgentProgress }
                : {}),
            });
          }
        });
      })
      .catch((e) => {
        const message = userFacingMessage(e, { context: "settings" });
        const cur = runnersRef.current.get(key);
        if (cur && cur.contextLoading) {
          updateRunner(key, { contextLoading: false, contextError: message });
        }
        setError(message);
      });
     
  }, [runnersRef, selectedId, sessions, setRunner, switchTo, updateRunner]);

  // refreshForkList 已挪到 useForkable hook（C1）
  // refreshStats / refreshToolsCount 写到指定 runner；ownerKey 缺省 = 当前活跃 runner。

  // 拉 token/cost/context window HUD
  const refreshStats = useCallback(
    async (aid: string, ownerKey?: RunnerKey) => {
      try {
        const r = await fetch(`/api/agent/${aid}?action=stats`);
        if (!r.ok) return;
        const d = (await r.json()) as {
          stats?: {
            tokens?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              total?: number;
            };
            cost?: number;
          };
          contextUsage?: {
            tokens?: number | null;
            percentage?: number | null;
          } | null;
          contextWindow?: number | null;
        };
        const t = d.stats?.tokens ?? {};
        updateRunner(ownerKey ?? activeKeyRef.current, {
          stats: {
            input: t.input ?? 0,
            output: t.output ?? 0,
            cacheRead: t.cacheRead ?? 0,
            total: t.total ?? 0,
            cost: d.stats?.cost ?? 0,
            ctxTokens: d.contextUsage?.tokens ?? null,
            ctxPct: d.contextUsage?.percentage ?? null,
            ctxWindow: d.contextWindow ?? null,
          },
        });
      } catch (e) {
        console.warn("refreshStats failed", e);
      }
    },
    [activeKeyRef, updateRunner]
  );

  // 拉工具启用计数（Tools pill 用）
  const refreshToolsCount = useCallback(
    async (aid: string, ownerKey?: RunnerKey) => {
      try {
        const r = await fetch(`/api/agent/${aid}?action=get_tools`);
        if (!r.ok) return;
        const d = (await r.json()) as {
          tools?: Array<unknown>;
          active?: string[];
        };
        updateRunner(ownerKey ?? activeKeyRef.current, {
          toolsCount: {
            active: Array.isArray(d.active) ? d.active.length : 0,
            total: Array.isArray(d.tools) ? d.tools.length : 0,
          },
        });
      } catch (e) {
        console.warn("refreshToolsCount failed", e);
      }
    },
    [activeKeyRef, updateRunner]
  );

  // 切完分支后从 session context 重建 chat state。
  // F6：capture ownerKey + sessionId，返回时要求 ownerKey 仍是 activeKey
  // 且该 runner 的 sessionFile / agentId 仍与请求发起时一致，避免 A 请求结果落到 B。
  const reloadFromCurrentSession = useCallback(async () => {
    const sid = agentSessionId ?? selectedId;
    if (!sid) return;
    const ownerKeyAtStart = activeKeyRef.current;
    const ownerSnapshot = runnersRef.current.get(ownerKeyAtStart);
    const ownerSessionFile = ownerSnapshot?.sessionFile ?? null;
    const ownerAgentId = ownerSnapshot?.agentId ?? null;
    try {
      const r = await fetch(`/api/sessions/${sid}/context`);
      const ctx = await r.json();
      if (ctx.error) {
        setError(ctx.error);
        return;
      }
      const stillSameOwner = (): boolean => {
        if (activeKeyRef.current !== ownerKeyAtStart) return false;
        const cur = runnersRef.current.get(ownerKeyAtStart);
        if (!cur) return false;
        if (cur.sessionFile !== ownerSessionFile) return false;
        if (cur.agentId !== ownerAgentId) return false;
        return true;
      };
      if (!stillSameOwner()) {
        return;
      }
      // 定向写 ownerKey。不走 setChatState（它是 update active sugar）。
      const interruptedFlag =
        (ctx as { interrupted?: boolean })?.interrupted === true;
      const restoreToolOptions =
        interruptedFlag || !selectedSession?.isRunning
          ? {
              unfinishedToolStatus: "error" as const,
              unfinishedToolResult:
                "上次运行在工具返回前被中断。可以重新发送或继续任务。",
            }
          : undefined;
      updateRunner(ownerKeyAtStart, {
        chatState: createInitialState(
          appendRestoredSubagentBatches(
            ctxToMessages(ctx.messages ?? [], restoreToolOptions),
            Array.isArray(ctx.subagentBatches)
              ? (ctx.subagentBatches as SubagentBatch[])
              : undefined
          )
        ),
        ...(Array.isArray(ctx.forkableUserMessages)
          ? {
              forkableUserMessages:
                ctx.forkableUserMessages as ForkableUserMessage[],
            }
          : {}),
      });
      if (ownerAgentId) {
        void refreshStats(ownerAgentId, ownerKeyAtStart);
        void refreshToolsCount(ownerAgentId, ownerKeyAtStart);
      }
    } catch (e) {
      setError(userFacingMessage(e));
    }
  }, [
    activeKeyRef,
    agentSessionId,
    refreshStats,
    refreshToolsCount,
    runnersRef,
    selectedSession?.isRunning,
    selectedId,
    updateRunner,
  ]);

  // 把 handleAgentEvent 绑到 ref，供 useSseManager 的 onEvent 回调使用。
  // handleAgentEvent 是函数声明（hoisted），每次 render 重建；通过 ref 转发避免
  // useSseManager 内部回调闭包捕获旧引用。
  useEffect(() => {
    handleAgentEventRef.current = handleAgentEvent;
    return () => {
      handleAgentEventRef.current = null;
    };
    // handleAgentEvent 是函数声明，每次 render 都是新引用，需每次同步到 ref
  });

  // 宠物窗口发来的 "重连指定 session SSE" 请求（lost 态点击重连）。
  // 必须放在 attachSseFor 声明之后，避免 TDZ（const useCallback 在初始化前不可用）。
  // 流程：sessionId → SessionInfoLite.path 作 RunnerKey → runnersRef 取 agentId
  // attachSseFor 内部会先 close 旧 ES（如有）再 new 一个，无需手动清理
  useEffect(() => {
    const api = getElectronApi();
    if (!api?.pet?.onReconnectSession) return;
    const unsub = api.pet.onReconnectSession((sessionId) => {
      const sess = sessions.find((s) => s.id === sessionId);
      if (!sess) {
        console.warn("[pet] reconnect requested for unknown session", sessionId);
        return;
      }
      const key: RunnerKey = sess.path;
      const runner = runnersRef.current.get(key);
      const aid = runner?.agentId;
      if (!aid) {
        console.warn(
          "[pet] reconnect requested but no agentId for session",
          sessionId
        );
        return;
      }
      console.log("[pet] reconnecting SSE for", sessionId, "agentId=", aid);
      attachSseFor(key, aid);
    });
    return unsub;
  }, [activeKeyRef, attachSseFor, runnersRef, sessions]);

  const reconnectActiveSession = useCallback(() => {
    if (!agentId) return;
    const key = activeKeyRef.current;
    updateRunner(key, { sseStatus: "idle" });
    attachSseFor(key, agentId);
  }, [agentId, activeKeyRef, updateRunner, attachSseFor]);

  /**
   * +New chat:
   * 1) 先确保 draft runner 存在(初始化已经建过,做兜底)
   * 2) 切到 draft —— 用户切走再切回时输入框/状态都还在
   * 3) 不预创建后端 agent/session。真正的 session 文件在第一次发送时创建，
   *    避免点击 New chat 产生空 session 或 orphan agent。
   */
  const startNewSession = useCallback(() => {
    setError(null);
    // 兜底:draft 槽如果被异常清掉了,重建一个
    if (!runnersRef.current.has(DRAFT_KEY)) {
      setRunner(DRAFT_KEY, emptyRunner());
    }
    setWorkbenchOpen(false);
    persistWorkbench(false, { type: "overview" });
    setSelectedId(null);
    switchTo(DRAFT_KEY);
    // draft 已经有上一次留下的 agent? 关掉它再起新的 —— +New chat 语义就是"重置"
    closeSseFor(DRAFT_KEY);
    setRunner(DRAFT_KEY, emptyRunner());
    storeSetInput(DRAFT_KEY, "");
    // 重新 switchTo 让 useRunners 把新的 empty snapshot 同步给 React state
    switchTo(DRAFT_KEY);
  }, [
    switchTo,
    setRunner,
    setSelectedId,
    runnersRef,
    closeSseFor,
    persistWorkbench,
  ]);

  // ===== SSE agent 事件分发器（RFC-1 阶段 A3，已抽到 useAgentEvents） =====
  // 上游：useSseManager.onEvent → handleAgentEventRef.current（见 hook 区） → 本 handleAgentEvent
  // 下游：updateRunner（写 runner）+ 4 个全局副作用回调
  //
  // RFC-2 Phase B4：注入 isCollabEnabled + autoApprove —— 当用户关掉总开关时，
  // 前端绕过气泡 UI 自动 POST allow。loadCollabSettings 每次 approval_request
  // 都重读 localStorage，让用户改了 Settings 立即生效（不依赖 React state）。
  const {
    handleAgentEvent,
    restorePendingApprovals,
    restorePendingClarifications,
  } = useAgentEvents({
    updateRunner,
    playDoneSound,
    refreshSessions,
    refreshForkList: (aid, key) => refreshForkListRef.current?.(aid, key),
    refreshStats,
    isCollabEnabled: () => loadCollabSettings().enabled,
    onBrowserState: (_snapshot, _aid, ownerKey) => {
      if (ownerKey !== activeKey) return;
      // 右侧 Workbench 不因浏览器状态自动弹开；已打开时 Overview/Browser 摘要自然更新。
    },
    autoApprove: (aid, toolCallId) => {
      // 注意：autoApprove 用的是 SSE 携带的 aid（可能 ≠ activeKey），
      // 直接 fetch 而非用 approveCall（后者绑定 activeKey）。
      void fetch(`/api/agent/${aid}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId, decision: "allow" }),
      }).catch((e) =>
        setError(userFacingMessage(e))
      );
    },
  });

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const aidAtStart = agentId;
    // C3：恢复时不依赖“当前的 activeKey”。按 request.agentId 反查当前
    // runnersRef 中 agentId 相同的 runnerKey 定向写。找不到则跳过这条
    // （说明该 agent 在 UI 上还没 hydrated runner）。
    const findOwnerKeyByAgentId = (
      aid: string
    ): RunnerKey | null => {
      for (const [key, runner] of runnersRef.current) {
        if (runner.agentId === aid) return key;
      }
      return null;
    };
    void loadPendingApprovals().then((requests) => {
      if (cancelled) return;
      for (const request of requests) {
        const target =
          findOwnerKeyByAgentId(request.agentId ?? aidAtStart) ??
          activeKeyRef.current;
        restorePendingApprovals([request], request.agentId ?? aidAtStart, target);
      }
    });
    void loadPendingClarifications().then((requests) => {
      if (cancelled) return;
      for (const request of requests) {
        const target =
          findOwnerKeyByAgentId(request.agentId) ??
          activeKeyRef.current;
        restorePendingClarifications([request], request.agentId, target);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    agentId,
    activeKeyRef,
    runnersRef,
    loadPendingApprovals,
    loadPendingClarifications,
    restorePendingApprovals,
    restorePendingClarifications,
  ]);

  // ===== Turn 控制中枢（RFC-1 阶段 B2-a，已抽到 useChatStream） =====
  // agentAction（通用 POST 通道）+ send / onAbort / onCompact / onAbortCompaction
  // / onSteer / onFollowUp / onChangeThinking
  // 留下：startNewSession / runSlashCommand / onChangeModel（仍在本文件，复用 agentAction）
  const {
    agentAction,
    ensureAgent,
    send,
    onAbort,
    onCompact,
    onAbortCompaction,
    onSteer,
    onFollowUp,
    onChangeThinking,
    startGoal,
    startWorkflow,
  } = useChatStream({
    agentId,
    getInput: getCurrentInput,
    pendingImages,
    pendingFiles,
    currentSessionFile,
    providerId,
    modelId,
    cwd,
    thinkingLevel,
    selectedId,
    sessions,
    messages,
    runnersRef,
    activeKeyRef,
    updateRunner,
    setRunner,
    switchTo,
    attachSseFor,
    closeSseFor,
    setInput,
    setPendingImages,
    setPendingFiles,
    setError,
    setSelectedId,
    setSessions,
    refreshStats,
    refreshToolsCount,
    pendingPinUserCountRef,
    setPinSpacer,
  });

  // RFC-2 Phase A3：Budget 触发后执行 abort/pause
  useBudgetEnforcer({
    agentId,
    streaming,
    runStartedAt: activeSnapshot.runStartedAt,
    status: budgetStatus,
    budget,
    onAbort,
    onPause: (trigger) => {
      // B4：只弹窗。不提前 goal_pause 、也不清 progress。是否 resume 由用户
      // 在弹窗里选。开着的 step 在 abort 里会被 fail-open（failOpenProgressSteps）以
      // 给出中断信号；resume 后 progress 不会被重置，留用户看到上轮状态。
      setBudgetPausedTrigger(trigger);
    },
  });

  // B4 + B5：“提高上限并恢复”。主要动作：
  //   1. 把当前 budget 各启用维度 × 2 写入 session override。
  //   2. 如果该 session 还有 active goal，先照顺序 goal_resume（包括在 enforcer
  //      未主动 pause 场景下也能重启推进循环）。
  //   3. 补一条 progress 节点“预算恢复”，避免右侧面板看不出“刚刚发生过什么”。
  //   4. 发一条“请继续刚才的任务”的 prompt，让 agent 真接下去跑；避免“按了但
  //      实际卡住”的体感。
  const handleRaiseAndContinue = useCallback(
    async (trigger: BudgetTrigger) => {
      if (!agentId) {
        setBudgetPausedTrigger(null);
        return;
      }
      const b = trigger.budget;
      setSessionOverride({
        maxCostUsd:
          b.maxCostUsd && b.maxCostUsd > 0 ? b.maxCostUsd * 2 : b.maxCostUsd,
        maxTurns: b.maxTurns && b.maxTurns > 0 ? b.maxTurns * 2 : b.maxTurns,
        maxDurationSec:
          b.maxDurationSec && b.maxDurationSec > 0
            ? b.maxDurationSec * 2
            : b.maxDurationSec,
        action: b.action,
      });
      setBudgetPausedTrigger(null);
      // B5: 给右侧 progress 补一条“预算恢复”节点，但不清空历史。
      const ownerKey = activeKeyRef.current;
      updateRunner(ownerKey, (state) => {
        if (!state.progress) return {};
        const t = Date.now();
        const note = {
          id: `budget-resume-${t}`,
          title: "预算上调，继续任务",
          status: "completed" as const,
          summary: "提高了预算上限。上一轮起的节点仅作为中断记录保留。",
          completedAt: t,
        };
        const groups = state.progress.groups;
        const lastIdx = groups.length - 1;
        const next = {
          ...state.progress,
          groups:
            lastIdx >= 0
              ? groups.map((g, i) =>
                  i === lastIdx
                    ? {
                        ...g,
                        steps: [...g.steps, note],
                        endedAt: undefined,
                      }
                    : g
                )
              : groups,
          steps:
            lastIdx >= 0
              ? groups[lastIdx].steps.concat(note)
              : state.progress.steps.concat(note),
          updatedAt: t,
        };
        return { progress: next };
      });
      // 如果该 session 有 active goal 且处于 paused（上轮 abort 会可能让 goal
      // 留在 active 但 turn 中断），resume 一下；agent-registry 里 maybeContinueGoal
      // 会接手推进。同时发一条“提高上限，请继续上一轮任务” prompt，作为实际
      // 推进信号。
      try {
        await agentAction(agentId, { type: "goal_resume" }).catch(() => {});
        await agentAction(agentId, {
          type: "prompt",
          text: "预算已上调，请继续刚才被预算限制中断的任务。如果上一轮是调用工具中途被中断，重新起这个工具调用。",
        });
      } catch {
        /* error 已被 agentAction 设置 */
      }
    },
    [
      agentId,
      activeKeyRef,
      agentAction,
      setSessionOverride,
      updateRunner,
    ]
  );

  const rememberComposerInput = useCallback((text: string) => {
    const value = text.trim();
    if (!value) return;
    historyCursorRef.current = null;
    historyDraftRef.current = "";
    setInputHistory((cur) => {
      const withoutDuplicate = cur.filter((item) => item !== value);
      const next = [...withoutDuplicate, value].slice(-INPUT_HISTORY_LIMIT);
      try {
        localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const navigateInputHistory = useCallback(
    (direction: "prev" | "next") => {
      if (inputHistory.length === 0) return false;
      const current = inputRef.current;
      if (!current) return false;

      const atStart =
        current.selectionStart === 0 && current.selectionEnd === 0;
      const atEnd =
        current.selectionStart === current.value.length &&
        current.selectionEnd === current.value.length;
      const browsingHistory = historyCursorRef.current != null;
      const currentValue = current.value;
      if (!browsingHistory) {
        if (direction === "prev" && !atStart && currentValue.trim()) return false;
        if (direction === "next" && !atEnd) return false;
      }

      if (historyCursorRef.current == null) {
        historyDraftRef.current = currentValue;
        historyCursorRef.current = inputHistory.length;
      }

      const nextCursor =
        direction === "prev"
          ? Math.max(0, historyCursorRef.current - 1)
          : Math.min(inputHistory.length, historyCursorRef.current + 1);
      historyCursorRef.current = nextCursor;

      const nextValue =
        nextCursor === inputHistory.length
          ? historyDraftRef.current
          : inputHistory[nextCursor];
      setInput(nextValue);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        const pos = direction === "prev" ? 0 : el.value.length;
        el.setSelectionRange(pos, pos);
      });
      return true;
    },
    [inputHistory, inputRef, setInput]
  );

  // G3：goal pause/resume/clear 都需要从渲染 goal 的 runner 里拿 agentId，
  // 不能只读全局 active。这里点击时快照一下“当前渲染 goal 的 runner = active runner”，
  // 如果异步间隔里被切走，就别动错误 session 的 goal。
  const captureGoalOwner = useCallback((): {
    agentId: string;
    ownerKey: RunnerKey;
  } | null => {
    const ownerKeyAtClick = activeKeyRef.current;
    const snap = runnersRef.current.get(ownerKeyAtClick);
    if (!snap?.agentId || !snap.goal) return null;
    return { agentId: snap.agentId, ownerKey: ownerKeyAtClick };
  }, [activeKeyRef, runnersRef]);

  const runGoalCommand = useCallback(
    async (raw: string): Promise<boolean> => {
      const parsed = parseSlashCommand(raw, ["goal"]);
      if (!parsed) return false;
      const { rest } = parsed;
      if (!rest) {
        setError(goal ? `当前 goal: ${goal.objective}` : "当前没有 active goal");
        setInput("");
        return true;
      }
      // G3：pause/resume/clear 也走 captured owner。
      if (rest === "pause" || rest === "resume" || rest === "clear") {
        const owner = captureGoalOwner();
        if (owner) {
          const t =
            rest === "pause"
              ? "goal_pause"
              : rest === "resume"
              ? "goal_resume"
              : "goal_clear";
          await agentAction(owner.agentId, { type: t }).catch(() => {});
        }
        setInput("");
        return true;
      }
      rememberComposerInput(raw);
      setInput("");
      await startGoal(rest);
      return true;
    },
    [
      agentAction,
      captureGoalOwner,
      goal,
      rememberComposerInput,
      setError,
      setInput,
      startGoal,
    ]
  );

  /**
   * /workflow 命令拦截：把 `/workflow <目标>` 转成 dynamic workflow 执行。
   * 无参数时给出用法提示；有参数时清空输入并调 startWorkflow。
   */
  const runWorkflowCommand = useCallback(
    async (raw: string): Promise<boolean> => {
      const parsed = parseSlashCommand(raw, ["workflow"]);
      if (!parsed) return false;
      const { rest } = parsed;
      if (!rest) {
        setError("用法：/workflow <目标描述>，将用 dynamic workflow 执行该目标");
        return true;
      }
      rememberComposerInput(raw);
      setInput("");
      await startWorkflow(rest);
      return true;
    },
    [rememberComposerInput, setError, setInput, startWorkflow]
  );

  const handleGoalPause = useCallback(async () => {
    const owner = captureGoalOwner();
    if (!owner) return;
    await agentAction(owner.agentId, { type: "goal_pause" }).catch(() => {});
  }, [captureGoalOwner, agentAction]);

  const handleGoalResume = useCallback(async () => {
    const owner = captureGoalOwner();
    if (!owner) return;
    await agentAction(owner.agentId, { type: "goal_resume" }).catch(() => {});
  }, [captureGoalOwner, agentAction]);

  const handleGoalClear = useCallback(async () => {
    const owner = captureGoalOwner();
    if (!owner) return;
    await agentAction(owner.agentId, { type: "goal_clear" }).catch(() => {});
  }, [captureGoalOwner, agentAction]);

  const sendWithHistory = useCallback(async () => {
    // P1-E: input 不再是 ChatApp 订阅状态，在交互时点同步读一次 store 快照。
    const current = getCurrentInput();
    // 结构化路径：如果已选中 mode chip，直接走该能力。不再依赖“/goal ” 前缀。
    if (composerMode === "goal") {
      if (!current.trim()) {
        setError(goal ? `当前 goal: ${goal.objective}` : "请输入 goal 描述");
        return;
      }
      rememberComposerInput(current);
      setInput("");
      setComposerMode(null);
      await startGoal(current);
      return;
    }
    if (composerMode === "workflow") {
      if (!current.trim()) {
        setError("请输入 workflow 目标描述");
        return;
      }
      rememberComposerInput(current);
      setInput("");
      setComposerMode(null);
      await startWorkflow(current);
      return;
    }
    // 兑底路径：老习惯“/goal foo” “/workflow bar” 还能走。
    if (await runGoalCommand(current)) return;
    if (await runWorkflowCommand(current)) return;
    rememberComposerInput(current);
    await send();
  }, [
    composerMode,
    getCurrentInput,
    goal,
    rememberComposerInput,
    runGoalCommand,
    runWorkflowCommand,
    send,
    setComposerMode,
    setError,
    setInput,
    startGoal,
    startWorkflow,
  ]);

  const steerWithHistory = useCallback(async () => {
    rememberComposerInput(getCurrentInput());
    await onSteer();
  }, [getCurrentInput, onSteer, rememberComposerInput]);

  const followUpWithHistory = useCallback(async () => {
    rememberComposerInput(getCurrentInput());
    await onFollowUp();
  }, [getCurrentInput, onFollowUp, rememberComposerInput]);

  const setComposerInput = useCallback(
    (v: string | ((cur: string) => string)) => {
      historyCursorRef.current = null;
      historyDraftRef.current = "";
      setInput(v);
    },
    [setInput]
  );

  // F10：resume 必须绑定原会话 owner。卷起点击时的 ownerKey/agentId，
  // 如果调用时用户已切走 → 提示用户返回原会话，不要默默写到当前
  // composer，以免在另一个会话 / cwd 里跳 workflow。
  const resumeWorkflowFromCard = useCallback(
    (
      workflowId: string,
      objective: string,
      checkpointName?: string,
      snapshot?: WorkflowResumeSnapshot
    ) => {
      const ownerKeyAtClick = activeKeyRef.current;
      const ownerSnapshot = runnersRef.current.get(ownerKeyAtClick);
      const ownerAgentId = ownerSnapshot?.agentId ?? null;
      const summaryLines = formatWorkflowResumeSummaries(snapshot, checkpointName);
      const prompt = [
        "请从这个历史 workflow 的 checkpoint/artifact 继续执行，不要从头重跑全部工作。",
        "",
        `workflowId: ${workflowId}`,
        `previousObjective: ${objective}`,
        checkpointName ? `checkpointName: ${checkpointName}` : "",
        ...summaryLines,
        "",
        checkpointName
          ? "请使用 run_workflow_script，并设置 resumeFromWorkflowId 为上面的 workflowId，resumeFromCheckpointName 为上面的 checkpointName。"
          : "请使用 run_workflow_script，并设置 resumeFromWorkflowId 为上面的 workflowId。",
        "新的 workflow harness 应读取 workflow.resume.lastCheckpoint 和 workflow.readArtifact(name)，只规划并执行剩余步骤，最后综合给出结果。",
      ]
        .filter(Boolean)
        .join("\n");
      // resume 必须在原 workflow 所属 agent / owner 里发。如果点击时 owner 未改变，
      // 直接写 composer（与原行为一致）；如果 owner runner 已丢失 agent 或被切走，
      // 则提示用户存不能跳 owner 。
      if (
        activeKeyRef.current !== ownerKeyAtClick ||
        ownerAgentId === null
      ) {
        setError(
          "请先返回原 workflow 所属会话再点 resume，避免跳进另一个会话 / cwd。"
        );
        return;
      }
      setComposerInput(prompt);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [activeKeyRef, inputRef, runnersRef, setComposerInput, setError]
  );

  // F9：capture agentId。请求返回后验证当前 agentId 仍是发起时的 agentId，
  // 否则丢弃 —— history/debug bundle 不能住进另一个会话。
  const loadWorkflowHistory = useCallback(async () => {
    const aidAtStart = agentId;
    if (!aidAtStart) return;
    setWorkflowHistoryLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/agent/${aidAtStart}/workflows`);
      const d = (await r.json()) as {
        resumes?: WorkflowResumeSnapshot[];
        error?: string;
      };
      if (!r.ok) throw new Error(d.error ?? `workflow history HTTP ${r.status}`);
      // 返回后才设。如果中间用户已切走，workflowHistoryAgentId 仍被锁在老 aidAtStart，
      // openWorkflowHistory 会重新拉。
      setWorkflowHistory(Array.isArray(d.resumes) ? d.resumes : []);
      setWorkflowHistoryAgentId(aidAtStart);
    } catch (e) {
      setError(userFacingMessage(e));
    } finally {
      setWorkflowHistoryLoading(false);
    }
  }, [agentId]);

  const loadWorkflowDebugBundle = useCallback(
    async (snapshot: WorkflowResumeSnapshot) => {
      const aidAtStart = agentId;
      if (!aidAtStart) return;
      setWorkflowDebugLoading(true);
      setWorkflowDebugError(null);
      try {
        const r = await fetch(
          `/api/agent/${aidAtStart}/workflows?id=${encodeURIComponent(
            snapshot.workflowId
          )}&debug=1`
        );
        const d = (await r.json()) as {
          debugBundle?: WorkflowDebugBundle;
          error?: string;
        };
        if (!r.ok || !d.debugBundle) {
          throw new Error(d.error ?? `workflow debug HTTP ${r.status}`);
        }
        // F9：只在 agentId 未变时才展示。
        if (agentId !== aidAtStart) return;
        setWorkflowDebugBundle(d.debugBundle);
      } catch (e) {
        if (agentId !== aidAtStart) return;
        setWorkflowDebugError(userFacingMessage(e));
      } finally {
        setWorkflowDebugLoading(false);
      }
    },
    [agentId]
  );

  const openWorkflowHistory = useCallback(() => {
    if (!agentId) return;
    if (workflowHistoryAgentId !== agentId) {
      setWorkflowDebugBundle(null);
      setWorkflowDebugError(null);
    }
    setShowWorkflowHistory(true);
    if (workflowHistoryAgentId !== agentId) {
      void loadWorkflowHistory();
    }
  }, [agentId, loadWorkflowHistory, workflowHistoryAgentId]);

  const resumeWorkflowFromHistory = useCallback(
    (snapshot: WorkflowResumeSnapshot, checkpointName?: string) => {
      resumeWorkflowFromCard(
        snapshot.workflowId,
        snapshot.objective,
        checkpointName,
        snapshot
      );
      setShowWorkflowHistory(false);
    },
    [resumeWorkflowFromCard]
  );

  const handleWorkflowWorktreeAction = useCallback(
    async (
      action: "retry_merge" | "cleanup",
      workflowId: string,
      worktree: WorkflowWorktreeAction
    ) => {
      // F9：capture owner。在点击时快照 ownerKey + agentId，请求结束后只能
      // 写回原 owner，不能误安到 当前 active runner。
      const ownerKeyAtClick = activeKeyRef.current;
      const ownerSnapshot = runnersRef.current.get(ownerKeyAtClick);
      const ownerAgentId = ownerSnapshot?.agentId ?? agentId;
      if (!ownerAgentId) {
        const message = "当前没有可用的 agent，无法操作 workflow worktree";
        setError(message);
        throw new Error(message);
      }
      setError(null);
      const r = await fetch(`/api/agent/${ownerAgentId}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type:
            action === "retry_merge"
              ? "retry_merge_worktree"
              : "cleanup_worktree",
          workflowId,
          worktree,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        artifact?: { name: string; value: unknown; createdAt: number };
        error?: string;
      };
      if (!r.ok || d.error) {
        const message =
          d.error ?? `workflow worktree action failed: HTTP ${r.status}`;
        setError(message);
        throw new Error(message);
      }
      if (d.artifact) {
        // 走 captured owner，不读实时 active。如果 owner runner 已被淘汰，随之丢弃。
        const ownerStillExists = runnersRef.current.has(ownerKeyAtClick);
        if (ownerStillExists) {
          handleAgentEvent(
            {
              type: "workflow_artifact",
              workflowId,
              artifact: d.artifact,
            },
            ownerAgentId,
            ownerKeyAtClick
          );
        }
      }
    },
    [activeKeyRef, agentId, handleAgentEvent, runnersRef]
  );

  // S5：以卡片携带的 parentAgentId 为优先，退化到 active agent。
  const retrySubagentTaskFromCard = useCallback(
    async (batchId: string, taskId: string, parentAgentId?: string) => {
      let aid = parentAgentId;
      if (!aid) {
        const ensured = await ensureAgent();
        if (!ensured) {
          setError("当前没有可用的 parent agent，无法重试 subagent task");
          return;
        }
        aid = ensured.aid;
      }
      setError(null);
      const r = await fetch(`/api/agent/${aid}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "retry", batchId, taskId }),
      });
      const data = (await r.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!r.ok || data?.error) {
        setError(data?.error ?? `重试 subagent task 失败: HTTP ${r.status}`);
      }
    },
    [ensureAgent]
  );

  const resumeSubagentBatchFromCard = useCallback(
    async (batchId: string, parentAgentId?: string) => {
      let aid = parentAgentId;
      if (!aid) {
        const ensured = await ensureAgent();
        if (!ensured) {
          setError("当前没有可用的 parent agent，无法继续 subagent batch");
          return;
        }
        aid = ensured.aid;
      }
      setError(null);
      const r = await fetch(`/api/agent/${aid}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "resume", batchId }),
      });
      const data = (await r.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!r.ok || data?.error) {
        setError(data?.error ?? `继续 subagent batch 失败: HTTP ${r.status}`);
      }
    },
    [ensureAgent]
  );

  const openSubagentSessionFromCard = useCallback(
    (sessionFile: string) => {
      const target = sessions.find((session) => session.path === sessionFile);
      if (!target) {
        refreshSessions();
        setError("找不到这个 child subagent session；已刷新 session 列表");
        return;
      }
      setError(null);
      setSelectedId(target.id);
    },
    [refreshSessions, sessions, setSelectedId]
  );

  // ===== Autocomplete + Slash 命令（RFC-1 阶段 C2，已抽到 useAutocomplete） =====
  // 抽离内容：4 个 AC state + 3 个 handler + runSlashCommand(7 case) + onKeyDown 拦截块。
  // startNewSession / onCompact / 4 个 modal setter 通过参数注入；hook 对 UI state 零反向依赖。
  const {
    acMode,
    acItems,
    acIndex,
    setAcIndex,
    refreshAutocomplete,
    closeAutocomplete,
    applyAutocomplete,
    tryHandleAutocompleteKey,
  } = useAutocomplete({
    getInput: getCurrentInput,
    cwd,
    inputRef,
    setInput,
    agentId,
    startNewSession,
    onCompact,
    setShowBranches,
    setShowSystemPrompt,
    setShowModelsConfig,
    setShowAuth,
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 自动补全弹层打开时拦截上下/Enter/Tab/Esc（消费则直接 return）
    if (tryHandleAutocompleteKey(e)) return;
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing
    ) {
      const handled = navigateInputHistory(
        e.key === "ArrowUp" ? "prev" : "next"
      );
      if (handled) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // streaming 时 Enter 默认走 follow_up（排队），shift+Enter 才换行
      if (streaming) void followUpWithHistory();
      else void sendWithHistory();
    }
  };

  const onChangeModel = useCallback(
    async (provider: string, mid: string) => {
      const ownerKey = activeKeyRef.current;
      const prevProviderId = providerId;
      const prevModelId = modelId;
      setProviderId(provider);
      setModelId(mid);
      if (agentId) {
        try {
          const data = (await agentAction(agentId, {
            type: "set_model",
            provider,
            modelId: mid,
          })) as {
            replacementAgent?: {
              id?: string;
              sessionId?: string;
              sessionFile?: string | null;
            };
          };
          const replacement = data?.replacementAgent as
            | {
                id?: string;
                sessionId?: string;
                sessionFile?: string | null;
              }
            | undefined;
          const nextAgentId = replacement?.id || agentId;
          if (replacement?.id) {
            closeSseFor(ownerKey);
            updateRunner(ownerKey, {
              agentId: replacement.id,
              agentSessionId: replacement.sessionId ?? null,
              sessionFile: replacement.sessionFile ?? null,
              sseStatus: "idle",
            });
            attachSseFor(ownerKey, replacement.id);
          }
          // 切完模型后,thinking 能力可能变了,重新拉一下(写回触发本次操作的 runner)
          const meta = await fetch(`/api/agent/${nextAgentId}`).then((r) =>
            r.json()
          );
          updateRunner(ownerKey, {
            ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
            ...(meta.availableThinkingLevels
              ? { availableThinkingLevels: meta.availableThinkingLevels }
              : {}),
            ...(typeof meta.supportsThinking === "boolean"
              ? { supportsThinking: meta.supportsThinking }
              : {}),
          });
          void data;
        } catch (e) {
          setProviderId(prevProviderId);
          setModelId(prevModelId);
          setError(userFacingMessage(e, { context: "settings" }));
        }
      }
    },
    [
      activeKeyRef,
      agentId,
      agentAction,
      attachSseFor,
      closeSseFor,
      modelId,
      providerId,
      setModelId,
      setProviderId,
      updateRunner,
    ]
  );

  // ===== Fork 模块（RFC-1 阶段 C1，已抽到 useForkable hook） =====
  const {
    forksCollapsed,
    refreshForkList,
    startFork,
    cancelFork,
    submitFork,
    forkToNewSession,
  } = useForkable({
    agentId,
    agentSessionId,
    selectedId,
    forkText,
    providerId,
    modelId,
    cwd,
    thinkingLevel,
    sessions,
    activeKeyRef,
    setRunner,
    updateRunner,
    setForkableUserMessages,
    setForkingIndex,
    setForkText,
    attachSseFor,
    switchTo,
    setSelectedId,
    refreshSessions,
    setError,
    refreshStats,
    refreshToolsCount,
    agentAction,
  });

  // refreshForkList ref 同步：useAgentEvents 通过 refreshForkListRef.current 调用本 hook 的方法。
  useEffect(() => {
    refreshForkListRef.current = refreshForkList;
    return () => {
      refreshForkListRef.current = null;
    };
  }, [refreshForkList]);

  // panel 颜色用 CSS 变量驱动；class 里只放结构相关
  return (
    <div
      className="flex h-screen overflow-hidden min-w-0"
      style={{
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      {/* 左：会话列表 */}
      <Sidebar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        cwd={cwd}
        setShowCwdPicker={setShowCwdPicker}
        theme={theme}
        onToggleTheme={toggleTheme}
        updateAvailable={updateState?.status === "available"}
        updateLatestVersion={updateState?.latestVersion}
        onDownloadUpdate={openUpdateDownload}
        onOpenProviderSetup={() => {
          setProviderSetupChild(null);
          setShowProviderSetup(true);
        }}
        onOpenAuth={() => {
          setProviderSetupChild(null);
          openAuth();
        }}
        onOpenSettings={() => {
          window.location.assign("/settings");
        }}
        onSkipUpdateVersion={skipUpdateVersion}
        sessions={sessions}
        groupedSessions={groupedSessions}
        selectedId={selectedId}
        setSelectedId={selectSessionAndCloseWorkbench}
        lastSeenMap={lastSeenMap}
        renamingFor={renamingFor}
        setRenamingFor={setRenamingFor}
        renameDraft={renameDraft}
        setRenameDraft={setRenameDraft}
        menuFor={menuFor}
        setMenuFor={setMenuFor}
        pendingDeleteId={pendingDeleteId}
        setPendingDeleteId={setPendingDeleteId}
        startNewSession={startNewSession}
        submitRename={submitRename}
        executeDeleteSession={executeDeleteSession}
        requestDeleteSession={requestDeleteSession}
        handleExportSession={handleExportSession}
        toggleSessionPin={toggleSessionPin}
        setInput={setInput}
        setShowFilePicker={setShowFilePicker}
        searchQuery={searchHook.query}
        onSearchQueryChange={searchHook.setQuery}
        searchView={
          searchHook.isActive ? (
            <SidebarSearch
              query={searchHook.query}
              status={searchHook.status}
              results={searchHook.results}
              totalDocs={searchHook.totalDocs}
              durationMs={searchHook.durationMs}
              error={searchHook.error}
              onRetry={searchHook.retry}
              onSelect={(id) => {
                searchHook.clear();
                selectSessionAndCloseWorkbench(id);
              }}
              selectedId={selectedId}
              sessionLookup={sessionLookup}
            />
          ) : null
        }
      />

      {/* 右：对话。不再加 inline minWidth=360 ——
          那是个布局 hint，现在 rightPanelMaxWidth 已经预留了
          CHAT_MIN_WIDTH 的空间。一旦这里还定下 minWidth，在
          rightPanelWidth 还没被 clamp 完的跨帧里会让 <main> 拒绝
          压缩、进而迫使父级 flex 压缩 <aside>、导致外壳与内容宽度
          不一致。min-w-0 足够保证 truncate 生效。 */}
      <main
        className="flex flex-1 flex-col min-w-0 relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <DropOverlay isDragOver={isDragOver} />
        <TopHeader
          sidebarOpen={sidebarOpen}
          theme={theme}
          agentId={agentId}
          stats={stats}
          sseStatus={sseStatus}
          electronApi={electronApi}
          currentSessionFile={currentSessionFile}
          hasSessionContext={Boolean(agentId || selectedId || currentSessionFile)}
          showTools={showTools}
          showWorkbench={workbenchOpen}
          updateStatus={updateState?.status}
          updateLatestVersion={updateState?.latestVersion}
          openCommandMenuRequest={openCommandMenuRequest}
          budget={budget}
          budgetSpent={budgetSpent}
          budgetStatus={budgetStatus}
          budgetHasOverride={budgetHasOverride}
          hasAuthedProviders={visibleProviders.length > 0}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleTheme={toggleTheme}
          onOpenBranches={async () => {
            const ensured = await ensureAgent();
            if (!ensured) return;
            setShowBranches(true);
          }}
          onOpenSystemPrompt={async () => {
            const ensured = await ensureAgent();
            if (!ensured) return;
            setShowSystemPrompt(true);
            try {
              const r = await fetch(
                `/api/agent/${ensured.aid}?action=system_prompt`
              );
              const d = (await r.json()) as { systemPrompt?: string };
              setSystemPromptText(d.systemPrompt ?? "");
            } catch (e) {
              setSystemPromptText(userFacingMessage(e));
            }
          }}
          onOpenWorkflows={openWorkflowHistory}
          onRevealInFinder={() => {
            if (electronApi && currentSessionFile) {
              void electronApi
                .revealInFinder(currentSessionFile)
                .catch((e) => setError(userFacingMessage(e)));
            }
          }}
          onOpenProviderSetup={() => {
            setProviderSetupChild(null);
            setShowProviderSetup(true);
          }}
          onOpenAuth={() => {
            setProviderSetupChild(null);
            openAuth();
          }}
          onOpenSettings={(section) => {
            window.location.assign(
              section === "mobile" ? "/settings?section=mobile" : "/settings"
            );
          }}
          onReconnectSession={reconnectActiveSession}
          onToggleTools={toggleTools}
          onToggleWorkbench={toggleWorkbench}
          onCheckForUpdates={checkForUpdates}
          onDownloadUpdate={openUpdateDownload}
          onSkipUpdateVersion={skipUpdateVersion}
        />
        {updateState?.status === "available" && !updateNoticeHidden ? (
          <UpdateNotice
            state={updateState}
            onView={viewUpdateDetails}
            onClose={() => setUpdateNoticeHidden(true)}
          />
        ) : null}
        {updateState?.status === "not-available" && !latestNoticeHidden ? (
          <UpdateLatestNotice
            state={updateState}
            onClose={() => setLatestNoticeHidden(true)}
          />
        ) : null}

        {contextLoading ? (
          <SessionLoadingState
            title={
              selectedSession?.meta?.title ??
              selectedSession?.name ??
              selectedSession?.firstMessage
            }
          />
        ) : messages.length === 0 && !error && !progress ? (
          <EmptyState
            visibleProviders={visibleProviders}
            onOpenProviderSetup={() => {
              setProviderSetupChild(null);
              setShowProviderSetup(true);
            }}
          />
        ) : (
          <MessagesScrollArea
            messages={messages}
            error={error}
            currentProvider={currentProvider}
            modelId={modelId}
            activeAssistantIndex={chatState.activeAssistantIndex}
            agentPhase={agentPhase}
            cwd={cwd}
            streaming={streaming}
            compacting={compacting}
            compactError={compactError}
            pinSpacer={pinSpacer}
            forksCollapsed={forksCollapsed}
            forkingIndex={forkingIndex}
            forkText={forkText}
            forkBusy={forkBusy}
            messagesScrollRef={messagesScrollRef}
            messagesEndRef={messagesEndRef}
            messageRefs={messageRefs}
            onScroll={handleMessagesScroll}
            onStartFork={startFork}
            onCancelFork={cancelFork}
            onChangeForkText={setForkText}
            onSubmitFork={submitFork}
            onForkToNewSession={forkToNewSession}
            onOpenUrl={openUrlInBrowserPanel}
            onApproveCall={approveCall}
            onDenyCall={denyCall}
            onChooseClarification={chooseClarification}
            onRespondClarification={respondClarification}
            onResumeWorkflow={resumeWorkflowFromCard}
            onWorkflowWorktreeAction={handleWorkflowWorktreeAction}
            onRetrySubagentTask={retrySubagentTaskFromCard}
            onResumeSubagentBatch={resumeSubagentBatchFromCard}
            onOpenSubagentSession={openSubagentSessionFromCard}
          />
        )}

        <div className="relative shrink-0">
          {showScrollToBottom && messages.length > 0 ? (
            <button
              type="button"
              onClick={() => scrollMessagesToBottom("smooth", { force: true })}
              className="absolute left-1/2 top-0 z-20 inline-flex h-9 w-9 -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center justify-center rounded-full border shadow-lg backdrop-blur transition-all hover:-translate-y-[calc(100%+10px)] hover:shadow-xl"
              style={{
                borderColor: "var(--border)",
                background: "color-mix(in srgb, var(--bg-panel) 88%, transparent)",
                color: "var(--text)",
              }}
              aria-label="滚动到底部"
              title="滚动到底部"
            >
              <ArrowDown size={16} />
            </button>
          ) : null}

        <Composer
          inputKey={activeKey}
          setInput={setComposerInput}
          inputRef={inputRef}
          fileInputRef={fileInputRef}
          onKeyDown={onKeyDown}
          onPasteTextarea={onPasteTextarea}
          streaming={streaming}
          abortable={abortable}
          compacting={compacting}
          agentId={agentId}
          pendingMessages={activeSnapshot.pendingMessages}
          goal={goal}
          pendingImages={pendingImages}
          pendingFiles={pendingFiles}
          missingFilePaths={missingFilePaths}
          flashedFilePath={flashedFilePath}
          removePendingImage={removePendingImage}
          removePendingFile={removePendingFile}
          addImageFiles={addImageFiles}
          composerMode={composerMode}
          setComposerMode={setComposerMode}
          acMode={acMode}
          acItems={acItems}
          acIndex={acIndex}
          setAcIndex={setAcIndex}
          applyAutocomplete={applyAutocomplete}
          refreshAutocomplete={refreshAutocomplete}
          closeAutocomplete={closeAutocomplete}
          send={sendWithHistory}
          onSteer={steerWithHistory}
          onFollowUp={followUpWithHistory}
          onAbort={onAbort}
          onCompact={onCompact}
          onAbortCompaction={onAbortCompaction}
          onGoalPause={handleGoalPause}
          onGoalResume={handleGoalResume}
          onGoalClear={handleGoalClear}
          retryInfo={retryInfo}
          compactError={compactError}
          visibleProviders={visibleProviders}
          providerId={providerId}
          modelId={modelId}
          currentProvider={currentProvider ?? null}
          onChangeModel={onChangeModel}
          onOpenAuth={(provider) => {
            setProviderSetupChild(null);
            openAuth(provider);
          }}
          onOpenModelsConfig={() => {
            setProviderSetupChild(null);
            setShowModelsConfig(true);
          }}
          onOpenProviderSetup={() => {
            setProviderSetupChild(null);
            setShowProviderSetup(true);
          }}
          supportsThinking={supportsThinking}
          thinkingLevel={thinkingLevel}
          availableThinkingLevels={availableThinkingLevels}
          onChangeThinking={onChangeThinking}
          toolsCount={toolsCount}
          toggleTools={toggleTools}
          soundEnabled={soundEnabled}
          onSoundToggle={onSoundToggle}
        />
        </div>
      </main>

      <WorkbenchSidebar
        open={workbenchOpen}
        view={workbenchView}
        cwd={cwd}
        width={filesContainerWidth}
        isResizing={rightPanelResizing}
        agentId={agentId}
        runtimeIdentity={runtimeIdentity}
        progress={progress}
        browserSnapshot={activeSnapshot.browser}
        browserOpenRequest={browserOpenRequest}
        stats={stats}
        budgetStatus={budgetStatus}
        providerLabel={currentProvider?.provider ?? providerId}
        modelLabel={modelId}
        thinkingLabel={thinkingLevel}
        toolsCount={toolsCount?.active ?? 0}
        pendingFileCount={pendingFiles.length}
        pendingImageCount={pendingImages.length}
        filesLayout={filesLayout}
        onSplitterMouseDown={onSplitterMouseDown}
        onOpenView={openWorkbench}
        onPickPath={(absPath) => {
          // 把路径加到输入框末尾（用 @ 前缀，pi-coding-agent 约定的引用语法）
          setInput((cur) => {
            const sep = cur.length === 0 || cur.endsWith(" ") ? "" : " ";
            return `${cur}${sep}@${absPath} `;
          });
        }}
        onFilesLayoutChange={setFilesLayout}
        onOpenProgressUrl={openUrlInBrowserPanel}
        onAnnotate={(annotations: BrowserAnnotation[]) => {
          if (annotations.length === 0) return;
          // 把结构化批注组装成给 agent 的视觉任务文本（含定位区域、URL、留言）。
          const text =
            annotations.length === 1
              ? formatBrowserAnnotation(annotations[0])
              : [
                  `请处理以下 ${annotations.length} 条页面批注：`,
                  ...annotations.map(
                    (a, i) => `\n${i + 1}. ${formatBrowserAnnotation(a)}`
                  ),
                ].join("\n");
          setComposerInput((cur) => {
            const sep = cur.trim() ? "\n\n" : "";
            return `${cur}${sep}${text}`;
          });
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      />
      {showWorkflowHistory && (
        <WorkflowHistoryPanel
          items={workflowHistory}
          loading={workflowHistoryLoading}
          debugBundle={workflowDebugBundle}
          debugLoading={workflowDebugLoading}
          debugError={workflowDebugError}
          onRefresh={loadWorkflowHistory}
          onClose={() => setShowWorkflowHistory(false)}
          onResume={resumeWorkflowFromHistory}
          onInspect={loadWorkflowDebugBundle}
          onCloseInspector={() => {
            setWorkflowDebugBundle(null);
            setWorkflowDebugError(null);
          }}
        />
      )}
      <ChatModals
        cwd={cwd}
        agentId={agentId}
        state={{
          showCwdPicker,
          showFilePicker,
          showSkills,
          showTools,
          showProviderSetup,
          showAuth,
          authInitialProvider,
          showCompanyClaude3PConfig,
          showModelsConfig,
          providerSetupChild,
          showSystemPrompt,
          systemPromptText,
          showBranches,
        }}
        onCloseCwdPicker={() => setShowCwdPicker(false)}
        onPickCwd={(picked) => {
          setCwd(picked);
          // F1：全局 cwd 仅作为默认值；agent 发送依赖 runner.cwd。
          //   - 如果 runner 还没 agent，同步 runner.cwd 让首发走新路径。
          //   - 如果 runner 已有 agent 且 cwd 不同，记录 pendingCwd 提示用户是否
          //     起新 session。
          updateActive((s) => {
            const ownerCwd = s.cwd ?? null;
            if (!s.agentId) {
              return { cwd: picked, pendingCwd: null };
            }
            if (ownerCwd && ownerCwd !== picked) {
              return { pendingCwd: picked };
            }
            return { cwd: picked, pendingCwd: null };
          });
          setShowCwdPicker(false);
        }}
        onCloseFilePicker={() => setShowFilePicker(false)}
        onPickFile={(absPath) => {
          // 结构化 P5：不再拼 "@/abs/path" 进输入框，走 pendingFiles + FileChip。
          // F1 flash：duplicate 时原 chip 闪一下。
          const r = addPathAttachment(absPath);
          if (r === "duplicate") flashFilePath(absPath);
          setShowFilePicker(false);
        }}
        onCloseSkills={toggleSkills}
        onCloseTools={toggleTools}
        onCloseProviderSetup={() => {
          setProviderSetupChild(null);
          setShowProviderSetup(false);
        }}
        onProviderSetupOpenAuth={(provider) => {
          setProviderSetupChild("auth");
          setShowProviderSetup(false);
          openAuth(provider);
        }}
        onProviderSetupOpenCompanyClaude3PConfig={() => {
          setProviderSetupChild("company3p");
          setShowProviderSetup(false);
          setShowCompanyClaude3PConfig(true);
        }}
        onProviderSetupOpenModelsConfig={() => {
          setProviderSetupChild("models");
          setShowProviderSetup(false);
          setShowModelsConfig(true);
        }}
        onCloseAuth={() => {
          setProviderSetupChild(null);
          closeAuth();
        }}
        onBackFromAuth={() => {
          closeAuth();
          setProviderSetupChild(null);
          setShowProviderSetup(true);
        }}
        onAuthChanged={() => reloadProviders(false)}
        onCloseCompanyClaude3PConfig={() => {
          setProviderSetupChild(null);
          setShowCompanyClaude3PConfig(false);
        }}
        onBackFromCompanyClaude3PConfig={() => {
          setShowCompanyClaude3PConfig(false);
          setProviderSetupChild(null);
          setShowProviderSetup(true);
        }}
        onCompanyClaude3PConfigChanged={() => reloadProviders(false)}
        onCloseModelsConfig={() => {
          setProviderSetupChild(null);
          setShowModelsConfig(false);
        }}
        onBackFromModelsConfig={() => {
          setShowModelsConfig(false);
          setProviderSetupChild(null);
          setShowProviderSetup(true);
        }}
        onModelsConfigChanged={() => reloadProviders(false)}
        onCloseSystemPrompt={closeSystemPrompt}
        onCloseBranches={() => setShowBranches(false)}
        onBranchesNavigated={() => {
          void reloadFromCurrentSession();
        }}
      />
      <BudgetExceededModal
        trigger={budgetPausedTrigger}
        onClose={() => setBudgetPausedTrigger(null)}
        onRaiseAndContinue={handleRaiseAndContinue}
      />
    </div>
  );
}

/**
 * 阶段 D：把一条结构化页面批注组装成给 agent 的视觉任务文本。
 * 包含定位区域（归一化百分比）、页面 URL/标题和用户留言，
 * 让 agent 能定位到“页面的哪个区域有什么问题”。
 */
function formatBrowserAnnotation(a: BrowserAnnotation): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const area = `区域 ${pct(a.rect.x)},${pct(a.rect.y)} 起，宽${pct(
    a.rect.w
  )} 高${pct(a.rect.h)}`;
  return [
    `页面批注${a.url ? ` @ ${a.url}` : ""}`,
    a.title ? `标题：${a.title}` : null,
    area,
    `留言：${a.comment}`,
  ]
    .filter(Boolean)
    .join("\n");
}
