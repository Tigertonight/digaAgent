"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import dynamic from "next/dynamic";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  GitBranch,
  Layers3,
  Loader2,
  Menu,
  Pause,
  Plus,
  Play,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Target,
  TerminalSquare,
  Trash2,
  Wrench,
  WifiOff,
  X,
} from "lucide-react";
import { BrandLogo } from "@/app/components/BrandLogo";
import type { AutocompleteItem } from "@/app/components/InputAutocomplete";
import { SLASH_COMMANDS, type SlashName } from "@/app/hooks/useAutocomplete";
import {
  applyEvent,
  createInitialState,
  ctxToMessages,
  type ReducerState,
} from "@/lib/chat-reducer";
import type {
  ImageContentLite,
  MessagePart,
  ProviderInfo,
  ProvidersResponse,
  SessionInfoLite,
  SessionRuntimeState,
} from "@/lib/types";
import type { AgentGoal } from "@/lib/goal/types";
import {
  goalAcceptanceSummary,
  goalStatusLabel,
} from "@/lib/goal/labels";
import {
  approxBase64Bytes,
  fileToImageContent,
  formatBytes,
} from "@/lib/image-utils";
import {
  curateProviderModels,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_STORAGE_VERSION,
  DEFAULT_PROVIDER_ID,
  getCuratedModelLabel,
} from "@/lib/default-model";
import { buildProcessSummary } from "@/lib/process-summary";
import { toUserFacingError, userFacingMessage } from "@/lib/user-facing-error";
import type {
  LongTaskDashboard,
  LongTaskDefinition,
  LongTaskRun,
  TaskFinding,
  TaskFindingStatus,
} from "@/lib/tasks/types";

interface RemoteStorage {
  token: string;
  deviceId: string;
  baseUrl: string;
  candidates: string[];
  instanceId: string;
}

interface RemoteStatus {
  enabled: boolean;
  mode: "off" | "vpn" | "lan";
  defaultCwd?: string;
  defaultProvider?: string;
  defaultModelId?: string;
  activeAgents?: SessionRuntimeState[];
}

const EMPTY_TASK_DASHBOARD: LongTaskDashboard = {
  tasks: [],
  runs: [],
  findings: [],
  dueTasks: [],
  inboxCount: 0,
};

type ConnectionState = "connected" | "reconnecting" | "offline" | "idle";
type MobileContextMessages = Parameters<typeof ctxToMessages>[0];
type MobileMarkdownProps = {
  text: string;
  size?: "normal" | "small";
  streaming?: boolean;
};

interface MobileSessionContextPage {
  messages?: MobileContextMessages;
  beforeCursor?: number | null;
  hasMoreBefore?: boolean;
  truncatedBefore?: number;
  error?: unknown;
}

interface MobileSessionCache {
  modified: string;
  state: ReducerState;
  beforeCursor: number | null;
  hasMoreBefore: boolean;
}

const MOBILE_STARTERS = [
  {
    title: "同步当前进度",
    body: "请总结当前任务状态、已完成内容、阻塞点，以及我现在需要验收或决策的事项。",
  },
  {
    title: "规划一次改动",
    body: "请先定位这个需求涉及的文件和风险点，然后给出最小实现方案，暂时不要修改代码。",
  },
  {
    title: "快速检查仓库",
    body: "请快速扫描当前项目，列出最值得优先处理的 3 个问题，并说明推荐优先级。",
  },
];

const MOBILE_SESSION_PAGE_SIZE = 30;
const MOBILE_CONTEXT_TAIL_MESSAGES = 80;
const MOBILE_MESSAGE_WINDOW = 36;
const MOBILE_MESSAGE_WINDOW_STEP = 24;
const MOBILE_PROVIDER_STORAGE_KEY = "diga-agent-mobile-provider-id";
const MOBILE_MODEL_STORAGE_KEY = "diga-agent-mobile-model-id";
const MOBILE_MODEL_VERSION_STORAGE_KEY = "diga-agent-mobile-model-default-version";
const MOBILE_FILES_CACHE_TTL_MS = 5000;
const MOBILE_API_RETRY_DELAYS_MS = [0, 450, 1200];
const MOBILE_KEYBOARD_THRESHOLD_PX = 120;
const MOBILE_FILE_AUTOCOMPLETE_IGNORES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "test-results",
]);

function mobileContextHistoryMeta(ctx: MobileSessionContextPage): {
  beforeCursor: number | null;
  hasMoreBefore: boolean;
} {
  const explicitCursor =
    typeof ctx.beforeCursor === "number" && Number.isFinite(ctx.beforeCursor)
      ? ctx.beforeCursor
      : null;
  const fallbackCursor =
    typeof ctx.truncatedBefore === "number" && ctx.truncatedBefore > 0
      ? ctx.truncatedBefore
      : null;
  const beforeCursor = explicitCursor ?? fallbackCursor;
  return {
    beforeCursor,
    hasMoreBefore: ctx.hasMoreBefore === true || beforeCursor !== null,
  };
}

type MobileAutocompleteMode = "@" | "/";
type MobileFileEntry = { name: string; isDir: boolean; path?: string };
const MobileMarkdown = memo(
  dynamic<MobileMarkdownProps>(() => import("@/app/components/Markdown"), {
    ssr: false,
    loading: () => null,
  })
);

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function mobileSleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildRemoteUrl(base: string, path: string, _token?: string): string {
  // R5：不再把 remoteToken 写进 URL。普通请求一律用 Authorization 头，
  // SSE 走一次性 stream ticket（另劤处理）。保留 _token 参数只是为了
  // 调用点不动。
  void _token;
  return new URL(path, base).toString();
}

function mobileBaseLabel(base: string): string {
  if (!base) return "未连接";
  try {
    const host = new URL(base).hostname;
    if (host.endsWith(".trycloudflare.com")) return "公网";
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return "同一 Wi-Fi";
    }
  } catch {
    // Fall through to the generic label.
  }
  return "其他网络";
}

function mobileClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function mobileConnectionText({
  connection,
  hasAgent,
  running,
  blockerCount,
  error,
  baseUrl,
}: {
  connection: ConnectionState;
  hasAgent: boolean;
  running: boolean;
  blockerCount: number;
  error: string | null;
  baseUrl: string;
}): string {
  if (connection === "connected") {
    if (blockerCount > 0) return "需确认";
    if (running) return "执行中";
    return hasAgent ? "已连接" : "任务空闲";
  }
  if (connection === "reconnecting" || connection === "idle") {
    return connection === "idle" ? "正在连接" : "网络恢复中";
  }
  const mapped = toUserFacingError(error || "", {
    baseUrl,
    context: "remote",
  });
  if (mapped.code === "pairing_required") return "需要重新扫码";
  if (mapped.code === "public_unavailable") return "公网连接不可用";
  if (mapped.code === "remote_unreachable") return "电脑端未开启";
  return mapped.title;
}

function getMobileModelSelection(
  providers: ProviderInfo[],
  preferredProvider?: string,
  preferredModel?: string
): { providerId: string; modelId: string } {
  const available = providers.filter((provider) => provider.hasAuth);
  const candidates = available.length > 0 ? available : providers;
  const provider =
    (preferredProvider
      ? candidates.find((item) => item.provider === preferredProvider)
      : undefined) ??
    candidates.find(
      (item) =>
        item.provider === DEFAULT_PROVIDER_ID &&
        item.models.some((model) => model.id === DEFAULT_MODEL_ID)
    ) ??
    candidates[0];
  if (!provider) return { providerId: "", modelId: "" };
  const model =
    (preferredModel
      ? provider.models.find((item) => item.id === preferredModel)
      : undefined) ??
    provider.models.find((item) => item.id === DEFAULT_MODEL_ID) ??
    provider.models[0];
  return { providerId: provider.provider, modelId: model?.id ?? "" };
}

function loadRemoteStorage(): RemoteStorage | null {
  try {
    const remoteHash = new URLSearchParams(window.location.hash.slice(1)).get(
      "remote"
    );
    if (remoteHash) {
      let parsed: RemoteStorage;
      try {
        parsed = JSON.parse(decodeURIComponent(remoteHash)) as RemoteStorage;
      } catch {
        const normalized = remoteHash.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(
          normalized.length + ((4 - (normalized.length % 4)) % 4),
          "="
        );
        parsed = JSON.parse(atob(padded)) as RemoteStorage;
      }
      localStorage.setItem("diga-agent-remote", JSON.stringify(parsed));
      window.history.replaceState(null, "", "/mobile");
      return parsed;
    }
    const raw = localStorage.getItem("diga-agent-remote");
    return raw ? (JSON.parse(raw) as RemoteStorage) : null;
  } catch {
    return null;
  }
}

function partLabel(part: MessagePart): string {
  if (part.kind === "tool") return `${part.toolName} · ${part.status}`;
  if (part.kind === "thinking") return "thinking";
  if (part.kind === "approval") return `${part.toolName} · ${part.status}`;
  if (part.kind === "clarification") return part.title;
  return "";
}

function shortValue(value: unknown, max = 900): string {
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2) || "";
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  } catch {
    return String(value);
  }
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

function joinMobilePath(cwd: string, name: string): string {
  if (!cwd) return name;
  return `${cwd.replace(/[\\/]+$/, "")}/${name}`;
}

function detectMobileAutocompleteToken(
  text: string,
  caret: number
): { mode: MobileAutocompleteMode; query: string; triggerPos: number } | null {
  if (caret <= 0) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@" || ch === "/") break;
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  if (i < 0) return null;
  const trigger = text[i];
  const leftOk = i === 0 || /\s/.test(text[i - 1]);
  if (!leftOk) return null;
  if (trigger === "/") {
    if (text.slice(0, i).trim() !== "") return null;
    return { mode: "/", query: text.slice(i + 1, caret), triggerPos: i };
  }
  return { mode: "@", query: text.slice(i + 1, caret), triggerPos: i };
}

function buildMobileFileItems(
  entries: MobileFileEntry[],
  cwd: string,
  query: string
): AutocompleteItem[] {
  const q = query.toLowerCase();
  return entries
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        !MOBILE_FILE_AUTOCOMPLETE_IGNORES.has(entry.name)
    )
    .filter((entry) => entry.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 12)
    .map((entry) => ({
      label: entry.name + (entry.isDir ? "/" : ""),
      hint: entry.isDir ? "目录" : "文件",
      value: `@${entry.path ?? joinMobilePath(cwd, entry.name)}`,
    }));
}

function getPendingMobileBlockers(messages: ReducerState["messages"]): {
  count: number;
  approvals: number;
  clarifications: number;
  key: string;
} {
  let approvals = 0;
  let clarifications = 0;
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.kind === "approval" && part.status === "pending") {
        approvals += 1;
        ids.push(part.id);
      } else if (part.kind === "clarification" && part.status === "pending") {
        clarifications += 1;
        ids.push(part.id);
      }
    }
  }
  return {
    count: approvals + clarifications,
    approvals,
    clarifications,
    key: ids.join("|"),
  };
}

function statusTone(status: string): string {
  if (status === "done" || status === "completed" || status === "allowed") {
    return "text-[color:var(--color-success)]";
  }
  if (status === "error" || status === "failed" || status === "denied") {
    return "text-[color:var(--color-danger)]";
  }
  return "text-[color:var(--text-muted)]";
}

function MobileDisclosure({
  title,
  subtitle,
  icon,
  defaultOpen = false,
  compact = false,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  defaultOpen?: boolean;
  compact?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggleOpen = (button: HTMLButtonElement) => {
    const scroller = button.closest(
      "[data-mobile-messages-scroll='true']"
    ) as HTMLElement | null;
    const wasNearBottom = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      : false;
    const topBefore = button.getBoundingClientRect().top;
    setOpen((prev) => !prev);
    requestAnimationFrame(() => {
      if (!scroller) return;
      if (wasNearBottom) {
        scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      const topAfter = button.getBoundingClientRect().top;
      scroller.scrollTop += topAfter - topBefore;
    });
  };
  return (
    <div className="overflow-hidden rounded-token-lg border border-[color:var(--border-soft)] bg-[color:var(--bg-subtle)]">
      <button
        type="button"
        onClick={(event) => toggleOpen(event.currentTarget)}
        className={`flex w-full items-center gap-2 px-3 text-left active:bg-[color:var(--bg-hover)] ${
          compact ? "py-1.5" : "py-2"
        }`}
      >
        <span
          className={`inline-flex shrink-0 items-center justify-center rounded-token bg-[color:var(--bg-panel)] text-[color:var(--text-muted)] ${
            compact ? "h-6 w-6" : "h-7 w-7"
          }`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{title}</span>
          {subtitle ? (
            <span className="block truncate text-token-xs text-[color:var(--text-muted)]">
              {subtitle}
            </span>
          ) : null}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="border-t border-[color:var(--border-soft)] px-3 py-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

// S9: 移动端 subagent 卡片需要调 retry/resume/open session，但渲染函数是
// file-scope 的。用 Context 避免一层层 props drilling。由顶层 MobileApp Provider 提供。
export interface MobileSubagentControls {
  retryTask?: (
    batchId: string,
    taskId: string,
    parentAgentId?: string
  ) => Promise<void> | void;
  resumeBatch?: (
    batchId: string,
    parentAgentId?: string
  ) => Promise<void> | void;
  openSession?: (sessionFile: string) => Promise<void> | void;
}
const MobileSubagentControlsContext = createContext<MobileSubagentControls>({});

function MobileSubagentBatchCard({
  part,
}: {
  part: Extract<MessagePart, { kind: "subagent_batch" }>;
}) {
  const { retryTask, resumeBatch, openSession } = useContext(
    MobileSubagentControlsContext
  );
  const [resuming, setResuming] = useState(false);
  const [retryingTaskIds, setRetryingTaskIds] = useState<Set<string>>(
    () => new Set()
  );
  const [showAudit, setShowAudit] = useState(false);
  const done = part.tasks.filter((task) => task.status === "completed").length;
  const failedCount = part.tasks.filter(
    (t) => t.status === "failed" || t.status === "aborted" || t.status === "timeout"
  ).length;
  const hasUnfinished = part.tasks.some(
    (task) => task.status === "pending" || task.status === "running"
  );
  const canResume =
    Boolean(resumeBatch) &&
    Boolean(part.restored) &&
    hasUnfinished &&
    !resuming;

  return (
    <MobileDisclosure
      title={`子任务协作 · ${part.status}`}
      subtitle={`${done}/${part.tasks.length} completed${
        failedCount > 0 ? ` · ${failedCount} failed` : ""
      } · ${part.reason}`}
      icon={<Layers3 size={14} />}
    >
      <div className="space-y-2">
        {part.verification ? (
          <div
            className="rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-2 py-1.5 text-token-xs"
            style={{
              color:
                part.verification.status === "passed"
                  ? "var(--color-success)"
                  : part.verification.status === "warning"
                    ? "var(--color-warning)"
                    : "var(--color-danger)",
            }}
          >
            verification: {part.verification.status} · {part.verification.summary}
          </div>
        ) : null}
        {canResume ? (
          <button
            type="button"
            disabled={!canResume}
            onClick={async () => {
              if (!resumeBatch) return;
              setResuming(true);
              try {
                await resumeBatch(part.id, part.parentAgentId);
              } finally {
                setResuming(false);
              }
            }}
            className="w-full rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-2 py-1.5 text-xs disabled:opacity-50"
          >
            {resuming ? "继续中…" : "继续未完成的子任务"}
          </button>
        ) : null}
        {part.tasks.map((task) => {
          const retryKey = task.id;
          const isRetrying = retryingTaskIds.has(retryKey);
          const canRetry =
            Boolean(retryTask) &&
            (task.status === "failed" ||
              task.status === "aborted" ||
              task.status === "timeout") &&
            !isRetrying;
          return (
            <div
              key={task.id}
              className="rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-2 text-xs"
            >
              <div className="flex gap-2">
                <span className={statusTone(task.status)}>{task.status}</span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {task.title}
                </span>
                {task.verification ? (
                  <span
                    className="rounded border border-[color:var(--border-soft)] px-1 text-token-xs"
                    style={{
                      color:
                        task.verification.status === "passed"
                          ? "var(--color-success)"
                          : task.verification.status === "warning"
                            ? "var(--color-warning)"
                            : "var(--color-danger)",
                    }}
                    title={task.verification.checks
                      .map((c) => `${c.id}: ${c.status}`)
                      .join(" | ")}
                  >
                    {task.verification.status}
                  </span>
                ) : null}
              </div>
              {task.answerPreview || task.error ? (
                <div className="mt-1 line-clamp-3 text-[color:var(--text-muted)]">
                  {task.answerPreview || task.error}
                </div>
              ) : null}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {canRetry ? (
                  <button
                    type="button"
                    disabled={!canRetry}
                    onClick={async () => {
                      if (!retryTask) return;
                      setRetryingTaskIds((cur) => {
                        const n = new Set(cur);
                        n.add(retryKey);
                        return n;
                      });
                      try {
                        await retryTask(part.id, task.id, part.parentAgentId);
                      } finally {
                        setRetryingTaskIds((cur) => {
                          const n = new Set(cur);
                          n.delete(retryKey);
                          return n;
                        });
                      }
                    }}
                    className="rounded border border-[color:var(--border-soft)] px-2 py-0.5 text-token-xs disabled:opacity-50"
                  >
                    {isRetrying ? "重试中…" : "重试"}
                  </button>
                ) : null}
                {task.sessionFile && openSession ? (
                  <button
                    type="button"
                    onClick={() => void openSession(task.sessionFile!)}
                    className="rounded border border-[color:var(--border-soft)] px-2 py-0.5 text-token-xs"
                  >
                    打开 child session
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {part.auditEvents && part.auditEvents.length > 0 ? (
          <div className="rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-2">
            <button
              type="button"
              onClick={() => setShowAudit((v) => !v)}
              className="flex w-full items-center justify-between text-xs"
            >
              <span>审计事件（{part.auditEvents.length}）</span>
              {showAudit ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
            {showAudit ? (
              <ul className="mt-1.5 space-y-1 text-token-xs text-[color:var(--text-muted)]">
                {part.auditEvents.map((ev, i) => (
                  <li key={i} className="truncate" title={ev.message}>
                    [{ev.type}] {ev.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </MobileDisclosure>
  );
}

// C5: 移动端追问卡片。独立于全局 composer input——在卡片里会独立输入
// 自定义回复，避免误以为“发送新 prompt”被 clarification 吞掉。
function MobileClarificationCard({
  part,
  clarify,
}: {
  part: Extract<MessagePart, { kind: "clarification" }>;
  clarify: (
    requestId: string,
    body: { selectedOptionId?: string; customText?: string }
  ) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState<"option" | "custom" | null>(
    null
  );

  const submitChoice = async (optionId: string) => {
    if (submitting) return;
    setSubmitting("option");
    try {
      await clarify(part.requestId, { selectedOptionId: optionId });
    } finally {
      setSubmitting(null);
    }
  };

  const submitCustom = async () => {
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting("custom");
    try {
      await clarify(part.requestId, { customText: text });
      setDraft("");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="space-y-2 rounded-token-lg border border-[color:var(--accent)] bg-[color:var(--color-accent-bg)] p-3">
      <div className="font-medium">{part.title}</div>
      <div className="whitespace-pre-wrap text-sm">{part.question}</div>
      {part.status === "pending" ? (
        <>
          <div className="space-y-1">
            {part.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={submitting !== null}
                onClick={() => void submitChoice(option.id)}
                className="block w-full rounded border border-[color:var(--border-soft)] px-2 py-1.5 text-left text-xs disabled:opacity-50"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 500))}
              placeholder="自定义回复…"
              disabled={submitting !== null}
              className="min-w-0 flex-1 rounded border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-2 py-1.5 text-xs outline-none disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void submitCustom()}
              disabled={!draft.trim() || submitting !== null}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-xs disabled:opacity-50"
            >
              {submitting === "custom" ? "发送中…" : "发送"}
            </button>
          </div>
        </>
      ) : (
        <div className="text-xs text-[color:var(--text-muted)]">已回复</div>
      )}
    </div>
  );
}

function MobileAutocompletePanel({
  mode,
  items,
  selectedIndex,
  onPick,
  onHover,
}: {
  mode: MobileAutocompleteMode;
  items: AutocompleteItem[];
  selectedIndex: number;
  onPick: (item: AutocompleteItem) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="mb-2 overflow-hidden rounded-token-lg border border-[color:var(--border-soft)] bg-[color:var(--bg)] shadow-popover">
      <div className="flex items-center gap-2 border-b border-[color:var(--border-soft)] px-3 py-2 text-token-xs text-[color:var(--text-muted)]">
        <span className="font-mono text-[color:var(--text)]">{mode}</span>
        <span>{mode === "@" ? "引用当前项目文件" : "快捷命令"}</span>
      </div>
      <div className="max-h-[220px] overflow-y-auto p-1">
        {items.length === 0 ? (
          <div className="px-3 py-3 text-xs text-[color:var(--text-muted)]">
            {mode === "@" ? "没有匹配的文件" : "没有匹配的命令"}
          </div>
        ) : (
          items.map((item, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={`${item.value}:${index}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onPointerEnter={() => onHover(index)}
                onClick={() => onPick(item)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-token px-3 py-2 text-left text-sm ${
                  active ? "bg-[color:var(--bg-selected)]" : "active:bg-[color:var(--bg-hover)]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {item.label}
                </span>
                {item.hint ? (
                  <span className="max-w-[42%] shrink-0 truncate text-token-xs text-[color:var(--text-muted)]">
                    {item.hint}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function mobileTaskStatusLabel(task: LongTaskDefinition): string {
  if (task.status === "waiting_user") return "等待你决策";
  if (task.status === "running") return "执行中";
  if (task.status === "failed") return "执行失败";
  if (task.status === "scheduled") return "已计划";
  if (task.status === "completed") return "已完成";
  if (task.status === "paused") return "已暂停";
  return "空闲";
}

function mobileSeverityTone(severity: TaskFinding["severity"]): string {
  if (severity === "critical") return "text-[color:var(--color-danger)]";
  if (severity === "warning") return "text-[color:var(--color-warning)]";
  return "text-[color:var(--color-info)]";
}

function MobileTaskInbox({
  dashboard,
  sessions,
  onFindingStatus,
  onOpenRunSession,
}: {
  dashboard: LongTaskDashboard;
  sessions: SessionInfoLite[];
  onFindingStatus: (id: string, status: TaskFindingStatus) => void;
  onOpenRunSession: (sessionFile?: string | null) => void;
}) {
  const inbox = dashboard.findings.filter((finding) => finding.status === "unread");
  const waitingTasks = dashboard.tasks.filter((task) => task.status === "waiting_user");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  if (inbox.length === 0 && waitingTasks.length === 0) return null;

  const sessionFiles = new Set(sessions.map((session) => session.path));
  const selectedFinding = selectedFindingId
    ? dashboard.findings.find((finding) => finding.id === selectedFindingId) ?? null
    : null;
  const selectedRun = selectedFinding
    ? dashboard.runs.find((run) => run.id === selectedFinding.runId) ?? null
    : null;
  const selectedTask = selectedFinding
    ? dashboard.tasks.find((task) => task.id === selectedFinding.taskId) ?? null
    : null;
  const runForFinding = (finding: TaskFinding) =>
    dashboard.runs.find((run) => run.id === finding.runId);
  const runForTask = (task: LongTaskDefinition) =>
    dashboard.runs.find((run) => run.id === task.lastRunId);

  return (
    <section className="space-y-2 rounded-token-lg border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-3 text-left">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--bg)] text-[color:var(--accent)]">
          <ShieldAlert size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">任务收件箱</div>
          <div className="truncate text-token-xs text-[color:var(--text-muted)]">
            {inbox.length} 个待处理事项
            {waitingTasks.length > 0 ? ` · ${waitingTasks.length} 个等待决策` : ""}
          </div>
        </div>
      </div>

      {waitingTasks.slice(0, 2).map((task) => {
        const run = runForTask(task);
        const latestCheckpoint = run?.checkpoints.at(-1);
        const canOpen = Boolean(run?.sessionFile && sessionFiles.has(run.sessionFile));
        return (
          <div
            key={task.id}
            className="rounded-token border border-[color:var(--color-warning)] bg-[color:var(--color-warning-bg)] p-2.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-warning)]" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {task.title}
              </span>
              <span className="shrink-0 text-token-xs text-[color:var(--color-warning)]">
                {mobileTaskStatusLabel(task)}
              </span>
            </div>
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-[color:var(--text-muted)]">
              {run?.waitingReason || task.lastSummary || "请回到对应会话处理确认。"}
            </div>
            {latestCheckpoint ? (
              <div className="mt-1 truncate text-token-xs text-[color:var(--text-muted)]">
                最近状态：{latestCheckpoint.title}
              </div>
            ) : null}
            {canOpen ? (
              <button
                type="button"
                onClick={() => onOpenRunSession(run?.sessionFile)}
                className="mt-2 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-2.5 py-1 text-token-xs"
              >
                打开会话
              </button>
            ) : null}
          </div>
        );
      })}

      {inbox.slice(0, 3).map((finding) => {
        const run = runForFinding(finding);
        const latestCheckpoint = run?.checkpoints.at(-1);
        const canOpen = Boolean(run?.sessionFile && sessionFiles.has(run.sessionFile));
        return (
          <div
            key={finding.id}
            className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-2.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className={`text-xs ${mobileSeverityTone(finding.severity)}`}>
                ●
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {finding.title}
              </span>
            </div>
            <div className="mt-1 line-clamp-3 text-xs leading-5 text-[color:var(--text-muted)]">
              {finding.body}
            </div>
            {latestCheckpoint ? (
              <div className="mt-1 truncate text-token-xs text-[color:var(--text-muted)]">
                最近状态：{latestCheckpoint.title}
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedFindingId(finding.id)}
                className="rounded-full border border-[color:var(--border-soft)] px-2.5 py-1 text-token-xs"
              >
                查看报告
              </button>
              {canOpen ? (
                <button
                  type="button"
                  onClick={() => onOpenRunSession(run?.sessionFile)}
                  className="rounded-full border border-[color:var(--border-soft)] px-2.5 py-1 text-token-xs"
                >
                  打开会话
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onFindingStatus(finding.id, "reviewed")}
                className="rounded-full border border-[color:var(--border-soft)] px-2.5 py-1 text-token-xs"
              >
                已读
              </button>
              <button
                type="button"
                onClick={() => onFindingStatus(finding.id, "resolved")}
                className="rounded-full bg-[color:var(--accent)] px-2.5 py-1 text-token-xs"
                style={{ color: "var(--color-bg)" }}
              >
                已解决
              </button>
            </div>
          </div>
        );
      })}

      {selectedFinding ? (
        <MobileTaskReportSheet
          finding={selectedFinding}
          run={selectedRun}
          task={selectedTask}
          canOpenSession={Boolean(
            selectedRun?.sessionFile && sessionFiles.has(selectedRun.sessionFile)
          )}
          onClose={() => setSelectedFindingId(null)}
          onFindingStatus={(status) => {
            onFindingStatus(selectedFinding.id, status);
            setSelectedFindingId(null);
          }}
          onOpenRunSession={() => onOpenRunSession(selectedRun?.sessionFile)}
        />
      ) : null}
    </section>
  );
}

function MobileTaskReportSheet({
  finding,
  run,
  task,
  canOpenSession,
  onClose,
  onFindingStatus,
  onOpenRunSession,
}: {
  finding: TaskFinding;
  run?: LongTaskRun | null;
  task?: LongTaskDefinition | null;
  canOpenSession: boolean;
  onClose: () => void;
  onFindingStatus: (status: TaskFindingStatus) => void;
  onOpenRunSession: () => void;
}) {
  const checkpoints = run?.checkpoints ?? [];
  return (
    <div
      className="fixed inset-0 z-50 flex items-end px-3 pb-3 pt-12"
      style={{ background: "var(--color-overlay)" }}
    >
      <button
        type="button"
        className="absolute inset-0"
        aria-label="关闭任务报告"
        onClick={onClose}
      />
      <section
        data-testid="mobile-task-report-sheet"
        className="relative max-h-[82vh] w-full overflow-hidden rounded-3xl border border-[color:var(--border-soft)] bg-[color:var(--bg)] shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-[color:var(--border-soft)] px-4 py-3">
          <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--bg-panel)] text-[color:var(--accent)]">
            <ShieldAlert size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-token-xs font-medium text-[color:var(--text-muted)]">
              任务报告
            </div>
            <h3 className="mt-0.5 text-base font-semibold leading-6">
              {finding.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)]"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <div className="max-h-[calc(82vh-132px)] space-y-3 overflow-y-auto px-4 py-3 text-sm">
          <div className="grid grid-cols-2 gap-2 text-xs text-[color:var(--text-muted)]">
            <div className="rounded-2xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2">
              <div>关联任务</div>
              <div className="mt-1 truncate font-medium text-[color:var(--text)]">
                {task?.title ?? finding.taskId}
              </div>
            </div>
            <div className="rounded-2xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2">
              <div>运行状态</div>
              <div className="mt-1 font-medium text-[color:var(--text)]">
                {run ? mobileRunStatusLabel(run.status) : "未找到运行记录"}
              </div>
            </div>
          </div>

          <section>
            <div className="mb-1 text-xs font-medium text-[color:var(--text-muted)]">
              报告内容
            </div>
            <div className="whitespace-pre-wrap rounded-2xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2 leading-6">
              {finding.body}
            </div>
          </section>

          {run?.summary || run?.waitingReason || run?.error ? (
            <section>
              <div className="mb-1 text-xs font-medium text-[color:var(--text-muted)]">
                本次运行结论
              </div>
              <div className="whitespace-pre-wrap rounded-2xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2 leading-6">
                {run.waitingReason || run.summary || run.error}
              </div>
            </section>
          ) : null}

          <section>
            <div className="mb-1 text-xs font-medium text-[color:var(--text-muted)]">
              执行时间线
            </div>
            {checkpoints.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[color:var(--border-soft)] px-3 py-4 text-center text-xs text-[color:var(--text-muted)]">
                这个报告没有 checkpoint 记录。
              </div>
            ) : (
              <div className="space-y-2 rounded-2xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-3">
                {checkpoints.map((checkpoint) => (
                  <div key={checkpoint.id} className="flex gap-2 text-xs">
                    <span className="w-[72px] shrink-0 text-[color:var(--text-muted)]">
                      {mobileTaskTime(checkpoint.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{checkpoint.title}</span>
                      {checkpoint.detail ? (
                        <span className="ml-1 text-[color:var(--text-muted)]">
                          {checkpoint.detail}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-[color:var(--border-soft)] px-4 py-3">
          {canOpenSession ? (
            <button
              type="button"
              onClick={onOpenRunSession}
              className="rounded-full border border-[color:var(--border-soft)] px-3 py-1.5 text-xs"
            >
              打开会话
            </button>
          ) : null}
          {finding.status === "unread" ? (
            <>
              <button
                type="button"
                onClick={() => onFindingStatus("reviewed")}
                className="rounded-full border border-[color:var(--border-soft)] px-3 py-1.5 text-xs"
              >
                已读
              </button>
              <button
                type="button"
                onClick={() => onFindingStatus("resolved")}
                className="rounded-full bg-[color:var(--accent)] px-3 py-1.5 text-xs"
                style={{ color: "var(--color-bg)" }}
              >
                已解决
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => onFindingStatus("archived")}
            className="rounded-full border border-[color:var(--border-soft)] px-3 py-1.5 text-xs"
          >
            归档
          </button>
        </div>
      </section>
    </div>
  );
}

function mobileRunStatusLabel(status: LongTaskRun["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "waiting_user") return "等待你决策";
  if (status === "completed_with_findings") return "已汇报事项";
  if (status === "completed_empty") return "无新事项";
  if (status === "failed") return "失败";
  return "已中止";
}

function mobileTaskTime(value?: number): string {
  if (!value) return "尚未运行";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function isMobileProcessPart(part: MessagePart): boolean {
  return (
    part.kind === "thinking" ||
    part.kind === "tool" ||
    part.kind === "subagent_batch" ||
    part.kind === "workflow_run"
  );
}

function MobileProcessGroup({
  parts,
  meta,
  input,
  approve,
  deny,
  clarify,
}: {
  parts: MessagePart[];
  meta?: ReducerState["messages"][number]["meta"];
  input: string;
  approve: (
    toolCallId: string,
    remember?: "this-session",
    ruleId?: string
  ) => Promise<void>;
  deny: (toolCallId: string) => Promise<void>;
  clarify: (
    requestId: string,
    body: { selectedOptionId?: string; customText?: string }
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const summary = buildProcessSummary({ parts, meta });
  return (
    <div className="overflow-hidden rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--bg)] text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left active:bg-[color:var(--bg-hover)]"
        aria-expanded={open}
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] text-[color:var(--text-muted)]">
          <Check size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-[color:var(--text)]">{summary.title}</span>
          <span className="ml-2 text-[color:var(--text-muted)]">{summary.detail}</span>
        </span>
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-[color:var(--text-muted)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[color:var(--text-muted)]" />
        )}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-[color:var(--border-soft)] px-3 py-3">
        {parts.map((part, index) => (
          <MobileMessagePart
            key={index}
            part={part}
            input={input}
            approve={approve}
            deny={deny}
            clarify={clarify}
          />
        ))}
        </div>
      ) : null}
    </div>
  );
}

function MobileMessagePart({
  part,
  // C5 之后不再使用，仅保留接口类型。用 ”赋一次 void“ 避免 unused warning。
  input,
  streaming = false,
  approve,
  deny,
  clarify,
}: {
  part: MessagePart;
  input: string;
  streaming?: boolean;
  approve: (
    toolCallId: string,
    remember?: "this-session",
    ruleId?: string
  ) => Promise<void>;
  deny: (toolCallId: string) => Promise<void>;
  clarify: (
    requestId: string,
    body: { selectedOptionId?: string; customText?: string }
  ) => Promise<void>;
}) {
  // C5：保留 input prop 以保持调用点向后兼容，但不再使用。
  void input;
  if (part.kind === "text") {
    return (
      <div className="mobile-message-markdown min-w-0 overflow-hidden">
        <MobileMarkdown text={part.text} streaming={streaming} />
      </div>
    );
  }

  if (part.kind === "thinking") {
    return (
      <MobileDisclosure
        title="思考细节"
        subtitle={part.text.trim().split(/\s+/).slice(0, 16).join(" ")}
        icon={<Brain size={14} />}
      >
        <div className="thinking-md text-xs leading-6 text-[color:var(--text-muted)]">
          <MobileMarkdown text={part.text} size="small" />
        </div>
      </MobileDisclosure>
    );
  }

  if (part.kind === "tool") {
    const resultText = shortValue(part.result ?? part.partialResult ?? "");
    const argsText = shortValue(part.args ?? "");
    return (
      <MobileDisclosure
        title={`工具执行 · ${part.toolName}`}
        subtitle={part.isError ? "执行出错" : part.status}
        icon={<Wrench size={14} />}
        defaultOpen={false}
      >
        <div className="space-y-2 text-xs">
          <div className={statusTone(part.isError ? "error" : part.status)}>
            状态：{part.isError ? "error" : part.status}
          </div>
          {argsText ? (
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg bg-[color:var(--bg-panel)] p-2 text-token-xs leading-5">
              {argsText}
            </pre>
          ) : null}
          {resultText ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[color:var(--bg-panel)] p-2 text-token-xs leading-5">
              {resultText}
            </pre>
          ) : null}
        </div>
      </MobileDisclosure>
    );
  }

  if (part.kind === "image") {
    return (
      <button
        type="button"
        className="block overflow-hidden rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)]"
        title={part.mimeType}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:${part.mimeType};base64,${part.data}`}
          alt="上传图片"
          className="max-h-72 w-full object-contain"
        />
      </button>
    );
  }

  if (part.kind === "approval") {
    return (
      <div className="space-y-2 rounded-token-lg border border-[color:var(--color-warning)] bg-[color:var(--color-warning-bg)] p-3">
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-warning)]">
          <ShieldAlert size={14} />
          <span>需要审批：{part.toolName}</span>
          <span className="ml-auto">{part.status}</span>
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[color:var(--bg)] p-2 text-token-xs leading-5">
          {JSON.stringify(part.input, null, 2)}
        </pre>
        {part.status === "pending" ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                void approve(
                  part.toolCallId,
                  part.ruleId ? "this-session" : undefined,
                  part.ruleId
                )
              }
              className="inline-flex items-center gap-1 rounded-[var(--button-radius)] bg-[color:var(--color-success)] px-2 py-1 text-xs"
              style={{ color: "var(--color-bg)" }}
            >
              <Check size={12} />
              允许
            </button>
            <button
              type="button"
              onClick={() => void deny(part.toolCallId)}
              className="inline-flex items-center gap-1 rounded-[var(--button-radius)] border border-[color:var(--color-danger)] px-2 py-1 text-xs text-[color:var(--color-danger)]"
            >
              <X size={12} />
              拒绝
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (part.kind === "clarification") {
    // C5：不再复用全局 composer input，用专属输入框（避免把用户准备发的
    // 新 prompt 当成 clarification 答案消耗掉）。
    return <MobileClarificationCard part={part} clarify={clarify} />;
  }

  if (part.kind === "subagent_batch") {
    return <MobileSubagentBatchCard part={part} />;
  }

  if (part.kind === "workflow_run") {
    const statusLabel =
      part.status === "needs_continue" ? "需要继续" : part.status;
    return (
      <MobileDisclosure
        title={`工作流 · ${statusLabel}`}
        subtitle={part.objective}
        icon={<GitBranch size={14} />}
      >
        <div className="space-y-2 text-xs">
          <div className="whitespace-pre-wrap leading-5">{part.rationale}</div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-[color:var(--bg-panel)] p-2">
              checkpoints<br />
              <span className="font-medium">{part.checkpoints.length}</span>
            </div>
            <div className="rounded-lg bg-[color:var(--bg-panel)] p-2">
              artifacts<br />
              <span className="font-medium">{part.artifacts.length}</span>
            </div>
            <div className="rounded-lg bg-[color:var(--bg-panel)] p-2">
              logs<br />
              <span className="font-medium">{part.logs.length}</span>
            </div>
          </div>
          {part.error ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-token bg-[color:var(--color-danger-bg)] p-2 text-token-xs text-[color:var(--color-danger)]">
              {part.error}
            </pre>
          ) : null}
        </div>
      </MobileDisclosure>
    );
  }

  return (
    <div className="rounded border border-[color:var(--border-soft)] px-2 py-1 text-xs text-[color:var(--text-muted)]">
      {partLabel(part)}
    </div>
  );
}

function MobileChatMessage({
  message,
  input,
  approve,
  deny,
  clarify,
}: {
  message: ReducerState["messages"][number];
  input: string;
  approve: (
    toolCallId: string,
    remember?: "this-session",
    ruleId?: string
  ) => Promise<void>;
  deny: (toolCallId: string) => Promise<void>;
  clarify: (
    requestId: string,
    body: { selectedOptionId?: string; customText?: string }
  ) => Promise<void>;
}) {
  const parts: MessagePart[] =
    message.parts && message.parts.length > 0
      ? message.parts
      : message.text
        ? [{ kind: "text", text: message.text }]
        : [];
  if (message.role === "user") {
    return (
      <article className="flex justify-end">
        <div className="max-w-[86%] space-y-1.5">
          {parts.map((part, partIndex) => {
            if (part.kind === "text") {
              return (
                <div
                  key={partIndex}
                  className="rounded-sheet rounded-br-md bg-[color:var(--bg-selected)] px-3.5 py-2.5 text-token-mobile leading-6 shadow-sm"
                >
                  <div className="whitespace-pre-wrap break-words">{part.text}</div>
                </div>
              );
            }
            if (part.kind === "image") {
              return (
                <div
                  key={partIndex}
                  className="overflow-hidden rounded-2xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:${part.mimeType};base64,${part.data}`}
                    alt="上传图片"
                    className="max-h-72 w-full object-contain"
                  />
                </div>
              );
            }
            return null;
          })}
        </div>
      </article>
    );
  }

  return (
    <article className="min-w-0">
      <div className="mb-1.5 flex items-center gap-2 px-1 text-token-xs text-[color:var(--text-muted)]">
        <BrandLogo size={18} />
        <span>Diga</span>
      </div>
      <div className="min-w-0 space-y-2 text-token-mobile leading-7">
        {(() => {
          const rendered: ReactNode[] = [];
          let index = 0;
          while (index < parts.length) {
            if (isMobileProcessPart(parts[index])) {
              const start = index;
              const group: MessagePart[] = [];
              while (index < parts.length && isMobileProcessPart(parts[index])) {
                group.push(parts[index]);
                index += 1;
              }
              rendered.push(
                <MobileProcessGroup
                  key={`process-${start}`}
                  parts={group}
                  meta={message.meta}
                  input={input}
                  approve={approve}
                  deny={deny}
                  clarify={clarify}
                />
              );
              continue;
            }
            rendered.push(
              <MobileMessagePart
                key={index}
                part={parts[index]}
                input={input}
                streaming={false}
                approve={approve}
                deny={deny}
                clarify={clarify}
              />
            );
            index += 1;
          }
          return rendered;
        })()}
      </div>
    </article>
  );
}

function MobileGoalStrip({
  goal,
  disabled,
  onPause,
  onResume,
  onClear,
}: {
  goal: AgentGoal;
  disabled?: boolean;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const canPause = goal.status === "active";
  const canResume = goal.status === "paused" || goal.status === "blocked";
  const tone =
    goal.status === "complete"
      ? "var(--color-success)"
      : goal.status === "blocked"
        ? "var(--color-danger)"
        : goal.status === "paused"
          ? "var(--color-warning)"
          : "var(--accent)";
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--bg-panel)] px-3 py-2 text-xs"
      data-testid="mobile-goal-strip"
    >
      <Target size={14} className="shrink-0" style={{ color: tone }} />
      <span
        className="shrink-0 rounded-full border px-1.5 py-0.5"
        style={{
          borderColor: "var(--border-soft)",
          color: tone,
          background: "var(--bg-subtle)",
        }}
      >
        {goalStatusLabel(goal)}
      </span>
      <span className="min-w-0 flex-1 truncate" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="hidden shrink-0 text-token-xs text-[color:var(--text-muted)] min-[380px]:inline">
        {goalAcceptanceSummary(goal.acceptanceCriteria)}
      </span>
      {canPause && (
        <button
          type="button"
          disabled={disabled}
          onClick={onPause}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] text-[color:var(--text-muted)] disabled:opacity-40"
          title="暂停目标"
          aria-label="暂停目标"
        >
          <Pause size={13} />
        </button>
      )}
      {canResume && (
        <button
          type="button"
          disabled={disabled}
          onClick={onResume}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] text-[color:var(--text-muted)] disabled:opacity-40"
          title="继续目标"
          aria-label="继续目标"
        >
          <Play size={13} />
        </button>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] text-[color:var(--text-muted)] disabled:opacity-40"
        title="清除目标"
        aria-label="清除目标"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

export default function MobileApp({
  initialRemote = null,
}: {
  initialRemote?: RemoteStorage | null;
}) {
  const [remote, setRemote] = useState<RemoteStorage | null>(initialRemote);
  const [baseUrl, setBaseUrl] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [taskDashboard, setTaskDashboard] =
    useState<LongTaskDashboard>(EMPTY_TASK_DASHBOARD);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [sessions, setSessions] = useState<SessionInfoLite[]>([]);
  const [visibleSessionCount, setVisibleSessionCount] = useState(
    MOBILE_SESSION_PAGE_SIZE
  );
  const [visibleMessageWindow, setVisibleMessageWindow] = useState(
    MOBILE_MESSAGE_WINDOW
  );
  const [selected, setSelected] = useState<SessionInfoLite | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [mobileGoal, setMobileGoal] = useState<AgentGoal | null>(null);
  const [chatState, setChatState] = useState<ReducerState>(() => createInitialState());
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageContentLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [keyboardCompact, setKeyboardCompact] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [sessionLoadingId, setSessionLoadingId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [hasMoreHistoryBefore, setHasMoreHistoryBefore] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);
  const [acMode, setAcMode] = useState<MobileAutocompleteMode | null>(null);
  const [acItems, setAcItems] = useState<AutocompleteItem[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessagesScrollTopRef = useRef(0);
  const shouldScrollAfterSessionLoadRef = useRef(false);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionLoadSeqRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const acTriggerPosRef = useRef(-1);
  const remoteRef = useRef<RemoteStorage | null>(initialRemote);
  const baseUrlRef = useRef("");
  const sendingRef = useRef(false);
  const sessionContextCacheRef = useRef<
    Map<string, MobileSessionCache>
  >(new Map());
  const sessionPrefetchingRef = useRef<Set<string>>(new Set());
  const filesCacheRef = useRef<
    Map<string, { ts: number; entries: MobileFileEntry[] }>
  >(new Map());

  useEffect(() => {
    remoteRef.current = remote;
  }, [remote]);

  useEffect(() => {
    baseUrlRef.current = baseUrl;
  }, [baseUrl]);

  const persistRemoteBase = useCallback((storage: RemoteStorage, nextBase: string) => {
    const nextStorage = {
      ...storage,
      baseUrl: nextBase,
      candidates: uniqueStrings([nextBase, ...storage.candidates]),
    };
    remoteRef.current = nextStorage;
    baseUrlRef.current = nextBase;
    setRemote(nextStorage);
    setBaseUrl(nextBase);
    try {
      localStorage.setItem("diga-agent-remote", JSON.stringify(nextStorage));
    } catch {
      // Storage may be unavailable in private browsing; runtime state is enough.
    }
  }, []);

  const findReachableBase = useCallback(async (storage: RemoteStorage) => {
    for (const candidate of uniqueStrings([storage.baseUrl, ...storage.candidates])) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(`${candidate}/api/remote/ping`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (res.ok) return candidate;
      } catch {
        // try next candidate
      } finally {
        clearTimeout(timer);
      }
    }
    return "";
  }, []);

  const refreshReachableBase = useCallback(async () => {
    const storage = remoteRef.current;
    if (!storage) return "";
    const nextBase = await findReachableBase({
      ...storage,
      baseUrl: baseUrlRef.current || storage.baseUrl,
    });
    if (nextBase) persistRemoteBase(storage, nextBase);
    return nextBase;
  }, [findReachableBase, persistRemoteBase]);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const retryBudget = method === "GET" || method === "HEAD" ? 3 : 1;
      let lastError: unknown = null;
      let lastResponse: Response | null = null;
      for (let attempt = 0; attempt < retryBudget; attempt += 1) {
        if (init?.signal?.aborted) {
          throw new DOMException("Request aborted", "AbortError");
        }
        const storage = remoteRef.current;
        const token = storage?.token;
        const bases = uniqueStrings([
          baseUrlRef.current,
          storage?.baseUrl,
          ...(storage?.candidates ?? []),
        ]);
        const base = bases[Math.min(attempt, Math.max(0, bases.length - 1))] ?? "";
        if (!base) throw new Error("主机离线或候选地址不可达");
        if (attempt > 0) await mobileSleep(MOBILE_API_RETRY_DELAYS_MS[attempt] ?? 1200);
        const headers = new Headers(init?.headers);
        if (token) headers.set("Authorization", `Bearer ${token}`);
        try {
          const res = await fetch(buildRemoteUrl(base, path, token), {
            ...init,
            headers,
          });
          lastResponse = res;
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            return res;
          }
          if (res.ok) {
            if (storage && base !== baseUrlRef.current) persistRemoteBase(storage, base);
            setConnection("connected");
            return res;
          }
          if (![408, 425, 429, 500, 502, 503, 504].includes(res.status)) {
            return res;
          }
        } catch (e) {
          if (init?.signal?.aborted) throw e;
          lastError = e;
        }
        const nextBase = await refreshReachableBase();
        if (!nextBase && attempt === retryBudget - 1) break;
      }
      if (lastResponse) return lastResponse;
      throw lastError instanceof Error
        ? lastError
        : new Error("网络连接不稳定，请稍后重试。");
    },
    [persistRemoteBase, refreshReachableBase]
  );

  const loadAll = useCallback(async () => {
    if (!baseUrl) return;
    setError(null);
    try {
      const [statusRes, sessionsRes, providersRes, tasksRes] = await Promise.all([
        apiFetch("/api/remote/status"),
        apiFetch("/api/sessions"),
        apiFetch("/api/providers"),
        apiFetch("/api/tasks"),
      ]);
      if (sessionsRes.status === 401 || providersRes.status === 401) {
        try {
          localStorage.removeItem("diga-agent-remote");
          document.cookie = "diga-agent-remote=; Max-Age=0; Path=/";
        } catch {
          // Ignore storage cleanup failures; the visible error still guides the user.
        }
        setRemote(null);
        setBaseUrl("");
        setConnection("offline");
        throw new Error("配对已失效，请在电脑端重新生成二维码并扫码连接。");
      }
      if (!statusRes.ok || !sessionsRes.ok || !providersRes.ok) {
        throw new Error(
          "移动端数据加载失败，请刷新后重试。"
        );
      }
      const statusJson = (await statusRes.json()) as RemoteStatus;
      const sessionsJson = (await sessionsRes.json()) as {
        sessions?: SessionInfoLite[];
      };
      const providersJson = (await providersRes.json()) as ProvidersResponse;
      const tasksJson = tasksRes.ok
        ? ((await tasksRes.json().catch(() => ({}))) as Partial<LongTaskDashboard>)
        : {};
      const nextTaskDashboard: LongTaskDashboard = {
        ...EMPTY_TASK_DASHBOARD,
        ...tasksJson,
        tasks: Array.isArray(tasksJson.tasks) ? tasksJson.tasks : [],
        runs: Array.isArray(tasksJson.runs) ? tasksJson.runs : [],
        findings: Array.isArray(tasksJson.findings) ? tasksJson.findings : [],
        dueTasks: Array.isArray(tasksJson.dueTasks) ? tasksJson.dueTasks : [],
        inboxCount:
          typeof tasksJson.inboxCount === "number" ? tasksJson.inboxCount : 0,
        scheduler: tasksJson.scheduler,
      };
      const nextProviders = Array.isArray(providersJson.providers)
        ? providersJson.providers
        : [];
      let storedProvider = "";
      let storedModel = "";
      try {
        const storageVersion = localStorage.getItem(
          MOBILE_MODEL_VERSION_STORAGE_KEY
        );
        if (storageVersion !== DEFAULT_MODEL_STORAGE_VERSION) {
          localStorage.removeItem(MOBILE_PROVIDER_STORAGE_KEY);
          localStorage.removeItem(MOBILE_MODEL_STORAGE_KEY);
          localStorage.setItem(
            MOBILE_MODEL_VERSION_STORAGE_KEY,
            DEFAULT_MODEL_STORAGE_VERSION
          );
        } else {
          storedProvider = localStorage.getItem(MOBILE_PROVIDER_STORAGE_KEY) ?? "";
          storedModel = localStorage.getItem(MOBILE_MODEL_STORAGE_KEY) ?? "";
        }
      } catch {
        // ignore storage read failures
      }
      const preferredProvider =
        providerId || storedProvider || statusJson.defaultProvider;
      const preferredModel =
        modelId || storedModel || statusJson.defaultModelId;
      const selection = getMobileModelSelection(
        nextProviders,
        preferredProvider,
        preferredModel
      );
      setStatus(statusJson);
      setTaskDashboard(nextTaskDashboard);
      setProviders(nextProviders);
      setProviderId(selection.providerId);
      setModelId(selection.modelId);
      setSessions(Array.isArray(sessionsJson.sessions) ? sessionsJson.sessions : []);
      setVisibleSessionCount((prev) =>
        Math.min(
          Math.max(prev, MOBILE_SESSION_PAGE_SIZE),
          Array.isArray(sessionsJson.sessions) ? sessionsJson.sessions.length : prev
        )
      );
      setConnection("connected");
    } catch (e) {
      setConnection("offline");
      setError(userFacingMessage(e, { baseUrl: baseUrlRef.current || baseUrl, context: "remote" }));
    }
  }, [apiFetch, baseUrl, modelId, providerId]);

  const fetchSessionContextState = useCallback(
    async (session: SessionInfoLite, signal?: AbortSignal) => {
      const params = new URLSearchParams({
        tail: String(MOBILE_CONTEXT_TAIL_MESSAGES),
        path: session.path,
      });
      const res = await apiFetch(
        `/api/sessions/${encodeURIComponent(session.id)}/context?${params}`,
        { signal }
      );
      const ctx = (await res.json()) as MobileSessionContextPage;
      if (!res.ok || ctx.error) {
        throw new Error(userFacingMessage(ctx.error ?? res.statusText, { baseUrl: baseUrlRef.current, context: "remote" }));
      }
      const historyMeta = mobileContextHistoryMeta(ctx);
      const nextState = createInitialState(
        ctxToMessages(Array.isArray(ctx.messages) ? ctx.messages : [])
      );
      sessionContextCacheRef.current.set(session.id, {
        modified: session.modified,
        state: nextState,
        ...historyMeta,
      });
      return { ctx, state: nextState, historyMeta };
    },
    [apiFetch]
  );

  const loadMobileGoal = useCallback(
    async (aid: string | null = agentId) => {
      if (!aid) {
        setMobileGoal(null);
        return;
      }
      try {
        const res = await apiFetch(`/api/agent/${aid}?action=goal_timeline`);
        const json = (await res.json().catch(() => ({}))) as { goal?: AgentGoal | null };
        if (!res.ok) throw new Error("goal_timeline failed");
        setMobileGoal(json.goal ?? null);
      } catch {
        // Goal visibility should never block the mobile chat path.
        setMobileGoal(null);
      }
    },
    [agentId, apiFetch]
  );

  const loadSessionContext = useCallback(
    async (
      session: SessionInfoLite,
      scrollAfterLoad = false,
      signal?: AbortSignal
    ) => {
      const { ctx, state: nextState, historyMeta } = await fetchSessionContextState(
        session,
        signal
      );
      shouldScrollAfterSessionLoadRef.current = scrollAfterLoad;
      setVisibleMessageWindow(MOBILE_MESSAGE_WINDOW);
      setHistoryCursor(historyMeta.beforeCursor);
      setHasMoreHistoryBefore(historyMeta.hasMoreBefore);
      setChatState(nextState);
      return ctx;
    },
    [fetchSessionContextState]
  );

  useEffect(() => {
    let cancelled = false;
    if (!agentId) {
      window.queueMicrotask(() => {
        if (!cancelled) setMobileGoal(null);
      });
      return () => {
        cancelled = true;
      };
    }
    window.queueMicrotask(() => {
      if (!cancelled) void loadMobileGoal(agentId);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, loadMobileGoal]);

  const reconcileSelectedSession = useCallback(
    async (reason = "network") => {
      const runningNow =
        agentRunning ||
        Boolean(
          agentId &&
            status?.activeAgents?.some(
              (agent) =>
                agent.id === agentId &&
                (agent.runtimeState === "streaming" || agent.isStreaming)
            )
        );
      if (!selected || runningNow) return;
      try {
        await loadSessionContext(selected, reason === "agent_end");
      } catch {
        // Keep the current optimistic view; the next health check or user action
        // will retry. Reconciliation should not interrupt the mobile workflow.
      }
    },
    [agentId, agentRunning, loadSessionContext, selected, status?.activeAgents]
  );

  const scheduleReconcileSelectedSession = useCallback(
    (reason = "network", delay = 350) => {
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = setTimeout(() => {
        reconcileTimerRef.current = null;
        void reconcileSelectedSession(reason);
      }, delay);
    },
    [reconcileSelectedSession]
  );

  useEffect(() => {
    if (!sessionDrawerOpen || sessions.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const candidates = sessions
          .slice(0, Math.min(visibleSessionCount, 8))
          .filter((session) => {
            const cached = sessionContextCacheRef.current.get(session.id);
            return cached?.modified !== session.modified;
          });
        for (const session of candidates) {
          if (controller.signal.aborted) return;
          if (sessionPrefetchingRef.current.has(session.id)) continue;
          sessionPrefetchingRef.current.add(session.id);
          try {
            await fetchSessionContextState(session, controller.signal);
          } catch {
            // Prefetch is opportunistic; visible session switching still handles errors.
          } finally {
            sessionPrefetchingRef.current.delete(session.id);
          }
          await mobileSleep(80);
        }
      })();
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fetchSessionContextState, sessionDrawerOpen, sessions, visibleSessionCount]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (initialRemote) {
        const trustedBase =
          initialRemote.baseUrl ||
          (typeof window !== "undefined" ? window.location.origin : "");
        const trustedRemote = { ...initialRemote, baseUrl: trustedBase };
        localStorage.setItem("diga-agent-remote", JSON.stringify(trustedRemote));
        setRemote(trustedRemote);
        setBaseUrl(trustedBase);
        setConnection("reconnecting");
        void findReachableBase(initialRemote).then((nextBase) => {
          if (cancelled) return;
        if (!nextBase) {
          return;
        }
          persistRemoteBase(trustedRemote, nextBase);
        });
        return;
      }
      const storage = loadRemoteStorage();
      if (!storage) {
        setConnection("offline");
        return;
      }
      setRemote(storage);
      void findReachableBase(storage).then((nextBase) => {
        if (cancelled) return;
        if (!nextBase) {
          if (storage.baseUrl) {
            setBaseUrl(storage.baseUrl);
            setConnection("reconnecting");
          } else {
            setConnection("offline");
            setError("主机离线或候选地址不可达");
          }
          return;
        }
        setBaseUrl(nextBase);
        persistRemoteBase(storage, nextBase);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [findReachableBase, initialRemote, persistRemoteBase]);

  useEffect(() => {
    queueMicrotask(() => void loadAll());
  }, [loadAll]);

  useEffect(() => {
    const reconcileOnFocus = () => {
      if (document.visibilityState === "hidden") return;
      void loadAll();
      scheduleReconcileSelectedSession("focus", 250);
    };
    window.addEventListener("focus", reconcileOnFocus);
    document.addEventListener("visibilitychange", reconcileOnFocus);
    return () => {
      window.removeEventListener("focus", reconcileOnFocus);
      document.removeEventListener("visibilitychange", reconcileOnFocus);
    };
  }, [loadAll, scheduleReconcileSelectedSession]);

  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || !baseUrlRef.current) return;
      void (async () => {
        const storage = remoteRef.current;
        if (!storage) return;
        const current = baseUrlRef.current;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 1800);
        try {
          const res = await fetch(`${current}/api/remote/ping`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (res.ok) return;
        } catch {
          // fall through to candidate probing
        } finally {
          window.clearTimeout(timeout);
        }
        if (cancelled) return;
        setConnection("reconnecting");
        const nextBase = await refreshReachableBase();
        if (!cancelled && !nextBase) {
          setConnection("offline");
          setError("公网连接恢复中，请稍作等待。");
        } else if (!cancelled) {
          scheduleReconcileSelectedSession("network", 500);
        }
      })();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshReachableBase, remote, scheduleReconcileSelectedSession]);

  const attachSse = useCallback(
    (nextAgentId: string, options: { replay?: boolean } = {}) => {
      eventSourceRef.current?.close();
      const replay = options.replay === true;
      const sinceValue =
        replay && typeof lastSeqRef.current === "number"
          ? String(lastSeqRef.current)
          : "-1";
      // R5：先过 ticket 接口拿一次性 SSE ticket，再 attach。
      // ticket 进 URL 可接受——短期、一次性，即使被代理记下也不能重放。
      const start = async () => {
        const storage = remoteRef.current;
        const base = baseUrlRef.current || baseUrl;
        let ticket: string | null = null;
        if (storage?.token) {
          try {
            const r = await fetch(
              new URL("/api/remote/sse-ticket", base).toString(),
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${storage.token}`,
                },
                body: "{}",
                cache: "no-store",
              }
            );
            if (r.ok) {
              const d = (await r.json()) as { ticket?: string };
              if (d.ticket) ticket = d.ticket;
            }
          } catch {
            // 拿不到 ticket 就走本地开发 fallback（同源会被 isLocalRequest 放行）。
          }
        }
        const params = new URLSearchParams();
        params.set("since", sinceValue);
        if (ticket) params.set("sseTicket", ticket);
        const url = `${base}/api/agent/${nextAgentId}/events?${params.toString()}`;
        const es = new EventSource(url);
        eventSourceRef.current = es;
        es.onopen = () => {
          reconnectAttemptRef.current = 0;
          setConnection("connected");
          scheduleReconcileSelectedSession("sse_open", 600);
        };
        es.onmessage = (ev) => {
          const seq = ev.lastEventId ? Number(ev.lastEventId) : NaN;
          if (Number.isFinite(seq)) lastSeqRef.current = seq;
          const event = JSON.parse(ev.data);
          if (event?.type === "agent_start") setAgentRunning(true);
          if (event?.type === "agent_end") {
            setAgentRunning(false);
            scheduleReconcileSelectedSession("agent_end", 450);
            void loadAll();
            void loadMobileGoal(nextAgentId);
          }
          if (event?.type === "goal_updated") {
            setMobileGoal((event as { goal?: AgentGoal | null }).goal ?? null);
          }
          setChatState((prev) => applyEvent(prev, event));
        };
        es.onerror = () => {
          es.close();
          if (eventSourceRef.current === es) eventSourceRef.current = null;
          setConnection("reconnecting");
          const attempt = reconnectAttemptRef.current++;
          const delay = Math.min(30000, 1000 * 2 ** attempt);
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            void (async () => {
              await refreshReachableBase();
              attachSse(nextAgentId, { replay: true });
            })();
          }, delay);
        };
      };
      void start();
    },
    [baseUrl, loadAll, loadMobileGoal, refreshReachableBase, scheduleReconcileSelectedSession]
  );

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      sessionAbortRef.current?.abort();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let stableHeight = Math.max(
      window.innerHeight,
      document.documentElement.clientHeight
    );
    const applyViewportVars = () => {
      const visualViewport = window.visualViewport;
      const layoutHeight = Math.max(
        window.innerHeight,
        document.documentElement.clientHeight
      );
      const visualHeight = visualViewport?.height ?? layoutHeight;
      const offsetTop = visualViewport?.offsetTop ?? 0;
      const nextInset = Math.max(
        0,
        Math.round(layoutHeight - visualHeight - offsetTop)
      );

      if (nextInset < MOBILE_KEYBOARD_THRESHOLD_PX) {
        stableHeight = layoutHeight;
      }
      document.documentElement.style.setProperty(
        "--mobile-app-height",
        `${stableHeight}px`
      );
      document.documentElement.style.setProperty(
        "--mobile-keyboard-inset",
        `${nextInset}px`
      );
      setKeyboardInset(nextInset);
      setKeyboardCompact(
        nextInset > MOBILE_KEYBOARD_THRESHOLD_PX || visualHeight < 620
      );
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    applyViewportVars();
    window.addEventListener("resize", applyViewportVars);
    window.visualViewport?.addEventListener("resize", applyViewportVars);
    window.visualViewport?.addEventListener("scroll", applyViewportVars);
    return () => {
      window.removeEventListener("resize", applyViewportVars);
      window.visualViewport?.removeEventListener("resize", applyViewportVars);
      window.visualViewport?.removeEventListener("scroll", applyViewportVars);
    };
  }, []);

  const scrollMessagesToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = messagesScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }, []);

  const resumeAutoScrollToBottom = useCallback(() => {
    setAutoScrollPaused(false);
    scrollMessagesToBottom();
  }, [scrollMessagesToBottom]);

  useEffect(() => {
    if (!shouldScrollAfterSessionLoadRef.current) return;
    shouldScrollAfterSessionLoadRef.current = false;
    scrollMessagesToBottom();
  }, [chatState.messages.length, scrollMessagesToBottom]);

  const handleMessagesScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceToBottom < 88;
    const scrollingUp = el.scrollTop < lastMessagesScrollTopRef.current - 6;
    if (nearBottom) {
      setAutoScrollPaused(false);
    } else if (scrollingUp) {
      setAutoScrollPaused(true);
    }
    lastMessagesScrollTopRef.current = el.scrollTop;
  };

  const loadEarlierMessages = async () => {
    const hiddenBefore = Math.max(
      0,
      chatState.messages.length - visibleMessageWindow
    );
    if (hiddenBefore > 0) {
      setVisibleMessageWindow((prev) =>
        Math.min(chatState.messages.length, prev + MOBILE_MESSAGE_WINDOW_STEP)
      );
      return;
    }
    if (
      !selected ||
      !hasMoreHistoryBefore ||
      historyCursor === null ||
      historyLoading
    ) {
      return;
    }

    const scroller = messagesScrollRef.current;
    const previousScrollHeight = scroller?.scrollHeight ?? 0;
    const previousScrollTop = scroller?.scrollTop ?? 0;
    const loadSeq = sessionLoadSeqRef.current;
    setHistoryLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        before: String(historyCursor),
        limit: String(MOBILE_CONTEXT_TAIL_MESSAGES),
        path: selected.path,
      });
      const res = await apiFetch(
        `/api/sessions/${encodeURIComponent(selected.id)}/context?${params}`
      );
      const ctx = (await res.json()) as MobileSessionContextPage;
      if (!res.ok || ctx.error) {
        throw new Error(ctx.error ? String(ctx.error) : res.statusText);
      }
      if (sessionLoadSeqRef.current !== loadSeq) return;
      const olderMessages = ctxToMessages(
        Array.isArray(ctx.messages) ? ctx.messages : []
      );
      const historyMeta = mobileContextHistoryMeta(ctx);
      setHistoryCursor(historyMeta.beforeCursor);
      setHasMoreHistoryBefore(historyMeta.hasMoreBefore);

      if (olderMessages.length > 0) {
        setVisibleMessageWindow((prev) => prev + olderMessages.length);
        setChatState((prev) => {
          const nextState: ReducerState = {
            ...prev,
            messages: [...olderMessages, ...prev.messages],
            activeAssistantIndex:
              prev.activeAssistantIndex >= 0
                ? prev.activeAssistantIndex + olderMessages.length
                : prev.activeAssistantIndex,
          };
          sessionContextCacheRef.current.set(selected.id, {
            modified: selected.modified,
            state: nextState,
            ...historyMeta,
          });
          return nextState;
        });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const current = messagesScrollRef.current;
            if (!current) return;
            current.scrollTop =
              current.scrollHeight - previousScrollHeight + previousScrollTop;
          });
        });
      } else {
        setHasMoreHistoryBefore(false);
        sessionContextCacheRef.current.set(selected.id, {
          modified: selected.modified,
          state: chatState,
          beforeCursor: null,
          hasMoreBefore: false,
        });
      }
    } catch (e) {
      setError(
        userFacingMessage(e, {
          baseUrl: baseUrlRef.current || baseUrl,
          context: "remote",
        })
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  const selectSession = async (session: SessionInfoLite) => {
    const seq = sessionLoadSeqRef.current + 1;
    sessionLoadSeqRef.current = seq;
    sessionAbortRef.current?.abort();
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    setSessionDrawerOpen(false);
    setSelected(session);
    setAgentId(null);
    setMobileGoal(null);
    setAgentRunning(false);
    setVisibleMessageWindow(MOBILE_MESSAGE_WINDOW);
    const cached = sessionContextCacheRef.current.get(session.id);
    if (cached) {
      shouldScrollAfterSessionLoadRef.current = true;
      setChatState(cached.state);
      setHistoryCursor(cached.beforeCursor);
      setHasMoreHistoryBefore(cached.hasMoreBefore);
      setSessionLoadingId(null);
    } else {
      setChatState(createInitialState());
      setHistoryCursor(null);
      setHasMoreHistoryBefore(false);
      setSessionLoadingId(session.id);
    }
    lastSeqRef.current = null;
    eventSourceRef.current?.close();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const active = status?.activeAgents?.find(
      (agent) => agent.sessionFile === session.path
    );
    if (cached?.modified === session.modified && !active) {
      sessionAbortRef.current = null;
      return;
    }
    try {
      await loadSessionContext(session, true, controller.signal);
      if (sessionLoadSeqRef.current !== seq) return;
      if (active) {
        setAgentId(active.id);
        setAgentRunning(
          active.runtimeState === "streaming" || active.isStreaming
        );
        attachSse(active.id);
      }
    } catch (e) {
      if (
        controller.signal.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        return;
      }
      if (sessionLoadSeqRef.current !== seq) return;
      setError(userFacingMessage(e, { baseUrl: baseUrlRef.current || baseUrl, context: "remote" }));
    } finally {
      if (sessionLoadSeqRef.current === seq) {
        setSessionLoadingId(null);
        if (sessionAbortRef.current === controller) {
          sessionAbortRef.current = null;
        }
      }
    }
  };

  const onSessionListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom > 160) return;
    setVisibleSessionCount((prev) =>
      Math.min(sessions.length, prev + MOBILE_SESSION_PAGE_SIZE)
    );
  };

  const changeModel = async (nextProviderId: string, nextModelId: string) => {
    if (!nextProviderId || !nextModelId) return;
    setProviderId(nextProviderId);
    setModelId(nextModelId);
    try {
      localStorage.setItem(MOBILE_PROVIDER_STORAGE_KEY, nextProviderId);
      localStorage.setItem(MOBILE_MODEL_STORAGE_KEY, nextModelId);
      localStorage.setItem(
        MOBILE_MODEL_VERSION_STORAGE_KEY,
        DEFAULT_MODEL_STORAGE_VERSION
      );
    } catch {
      // ignore storage write failures
    }
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/agent/${agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "set_model",
          provider: nextProviderId,
          modelId: nextModelId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
    } catch (e) {
      setError(userFacingMessage(e, { baseUrl: baseUrlRef.current || baseUrl, context: "remote" }));
    } finally {
      setBusy(false);
    }
  };

  const ensureAgent = async (): Promise<string | null> => {
    if (agentId) return agentId;
    const selectedModel = getMobileModelSelection(
      providers,
      providerId || status?.defaultProvider,
      modelId || status?.defaultModelId
    );
    if (!selectedModel.providerId || !selectedModel.modelId) {
      setError("主机没有可用 provider/model，请先在桌面设置凭证。");
      return null;
    }
    const res = await apiFetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: selectedModel.providerId,
        modelId: selectedModel.modelId,
        cwd: selected?.cwd || status?.defaultCwd || "",
        sessionPath: selected?.path,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setError(userFacingMessage(data.error ?? res.statusText, { baseUrl, context: "remote" }));
      return null;
    }
    setAgentId(data.id);
    attachSse(data.id);
    return data.id;
  };

  const sendPrompt = async (
    text: string,
    images: ImageContentLite[],
    clearComposer: boolean
  ) => {
    if (!text && images.length === 0) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setAutoScrollPaused(false);
    setBusy(true);
    setError(null);
    try {
      const aid = await ensureAgent();
      if (!aid) return;
      if (clearComposer) {
        setInput("");
        setPendingImages([]);
      }
      const res = await apiFetch(`/api/agent/${aid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "prompt",
          clientRequestId: mobileClientRequestId(),
          text: text || "(image)",
          images: images.length > 0 ? images : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      setAgentRunning(true);
      scrollMessagesToBottom();
      void loadAll();
      scheduleReconcileSelectedSession("send", 900);
    } catch (e) {
      setAgentRunning(false);
      setError(userFacingMessage(e, { baseUrl: baseUrlRef.current || baseUrl, context: "remote" }));
    } finally {
      sendingRef.current = false;
      setSending(false);
      setBusy(false);
    }
  };

  const send = async () => {
    await sendPrompt(input.trim(), pendingImages, true);
  };

  const addImageFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((file) =>
      file.type.startsWith("image/")
    );
    if (images.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const converted = await Promise.all(images.map((file) => fileToImageContent(file)));
      setPendingImages((prev) => [...prev, ...converted]);
    } catch (e) {
      setError(userFacingMessage(e, { baseUrl: baseUrlRef.current || baseUrl, context: "remote" }));
    } finally {
      setBusy(false);
    }
  };

  const removePendingImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  const applyStarter = (starter: (typeof MOBILE_STARTERS)[number]) => {
    setInput("");
    void sendPrompt(starter.body, [], false);
  };

  const focusComposer = () => {
    setComposerFocused(true);
  };

  const blurComposer = () => {
    window.setTimeout(() => {
      setComposerFocused(false);
      closeAutocomplete();
    }, 140);
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const maxRatio = keyboardCompact ? 0.22 : 0.34;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(viewportHeight * maxRatio))}px`;
  }, [input, keyboardCompact]);

  const abort = async () => {
    if (!agentId) return;
    setAgentRunning(false);
    await apiFetch(`/api/agent/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "abort" }),
    });
    scheduleReconcileSelectedSession("abort", 600);
  };

  const runGoalAction = async (
    action: "goal_pause" | "goal_resume" | "goal_clear"
  ) => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/agent/${agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      await loadMobileGoal(agentId);
      scheduleReconcileSelectedSession("goal", 500);
    } catch (e) {
      setError(
        userFacingMessage(e, {
          baseUrl: baseUrlRef.current || baseUrl,
          context: "remote",
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const approve = async (
    toolCallId: string,
    remember?: "this-session",
    ruleId?: string
  ) => {
    if (!agentId) return;
    await apiFetch(`/api/agent/${agentId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCallId,
        decision: "allow",
        remember,
        ruleId,
      }),
    });
    scheduleReconcileSelectedSession("approval", 600);
  };

  const deny = async (toolCallId: string) => {
    if (!agentId) return;
    await apiFetch(`/api/agent/${agentId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCallId,
        decision: "deny",
        denyReason: "Denied from mobile.",
      }),
    });
    scheduleReconcileSelectedSession("approval", 600);
  };

  const clarify = async (
    requestId: string,
    body: { selectedOptionId?: string; customText?: string }
  ) => {
    if (!agentId) return;
    await apiFetch(`/api/agent/${agentId}/clarification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, ...body }),
    });
    scheduleReconcileSelectedSession("clarification", 600);
  };

  const updateFindingStatus = async (
    findingId: string,
    nextStatus: TaskFindingStatus
  ) => {
    setError(null);
    try {
      const res = await apiFetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "finding_status",
          id: findingId,
          status: nextStatus,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        dashboard?: LongTaskDashboard;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      if (data.dashboard) setTaskDashboard(data.dashboard);
      void loadAll();
    } catch (e) {
      setError(
        userFacingMessage(e, {
          baseUrl: baseUrlRef.current || baseUrl,
          context: "remote",
        })
      );
    }
  };

  // S9：移动端 subagent 卡片控件。parentAgentId 优先，不坐在当前 active session 上。
  const subagentRetryTask = useCallback(
    async (batchId: string, taskId: string, parentAgentId?: string) => {
      const aid = parentAgentId ?? agentId;
      if (!aid) {
        setError("当前没有可用的 parent agent，无法重试 subagent task");
        return;
      }
      const r = await apiFetch(`/api/agent/${aid}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "retry", batchId, taskId }),
      });
      const data = (await r.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!r.ok || data?.error) {
        setError(data?.error ?? `重试 subagent task 失败: HTTP ${r.status}`);
      } else {
        scheduleReconcileSelectedSession("subagent-retry", 600);
      }
    },
    [agentId, apiFetch, scheduleReconcileSelectedSession]
  );

  const subagentResumeBatch = useCallback(
    async (batchId: string, parentAgentId?: string) => {
      const aid = parentAgentId ?? agentId;
      if (!aid) {
        setError("当前没有可用的 parent agent，无法继续 subagent batch");
        return;
      }
      const r = await apiFetch(`/api/agent/${aid}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "resume", batchId }),
      });
      const data = (await r.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!r.ok || data?.error) {
        setError(data?.error ?? `继续 subagent batch 失败: HTTP ${r.status}`);
      } else {
        scheduleReconcileSelectedSession("subagent-resume", 600);
      }
    },
    [agentId, apiFetch, scheduleReconcileSelectedSession]
  );

  const subagentOpenSession = useCallback(
    async (sessionFile: string) => {
      const session = sessions.find((s) => s.path === sessionFile);
      if (!session) {
        setError("找不到这个 child subagent session，请刷新 session 列表。");
        return;
      }
      await selectSession(session);
    },
    // selectSession 是个底层顶函数（deps 太多不宜抽 useCallback）。这里只需
    // sessions 变化重构即可；selectSession 在 closure 里拿到的是实际调用时的最新版本。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions]
  );

  const openTaskRunSession = (sessionFile?: string | null) => {
    if (!sessionFile) {
      setError("这个任务还没有可打开的会话记录。");
      return;
    }
    const session = sessions.find((item) => item.path === sessionFile);
    if (!session) {
      setError("对应会话暂未同步到移动端，请稍后刷新。");
      return;
    }
    void selectSession(session);
  };

  const closeAutocomplete = useCallback(() => {
    setAcMode(null);
    setAcItems([]);
    setAcIndex(0);
    acTriggerPosRef.current = -1;
  }, []);

  const startNew = useCallback(() => {
    sessionLoadSeqRef.current += 1;
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = null;
    setSelected(null);
    setAgentId(null);
    setAgentRunning(false);
    setVisibleMessageWindow(MOBILE_MESSAGE_WINDOW);
    setHistoryCursor(null);
    setHasMoreHistoryBefore(false);
    setHistoryLoading(false);
    setChatState(createInitialState());
    setSessionLoadingId(null);
    lastSeqRef.current = null;
    eventSourceRef.current?.close();
    setSessionDrawerOpen(false);
    closeAutocomplete();
  }, [closeAutocomplete]);

  const compactContext = useCallback(async () => {
    if (!agentId) {
      setError("当前没有可压缩的会话。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/agent/${agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "compact" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
    } catch (e) {
      setError(userFacingMessage(e, { baseUrl: baseUrlRef.current || baseUrl, context: "remote" }));
    } finally {
      setBusy(false);
    }
  }, [agentId, apiFetch, baseUrl]);

  const runMobileSlashCommand = useCallback(
    (name: SlashName) => {
      closeAutocomplete();
      switch (name) {
        case "clear":
          startNew();
          setInput("");
          break;
        case "compact":
          setInput("");
          void compactContext();
          break;
        case "models":
          setInput("");
          setModelSheetOpen(true);
          break;
        case "goal":
          setInput("/goal ");
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case "workflow":
          setInput("/workflow ");
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case "help":
          setInput(
            "支持命令：\n" +
              SLASH_COMMANDS.map((command) => `/${command.name} - ${command.hint}`).join(
                "\n"
              )
          );
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case "branches":
          setInput("");
          setSessionDrawerOpen(true);
          setError("移动端可从左侧会话列表切换历史任务；分支详情请在桌面端查看。");
          break;
        case "system":
          setInput("");
          setError("System prompt 详情暂在桌面端查看，移动端保留任务执行和确认能力。");
          break;
        case "auth":
          setInput("");
          setError("凭证管理请在桌面端设置中完成，移动端会同步使用已配置的模型。");
          break;
      }
    },
    [closeAutocomplete, compactContext, startNew]
  );

  const refreshAutocomplete = useCallback(
    async (text: string, caret: number) => {
      const token = detectMobileAutocompleteToken(text, caret);
      if (!token) {
        closeAutocomplete();
        return;
      }
      acTriggerPosRef.current = token.triggerPos;
      setAcMode(token.mode);
      setAcIndex(0);
      if (token.mode === "/") {
        const q = token.query.toLowerCase();
        setAcItems(
          SLASH_COMMANDS.filter((command) => command.name.startsWith(q)).map(
            (command) => ({
              label: `/${command.name}`,
              hint: command.hint,
              value: `/${command.name}`,
            })
          )
        );
        return;
      }

      const cwd = selected?.cwd || status?.defaultCwd || "";
      if (!cwd) {
        setAcItems([]);
        return;
      }
      try {
        const now = Date.now();
        const cached = filesCacheRef.current.get(cwd);
        const entries =
          cached && now - cached.ts < MOBILE_FILES_CACHE_TTL_MS
            ? cached.entries
            : await (async () => {
                const res = await apiFetch(
                  `/api/files?path=${encodeURIComponent(cwd)}`
                );
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.error) {
                  throw new Error(data.error ?? res.statusText);
                }
                const nextEntries: MobileFileEntry[] = Array.isArray(data.entries)
                  ? data.entries
                  : [];
                filesCacheRef.current.set(cwd, { ts: now, entries: nextEntries });
                return nextEntries;
              })();
        setAcItems(buildMobileFileItems(entries, cwd, token.query));
      } catch {
        setAcItems([]);
      }
    },
    [apiFetch, closeAutocomplete, selected?.cwd, status?.defaultCwd]
  );

  const applyAutocomplete = useCallback(
    (item: AutocompleteItem) => {
      const mode = acMode;
      const triggerPos = acTriggerPosRef.current;
      if (triggerPos < 0) {
        closeAutocomplete();
        return;
      }
      const textarea = inputRef.current;
      const caret = textarea?.selectionStart ?? input.length;
      const before = input.slice(0, triggerPos);
      const after = input.slice(caret);
      const insert = `${item.value} `;
      const next = before + insert + after;
      setInput(next);
      closeAutocomplete();
      if (mode === "/" && item.value.startsWith("/")) {
        const name = item.value.slice(1) as SlashName;
        if (SLASH_COMMANDS.some((command) => command.name === name)) {
          runMobileSlashCommand(name);
          return;
        }
      }
      requestAnimationFrame(() => {
        const nextCaret = before.length + insert.length;
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [acMode, closeAutocomplete, input, runMobileSlashCommand]
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!acMode || acItems.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAcIndex((index) => (index + 1) % acItems.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setAcIndex((index) => (index - 1 + acItems.length) % acItems.length);
      } else if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        const item = acItems[acIndex] ?? acItems[0];
        if (item) applyAutocomplete(item);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeAutocomplete();
      }
    },
    [acItems, acIndex, acMode, applyAutocomplete, closeAutocomplete]
  );

  const messages = chatState.messages;
  const hiddenBeforeCount = Math.max(0, messages.length - visibleMessageWindow);
  const renderedMessages = messages.slice(hiddenBeforeCount);
  const visibleSessions = sessions.slice(0, visibleSessionCount);
  const hasMoreSessions = visibleSessionCount < sessions.length;
  const pendingBlockers = getPendingMobileBlockers(messages);
  const effectiveAgentRunning =
    agentRunning ||
    Boolean(
      agentId &&
        status?.activeAgents?.some(
          (agent) =>
            agent.id === agentId &&
            (agent.runtimeState === "streaming" || agent.isStreaming)
        )
    );

  useEffect(() => {
    if (!pendingBlockers.key) return;
    scrollMessagesToBottom();
  }, [pendingBlockers.key, scrollMessagesToBottom]);

  useEffect(() => {
    if (!effectiveAgentRunning || autoScrollPaused) return;
    scrollMessagesToBottom();
  }, [autoScrollPaused, chatState.messages, effectiveAgentRunning, scrollMessagesToBottom]);

  if (!remote) {
    return (
      <main className="mobile-safe-screen mobile-safe-top mobile-safe-bottom flex items-center justify-center bg-[color:var(--bg)] px-5 text-[color:var(--text)]">
        <div className="max-w-sm rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-5">
          <h1 className="text-lg font-semibold">
            {error ? "需要重新配对" : "配对中，请稍作等待"}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--text-muted)]">
            {error || "正在等待桌面端确认连接，完成后会自动进入移动端。"}
          </p>
        </div>
      </main>
    );
  }

  const statusText = mobileConnectionText({
    connection,
    hasAgent: Boolean(agentId),
    running: effectiveAgentRunning,
    blockerCount: pendingBlockers.count,
    error,
    baseUrl,
  });
  const authedProviders = providers.filter((provider) => provider.hasAuth);
  const rawSelectableProviders =
    authedProviders.length > 0 ? authedProviders : providers;
  const selectableProviders = curateProviderModels(rawSelectableProviders);
  const currentProvider =
    selectableProviders.find((provider) => provider.provider === providerId) ??
    selectableProviders[0];
  const currentModels = currentProvider?.models ?? [];
  const hasSelectableModel = Boolean(currentProvider && currentModels.length > 0);
  const currentModel =
    currentModels.find((model) => model.id === modelId) ?? currentModels[0];
  const currentModelLabel = currentModel
    ? (getCuratedModelLabel(currentProvider?.provider ?? "", currentModel.id) ??
      currentModel.name ??
      currentModel.id)
    : "未选择模型";
  const modelOptions = selectableProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      label: `${provider.displayName || provider.provider} · ${model.name || model.id}`,
      providerId: provider.provider,
      modelId: model.id,
      providerLabel: provider.displayName || provider.provider,
      modelLabel: model.name || model.id,
      reasoning: model.reasoning,
    }))
  );
  const orderedModelOptions = modelOptions;
  const composerCompact = composerFocused && keyboardCompact;

  return (
    <MobileSubagentControlsContext.Provider
      value={{
        retryTask: subagentRetryTask,
        resumeBatch: subagentResumeBatch,
        openSession: subagentOpenSession,
      }}
    >
    <main className="mobile-safe-screen flex min-w-0 flex-col overflow-hidden bg-[color:var(--bg)] text-[color:var(--text)]">
      <header className="mobile-safe-top shrink-0 border-b border-[color:var(--border)] bg-[color:var(--bg-panel)] px-3 pb-2">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
          <div className="contents">
            <button
              type="button"
              onClick={() => setSessionDrawerOpen(true)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[color:var(--border)] text-[color:var(--text-muted)] md:hidden"
              title="会话"
            >
              <Menu size={16} />
            </button>
            <div className="min-w-0 overflow-hidden">
              <div className="truncate text-sm font-semibold">Diga Agent Mobile</div>
              <div
                className="block max-w-full truncate text-token-xs text-[color:var(--text-muted)]"
                title={`${baseUrl || "未连接"} · ${mobileBaseLabel(baseUrl)}`}
              >
                {baseUrl || "未连接"} · {mobileBaseLabel(baseUrl)}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {taskDashboard.inboxCount > 0 ? (
              <span className="inline-flex max-w-[82px] items-center gap-1 rounded-[var(--badge-radius)] border border-[color:var(--color-warning)] bg-[color:var(--color-warning-bg)] px-2 py-1 text-token-xs text-[color:var(--color-warning)]">
                <ShieldAlert size={12} />
                <span className="truncate">{taskDashboard.inboxCount} 待办</span>
              </span>
            ) : null}
            <span className="inline-flex max-w-[92px] items-center gap-1 rounded border border-[color:var(--border-soft)] px-2 py-1 text-token-xs">
              {connection === "connected" ? (
                <Circle size={9} className="fill-[color:var(--color-success)] text-[color:var(--color-success)]" />
              ) : connection === "reconnecting" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <WifiOff size={12} />
              )}
              <span className="truncate">{statusText}</span>
            </span>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="rounded border border-[color:var(--border)] p-1.5"
              title="刷新"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
      </header>

      <div className="relative grid min-h-0 min-w-0 flex-1 md:grid-cols-[300px_minmax(0,1fr)]">
        <button
          type="button"
          aria-label="关闭会话列表"
          onClick={() => setSessionDrawerOpen(false)}
          className={`fixed inset-0 z-30 transition-opacity md:hidden ${
            sessionDrawerOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          style={{ background: "var(--color-overlay)" }}
        />
        <aside
          className={`mobile-safe-drawer fixed inset-y-0 left-0 z-40 flex w-[min(84vw,330px)] min-h-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-panel)] shadow-modal transition-transform duration-200 ease-out md:static md:z-auto md:w-auto md:translate-x-0 md:shadow-none ${
            sessionDrawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--bg-panel)] px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">会话</div>
                  <div className="text-token-xs text-[color:var(--text-muted)]">
                {sessions.length} 个历史任务
                {taskDashboard.inboxCount > 0
                  ? ` · ${taskDashboard.inboxCount} 个待处理`
                  : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={startNew}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[color:var(--accent)]"
              style={{ color: "var(--color-bg)" }}
              title="新建任务"
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              onClick={() => setSessionDrawerOpen(false)}
              className="rounded border border-[color:var(--border)] p-1.5 text-[color:var(--text-muted)] md:hidden"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
          <div
            className="min-h-0 flex-1 space-y-1 overflow-auto p-2"
            onScroll={onSessionListScroll}
          >
            {visibleSessions.map((session) => {
              const waitingUser = session.runtimeState === "waiting_user";
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => void selectSession(session)}
                  className={`block w-full rounded border px-2 py-2 text-left text-xs ${
                    selected?.id === session.id
                      ? "border-[color:var(--accent)] bg-[color:var(--bg-selected)]"
                      : "border-[color:var(--border-soft)] hover:bg-[color:var(--bg-hover)]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    {waitingUser ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-warning)]" />
                    ) : session.isRunning ? (
                      <Loader2 size={12} className="shrink-0 animate-spin text-[color:var(--accent)]" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {session.meta?.title || session.name || session.firstMessage || "(未命名)"}
                    </span>
                    {waitingUser ? (
                      <span className="shrink-0 rounded-full bg-[color:var(--color-warning-bg)] px-1.5 py-0.5 text-token-xs text-[color:var(--color-warning)]">
                        需确认
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="mt-1 truncate text-token-xs text-[color:var(--text-muted)]"
                    title={session.cwd}
                  >
                    {compactPath(session.cwd)}
                  </div>
                </button>
              );
            })}
            {hasMoreSessions ? (
              <button
                type="button"
                onClick={() =>
                  setVisibleSessionCount((prev) =>
                    Math.min(sessions.length, prev + MOBILE_SESSION_PAGE_SIZE)
                  )
                }
                className="block w-full rounded border border-dashed border-[color:var(--border-soft)] px-2 py-2 text-center text-xs text-[color:var(--text-muted)]"
              >
                加载更多历史会话
              </button>
            ) : null}
          </div>
        </aside>

        <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
          {error ? (
            <div className="border-b border-[color:var(--color-danger)] bg-[color:var(--color-danger-bg)] px-3 py-2 text-xs text-[color:var(--color-danger)]">
              {error}
            </div>
          ) : null}
          {pendingBlockers.count > 0 ? (
            <button
              type="button"
              onClick={resumeAutoScrollToBottom}
              className="flex shrink-0 items-center gap-2 border-b border-[color:var(--color-warning)] bg-[color:var(--color-warning-bg)] px-3 py-2 text-left text-xs text-[color:var(--color-warning)]"
            >
              <ShieldAlert size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                需要你处理：
                {pendingBlockers.approvals > 0
                  ? `${pendingBlockers.approvals} 个授权确认`
                  : ""}
                {pendingBlockers.approvals > 0 && pendingBlockers.clarifications > 0
                  ? "，"
                  : ""}
                {pendingBlockers.clarifications > 0
                  ? `${pendingBlockers.clarifications} 个补充问题`
                  : ""}
              </span>
              <span className="shrink-0">查看</span>
            </button>
          ) : null}
          {mobileGoal ? (
            <MobileGoalStrip
              goal={mobileGoal}
              disabled={busy}
              onPause={() => void runGoalAction("goal_pause")}
              onResume={() => void runGoalAction("goal_resume")}
              onClear={() => void runGoalAction("goal_clear")}
            />
          ) : null}
          <div
            ref={messagesScrollRef}
            data-mobile-messages-scroll="true"
            onScroll={handleMessagesScroll}
            className="min-h-0 min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-5 py-4 pb-5 sm:px-6"
          >
            {sessionLoadingId ? (
              <div className="flex min-h-full items-center justify-center">
                <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2 text-xs text-[color:var(--text-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  <span>正在打开会话…</span>
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center py-6 text-center">
                <div className="w-full space-y-5">
                  <div className="flex flex-col items-center gap-3">
                    <BrandLogo size={54} />
                    <div className="min-w-0 pt-1">
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <h1 className="text-xl font-semibold tracking-tight">
                          Diga Agent
                        </h1>
                        <span className="rounded-full border border-[color:var(--border-soft)] px-2 py-0.5 text-token-xs text-[color:var(--text-muted)]">
                          Mobile
                        </span>
                      </div>
                    </div>
                  </div>

                  <MobileTaskInbox
                    dashboard={taskDashboard}
                    sessions={sessions}
                    onFindingStatus={(id, nextStatus) =>
                      void updateFindingStatus(id, nextStatus)
                    }
                    onOpenRunSession={openTaskRunSession}
                  />

                  <div className="grid gap-2">
                    {MOBILE_STARTERS.map((starter, index) => {
                      const Icon =
                        index === 0 ? Sparkles : index === 1 ? TerminalSquare : Layers3;
                      return (
                        <button
                          key={starter.title}
                          type="button"
                          onClick={() => applyStarter(starter)}
                          disabled={busy || sending}
                          className="group flex w-full items-start gap-3 rounded-xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-3 text-left transition-colors hover:bg-[color:var(--bg-hover)] disabled:opacity-60"
                        >
                          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--bg)] text-[color:var(--accent)]">
                            <Icon size={15} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-[color:var(--text)]">
                              {starter.title}
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-[color:var(--text-muted)]">
                              {starter.body}
                            </span>
                          </span>
                          <span className="mt-1 shrink-0 rounded-full border border-[color:var(--border-soft)] px-2 py-0.5 text-token-xs text-[color:var(--text-muted)]">
                            发送
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <MobileTaskInbox
                  dashboard={taskDashboard}
                  sessions={sessions}
                  onFindingStatus={(id, nextStatus) =>
                    void updateFindingStatus(id, nextStatus)
                  }
                  onOpenRunSession={openTaskRunSession}
                />
                {hiddenBeforeCount > 0 || hasMoreHistoryBefore ? (
                  <button
                    type="button"
                    onClick={() => void loadEarlierMessages()}
                    disabled={historyLoading}
                    className="mx-auto block rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-1.5 text-xs text-[color:var(--text-muted)] active:bg-[color:var(--bg-hover)]"
                  >
                    {historyLoading
                      ? "正在加载更早内容…"
                      : hiddenBeforeCount > 0
                        ? `加载更早的 ${hiddenBeforeCount} 条`
                        : "加载更早内容"}
                  </button>
                ) : null}
                {renderedMessages.map((message, index) => (
                  <MobileChatMessage
                    key={hiddenBeforeCount + index}
                    message={message}
                    input={input}
                    approve={approve}
                    deny={deny}
                    clarify={clarify}
                  />
                ))}
              </>
            )}
          </div>
          {autoScrollPaused && messages.length > 0 ? (
            <button
              type="button"
              onClick={resumeAutoScrollToBottom}
              className="absolute bottom-[132px] right-5 z-20 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-1.5 text-xs text-[color:var(--text-muted)] shadow-lg active:bg-[color:var(--bg-hover)]"
            >
              回到底部
            </button>
          ) : null}
          <footer
            className={`shrink-0 border-t border-[color:var(--border)] bg-[color:var(--bg)] px-5 sm:px-6 ${
              composerCompact ? "pb-1 pt-1" : "mobile-safe-bottom pt-2"
            }`}
            style={{
              transform:
                keyboardInset > MOBILE_KEYBOARD_THRESHOLD_PX
                  ? `translate3d(0, -${keyboardInset}px, 0)`
                  : undefined,
              transition:
                keyboardInset > MOBILE_KEYBOARD_THRESHOLD_PX
                  ? "transform 120ms ease-out"
                  : undefined,
            }}
          >
            {pendingImages.length > 0 ? (
              <div
                className={`mb-2 flex gap-2 overflow-x-auto pb-1 ${
                  composerCompact ? "max-h-12" : ""
                }`}
              >
                {pendingImages.map((image, index) => (
                  <div
                    key={`${image.mimeType}-${index}`}
                    className={`relative shrink-0 overflow-hidden rounded-xl border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] ${
                      composerCompact ? "h-11 w-11" : "h-14 w-14"
                    }`}
                    title={`${image.mimeType} · ${formatBytes(approxBase64Bytes(image.data))}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt={`待发送图片 ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(index)}
                      className="absolute right-0 top-0 inline-flex h-5 w-5 items-center justify-center text-token-xs"
                      style={{
                        background: "color-mix(in srgb, var(--color-overlay) 65%, transparent)",
                        color: "var(--color-bg)",
                      }}
                      title="移除图片"
                    >
                      <X size={12} />
                    </button>
                    <div
                      className="absolute inset-x-0 bottom-0 truncate px-1 text-token-xs"
                      style={{
                        background: "color-mix(in srgb, var(--color-overlay) 55%, transparent)",
                        color: "var(--color-bg)",
                      }}
                    >
                      {formatBytes(approxBase64Bytes(image.data))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div
              className={`border border-[color:var(--border)] bg-[color:var(--bg-panel)] shadow-popover transition-colors focus-within:border-[color:var(--accent)] ${
                composerCompact
                  ? "rounded-full px-2 py-1.5"
                  : "rounded-full px-2.5 py-2"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  setAttachmentSheetOpen(false);
                  if (e.target.files && e.target.files.length > 0) {
                    void addImageFiles(e.target.files);
                  }
                  e.target.value = "";
                }}
              />
              {acMode ? (
                <MobileAutocompletePanel
                  mode={acMode}
                  items={acItems}
                  selectedIndex={acIndex}
                  onPick={applyAutocomplete}
                  onHover={setAcIndex}
                />
              ) : null}
              <div className="min-w-0">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    const next = e.target.value;
                    setInput(next);
                    void refreshAutocomplete(
                      next,
                      e.currentTarget.selectionStart ?? next.length
                    );
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onClick={(e) =>
                    void refreshAutocomplete(
                      input,
                      e.currentTarget.selectionStart ?? input.length
                    )
                  }
                  onSelect={(e) =>
                    void refreshAutocomplete(
                      input,
                      e.currentTarget.selectionStart ?? input.length
                    )
                  }
                  onFocus={focusComposer}
                  onBlur={blurComposer}
                  placeholder={selected ? "继续修改、验收反馈或新指令…" : "发布一个新任务…"}
                  rows={1}
                  className={`w-full resize-none overflow-y-auto bg-transparent px-3 text-token-mobile leading-6 outline-none placeholder:text-[color:var(--text-dim)] ${
                    composerCompact
                      ? "max-h-[112px] min-h-9 py-1.5"
                      : "max-h-[180px] min-h-11 py-2.5"
                  }`}
                />
              </div>
              <div
                className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 ${
                  composerCompact ? "mt-0" : "mt-1"
                }`}
              >
                <div className="min-w-0 text-token-xs">
                  {pendingImages.length > 0 ? (
                    <span className="block truncate text-[color:var(--text-muted)]">
                      {pendingImages.length} 张图片
                    </span>
                  ) : (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setModelSheetOpen(true)}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-2 py-1 text-token-xs text-[color:var(--text-muted)] active:bg-[color:var(--bg-hover)]"
                      title="模型配置"
                    >
                      <Settings2 size={12} className="shrink-0" />
                      <span className="truncate">
                        {hasSelectableModel
                          ? currentModelLabel
                          : "配置模型"}
                      </span>
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAttachmentSheetOpen(true)}
                    className={`inline-flex shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg)] text-[color:var(--text-muted)] transition-colors active:bg-[color:var(--bg-hover)] ${
                      composerCompact ? "h-9 w-9" : "h-10 w-10"
                    }`}
                    title="上传图片"
                  >
                    <Plus size={18} />
                  </button>
                  <button
                    type="button"
                    disabled={
                      !effectiveAgentRunning &&
                      (busy || sending || (!input.trim() && pendingImages.length === 0))
                    }
                    onClick={() => void (effectiveAgentRunning ? abort() : send())}
                    className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] shadow-sm transition-colors disabled:cursor-not-allowed disabled:bg-[color:var(--bg-hover)] disabled:text-[color:var(--text-dim)] disabled:shadow-none ${
                      composerCompact ? "h-9 w-9" : "h-10 w-10"
                    }`}
                    style={{ color: "var(--color-bg)" }}
                    title={effectiveAgentRunning ? "停止" : "发送"}
                  >
                    {(busy || sending) && !effectiveAgentRunning ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : effectiveAgentRunning ? (
                      <Square size={15} className="fill-current" />
                    ) : (
                      <Send size={15} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </footer>
          {modelSheetOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-end"
              style={{ background: "var(--color-overlay)" }}
            >
              <button
                type="button"
                aria-label="关闭模型配置"
                onClick={() => setModelSheetOpen(false)}
                className="absolute inset-0"
              />
              <div className="mobile-safe-bottom relative z-10 max-h-[560px] w-full overflow-hidden rounded-t-[var(--radius-sheet)] border border-[color:var(--border)] bg-[color:var(--bg)] shadow-modal">
                <div className="flex items-center gap-2 border-b border-[color:var(--border)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">模型配置</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setModelSheetOpen(false)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] text-[color:var(--text-muted)]"
                    title="关闭"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="max-h-[420px] overflow-y-auto px-2 py-2">
                  {modelOptions.length === 0 ? (
                    <div className="rounded-token-lg border border-dashed border-[color:var(--border)] px-3 py-4 text-center text-sm text-[color:var(--text-muted)]">
                      请先在桌面端配置可用模型。
                    </div>
                  ) : (
                    orderedModelOptions.map((option) => {
                      const selectedModel =
                        option.providerId === providerId &&
                        option.modelId === modelId;
                      return (
                        <button
                          key={`${option.providerId}:${option.modelId}`}
                          type="button"
                          onClick={() => {
                            void changeModel(option.providerId, option.modelId);
                            setModelSheetOpen(false);
                          }}
                          className={`flex w-full items-center gap-3 rounded-token-lg border px-3 py-3 text-left ${
                            selectedModel
                              ? "border-[color:var(--accent)] bg-[color:var(--bg-selected)]"
                              : "border-transparent active:bg-[color:var(--bg-hover)]"
                          }`}
                        >
                          <span
                            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                              selectedModel
                                ? "border-[color:var(--accent)] bg-[color:var(--accent)]"
                                : "border-[color:var(--border)] text-transparent"
                            }`}
                            style={selectedModel ? { color: "var(--color-bg)" } : undefined}
                          >
                            <Check size={12} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {option.modelLabel}
                            </span>
                            <span className="mt-0.5 block truncate text-token-xs text-[color:var(--text-muted)]">
                              {option.providerLabel}
                              {option.reasoning ? " · 支持思考" : ""}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {attachmentSheetOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-end"
              style={{ background: "var(--color-overlay)" }}
            >
              <button
                type="button"
                aria-label="关闭附件"
                onClick={() => setAttachmentSheetOpen(false)}
                className="absolute inset-0"
              />
              <div className="mobile-safe-bottom relative z-10 w-full overflow-hidden rounded-t-[var(--radius-sheet)] border border-[color:var(--border)] bg-[color:var(--bg)] shadow-modal">
                <div className="flex items-center gap-2 border-b border-[color:var(--border)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">添加内容</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttachmentSheetOpen(false)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] text-[color:var(--text-muted)]"
                    title="关闭"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAttachmentSheetOpen(false);
                      window.setTimeout(() => fileInputRef.current?.click(), 0);
                    }}
                    className="flex w-full items-center gap-3 rounded-token-lg border border-transparent px-3 py-3 text-left active:bg-[color:var(--bg-hover)]"
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] text-[color:var(--text-muted)]">
                      <Plus size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        上传图片
                      </span>
                      <span className="mt-0.5 block truncate text-token-xs text-[color:var(--text-muted)]">
                        支持一次选择多张图片
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
    </MobileSubagentControlsContext.Provider>
  );
}
