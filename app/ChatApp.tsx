"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionInfoLite,
  ChatMessage,
  MessagePart,
  ProviderInfo,
  ProvidersResponse,
  ThinkingLevel,
  ImageContentLite,
  ForkableUserMessage,
} from "@/lib/types";
import { THINKING_LEVEL_LABELS } from "@/lib/types";
import {
  extractImagesFromClipboard,
  approxBase64Bytes,
  formatBytes,
} from "@/lib/image-utils";
import { getElectronApi, type AppInfo } from "@/lib/electron-bridge";
import { useAudio } from "@/lib/use-audio";
import { useDragDrop } from "@/lib/use-drag-drop";
import { previewStore } from "@/lib/preview-store";
import {
  createInitialState,
  ctxToMessages,
  type ReducerState,
} from "@/lib/chat-reducer";
import {
  emptyRunner,
  DRAFT_KEY,
  type RunnerKey,
} from "@/lib/session-runner";
import { useRunners } from "./hooks/useRunners";
import { useSseManager } from "./hooks/useSseManager";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useSessions } from "./hooks/useSessions";
import { useChatStream } from "./hooks/useChatStream";
import { useComposerAttachments } from "./hooks/useComposerAttachments";
import { usePetPusher } from "./hooks/usePetPusher";
import { useForkable } from "./hooks/useForkable";
import Markdown from "./components/Markdown";
import ToolRender from "./components/ToolRender";
import FileBrowser from "./components/FileBrowser";
import ImageLightbox from "./components/ImageLightbox";
import SidebarExplorer from "./components/SidebarExplorer";
import BranchesPopover from "./components/BranchesPopover";
import SkillsPanel from "./components/SkillsPanel";
import ToolsPanel from "./components/ToolsPanel";
import AuthPanel from "./components/AuthPanel";
import ModelsConfigPanel from "./components/ModelsConfigPanel";
import { IconButton, iconSizeMap } from "./components/IconButton";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { Typewriter, TYPEWRITER_PHRASES } from "./components/Typewriter";
import { PillSelect } from "./components/PillSelect";
import { ProviderIcon } from "./components/ProviderIcon";
import { BrandLogo } from "./components/BrandLogo";
import {
  InputAutocomplete,
  type AutocompleteItem,
} from "./components/InputAutocomplete";
import {
  Sun,
  Moon,
  Plus,
  FolderOpen,
  Brain,
  Wrench,
  KeyRound,
  Settings,
  Image as ImageIcon,
  Target,
  AlertTriangle,
  Lightbulb,
  CornerDownLeft,
  PanelLeft,
  PanelRight,
  GitBranch,
  FileText,
  Cpu,
  Volume2,
  VolumeX,
  Minimize2,
  Folder,
  FileArchive,
  FileSpreadsheet,
  FileCode,
  Paperclip,
  X,
} from "lucide-react";

interface Props {
  initialSessions: SessionInfoLite[];
  defaultCwd: string;
}

type Theme = "dark" | "light";

/**
 * 内置 slash 命令清单。
 * action 在 ChatApp 内绑定真实回调。
 */
const SLASH_COMMANDS = [
  { name: "clear", hint: "新开 session" },
  { name: "compact", hint: "压缩当前 session 上下文" },
  { name: "branches", hint: "查看分支" },
  { name: "system", hint: "查看 system prompt" },
  { name: "models", hint: "Models 配置" },
  { name: "auth", hint: "凭证管理" },
  { name: "help", hint: "查看支持的命令" },
] as const;

type SlashName = (typeof SLASH_COMMANDS)[number]["name"];

/**
 * 检测光标处的触发 token：返回 { mode, query, triggerPos }。
 * 触发条件：紧邻光标向左找到 `@` 或 `/`，且其左侧是行首/空白/换行。
 * `/` 仅在文本最前面（光标 ≤ 第一个非空白后）才算 slash 命令。
 */
function detectAutocompleteToken(
  text: string,
  caret: number
): { mode: "@" | "/"; query: string; triggerPos: number } | null {
  if (caret <= 0) return null;
  // 向左扫描直到遇到空白/换行/@//
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@" || ch === "/") break;
    if (/\s/.test(ch)) return null;
    i--;
  }
  if (i < 0) return null;
  const trigger = text[i];
  // 左侧必须是行首或空白；slash 命令只在整段输入开头才触发
  const leftOk = i === 0 || /\s/.test(text[i - 1]);
  if (!leftOk) return null;
  if (trigger === "/") {
    // 只允许全文以 /xxx 开头（前面只能有空白）
    if (text.slice(0, i).trim() !== "") return null;
    return { mode: "/", query: text.slice(i + 1, caret), triggerPos: i };
  }
  return { mode: "@", query: text.slice(i + 1, caret), triggerPos: i };
}

/** 流式 phase：用于在最后一条 assistant 顶上显示 "Thinking…/Waiting/Running tool…" */
type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "thinking" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export default function ChatApp({ initialSessions, defaultCwd }: Props) {
  // setError 需要在 useSessions（B1）之前声明，作为 onError 回调注入。
  // 顶层 error 用于 UI banner 展示；useState setter 身份稳定，可安全提前。
  const [error, setError] = useState<string | null>(null);

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
    onEvict: closeSseFor,
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
    };
  }, [runnersRef, activeKeyRef]);

  // ===== Session 列表 + 已读追踪 + CRUD（RFC-1 阶段 B1） =====
  // 持有 sessions / selectedId / lastSeenMap（localStorage 持久化，lazy init 修复刷新已读丢失）；
  // 提供 groupedSessions / refreshSessions / submitRename / executeDeleteSession 等。
  const {
    sessions,
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
  // ===== 输入框 @ / 自动补全(全局,不分会话) =====
  const [acMode, setAcMode] = useState<"@" | "/" | null>(null);
  const [acQuery, setAcQuery] = useState("");
  const [acItems, setAcItems] = useState<AutocompleteItem[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  /** 触发字符在 input 中的绝对索引（含 @ 或 /） */
  const acTriggerPosRef = useRef<number>(-1);
  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();
  const [cwd, setCwd] = useState(defaultCwd);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 图片/文件附件相关 hook 调用挪到 setter wrappers 之后（依赖 setPendingImages/setPendingFiles）

  // provider/model 选择
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // provider/model 选择持久化:用户切过模型后,刷新/重启都保留;
  // 仅当 localStorage 没值时才用后端 defaultProvider/defaultModelId 兜底。
  const [providerId, setProviderId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("pi-provider-id") ?? "";
  });
  const [modelId, setModelId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("pi-model-id") ?? "";
  });
  useEffect(() => {
    if (providerId) localStorage.setItem("pi-provider-id", providerId);
  }, [providerId]);
  useEffect(() => {
    if (modelId) localStorage.setItem("pi-model-id", modelId);
  }, [modelId]);

  // thinking 字段(thinkingLevel / availableThinkingLevels / supportsThinking)
  // 已挪到 RunnerState。见下方 activeSnapshot 解构区。

  // theme（首屏由 layout 里的 inline script 设置）
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const t =
      (document.documentElement.getAttribute("data-theme") as Theme) ?? "dark";
    setTheme(t);
  }, []);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("pi-theme", next);
    } catch {
      /* noop */
    }
  };

  // 右侧抽屉：files | skills | tools | null（互斥，localStorage 持久化）
  const [rightPanel, setRightPanel] = useState<
    "files" | "skills" | "tools" | null
  >(null);

  // 右侧 panel 宽度（仅 files/tools 用 inline 形态需要，skills 是 modal）
  const [rightPanelWidth, setRightPanelWidth] = useState(480);
  /** FileBrowser 内部折叠状态:不再影响外层宽度,仅 56px 极窄态特殊处理
   *  (FileBrowser 内部用 flex:1 自适应,外层一直用 rightPanelWidth) */
  const [filesLayout, setFilesLayout] = useState<{
    treeCollapsed: boolean;
    viewerHidden: boolean;
  }>({ treeCollapsed: false, viewerHidden: false });
  /** 两侧都收起时容器收成 56px 窄条,其它情况都用 rightPanelWidth */
  const filesContainerWidth =
    filesLayout.viewerHidden && filesLayout.treeCollapsed
      ? 56
      : rightPanelWidth;
  useEffect(() => {
    try {
      const stored = localStorage.getItem("rightPanelWidth");
      if (stored) {
        const n = Number(stored);
        if (Number.isFinite(n) && n >= 320) setRightPanelWidth(n);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("rightPanelWidth", String(rightPanelWidth));
    } catch {}
  }, [rightPanelWidth]);
  const splitterDragRef = useRef<{ startX: number; startW: number } | null>(
    null
  );
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    splitterDragRef.current = {
      startX: e.clientX,
      startW: rightPanelWidth,
    };
    const onMove = (ev: MouseEvent) => {
      const ref = splitterDragRef.current;
      if (!ref) return;
      const dx = ref.startX - ev.clientX;
      const max = Math.max(320, window.innerWidth * 0.8);
      const next = Math.min(max, Math.max(320, ref.startW + dx));
      setRightPanelWidth(next);
    };
    const onUp = () => {
      splitterDragRef.current = null;
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
  const [showAuth, setShowAuth] = useState(false);
  const [showModelsConfig, setShowModelsConfig] = useState(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showCwdPicker, setShowCwdPicker] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [systemPromptText, setSystemPromptText] = useState<string | null>(
    null
  );
  // sseStatus 已挪到 RunnerState(每个会话独立的 SSE 状态)。
  // forksCollapsed / toggleForks 已挪到 useForkable hook（C1）
  /** 当前打开 ⋯ 菜单的 session id；renaming 时存 inline edit 状态 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem("pi-right-panel");
      if (v === "files" || v === "skills" || v === "tools") setRightPanel(v);
      else if (localStorage.getItem("pi-show-files") === "1") {
        setRightPanel("files");
      }
    } catch {
      /* noop */
    }
  }, []);
  const persistRightPanel = (
    v: "files" | "skills" | "tools" | null
  ) => {
    try {
      if (v) localStorage.setItem("pi-right-panel", v);
      else localStorage.removeItem("pi-right-panel");
    } catch {
      /* noop */
    }
  };
  const toggleFiles = () => {
    setRightPanel((prev) => {
      const next = prev === "files" ? null : "files";
      persistRightPanel(next);
      return next;
    });
  };
  const toggleSkills = () => {
    setRightPanel((prev) => {
      const next = prev === "skills" ? null : "skills";
      persistRightPanel(next);
      return next;
    });
  };
  const toggleTools = () => {
    setRightPanel((prev) => {
      const next = prev === "tools" ? null : "tools";
      persistRightPanel(next);
      // 关闭时刷新计数（用户可能改了启用集合）
      if (prev === "tools" && agentId) void refreshToolsCount(agentId);
      return next;
    });
  };
  const showFiles = rightPanel === "files";
  const showSkills = rightPanel === "skills";
  const showTools = rightPanel === "tools";

  // 任何 previewStore 触发(html/url/image)时,确保右侧 FileBrowser 展开
  useEffect(() => {
    return previewStore.onOpen(() => {
      setRightPanel((prev) => {
        if (prev === "files") return prev;
        try {
          localStorage.setItem("pi-right-panel", "files");
        } catch {}
        return "files";
      });
    });
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Electron 桥
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const electronApi = useMemo(
    () => (appInfo ? getElectronApi() : null),
    [appInfo]
  );
  useEffect(() => {
    const api = getElectronApi();
    if (!api) return;
    void api
      .getAppInfo()
      .then(setAppInfo)
      .catch((e) => console.warn("getAppInfo failed", e));
  }, []);

  // currentSessionFile 已挪到 RunnerState.sessionFile(下方解构提供同名别名)。

  // 启动时拉 providers
  // applyDefaults 时:优先尊重当前 state(来自 localStorage),仅当为空或失效才用后端 default
  const reloadProviders = useCallback((applyDefaults: boolean) => {
    void fetch("/api/providers")
      .then((r) => r.json() as Promise<ProvidersResponse>)
      .then((data) => {
        if (!data.providers) return;
        setProviders(data.providers);
        if (!applyDefaults) return;
        // 用 setter 拿当前值判断,避免把 providerId/modelId 写进 useCallback 依赖
        setProviderId((curProv) => {
          setModelId((curModel) => {
            const provExists = data.providers.some(
              (p) => p.provider === (curProv || "")
            );
            const modelExists =
              provExists &&
              data.providers
                .find((p) => p.provider === curProv)
                ?.models?.some((m) => m.id === curModel);
            // 当前选择仍然有效 → 不动
            if (provExists && modelExists) return curModel;
            // 失效或没值 → 落到后端 default
            if (data.defaultModelId) return data.defaultModelId;
            return curModel;
          });
          const provExists = data.providers.some(
            (p) => p.provider === (curProv || "")
          );
          if (provExists) return curProv;
          if (data.defaultProvider) return data.defaultProvider;
          return curProv;
        });
      })
      .catch((e) => console.warn("load providers failed", e));
  }, []);

  useEffect(() => {
    reloadProviders(true);
  }, [reloadProviders]);

  // 点外面关闭 session ⋯ 菜单
  useEffect(() => {
    if (!menuFor) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-session-menu]")) return;
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

  const currentProvider = useMemo(
    () => providers.find((p) => p.provider === providerId),
    [providers, providerId]
  );

  const visibleProviders = useMemo(
    () => providers.filter((p) => p.hasAuth),
    [providers]
  );

  // ===== 当前活跃 runner 的解构(P1-4)=====
  // 所有下游 callbacks/render 通过这些同名变量读取,行为与原 useState 完全一致。
  const {
    chatState,
    forkableUserMessages,
    forkingIndex,
    forkText,
    forkBusy,
    agentId,
    agentSessionId,
    sessionFile: currentSessionFile,
    input,
    pendingImages,
    pendingFiles,
    streaming,
    agentPhase,
    compacting,
    compactError,
    retryInfo,
    stats,
    toolsCount,
    thinkingLevel,
    availableThinkingLevels,
    supportsThinking,
    sseStatus,
  } = activeSnapshot;

  // ===== Setter wrappers(同名,所有调用点不动)=====
  // 通用 helper:把 React 风格的 setter (value | (prev) => value) 路由到 updateActive。
  // 为每个字段写一个 useCallback,保持稳定的函数 identity,避免下游误触发。
  type Updater<T> = T | ((prev: T) => T);
  const resolve = <T,>(prev: T, v: Updater<T>): T =>
    typeof v === "function" ? (v as (p: T) => T)(prev) : v;

  const setChatState = useCallback(
    (v: Updater<ReducerState>) =>
      updateActive((s) => ({ chatState: resolve(s.chatState, v) })),
    [updateActive]
  );
  const setForkableUserMessages = useCallback(
    (v: Updater<ForkableUserMessage[]>) =>
      updateActive((s) => ({
        forkableUserMessages: resolve(s.forkableUserMessages, v),
      })),
    [updateActive]
  );
  const setForkingIndex = useCallback(
    (v: Updater<number | null>) =>
      updateActive((s) => ({ forkingIndex: resolve(s.forkingIndex, v) })),
    [updateActive]
  );
  const setForkText = useCallback(
    (v: Updater<string>) =>
      updateActive((s) => ({ forkText: resolve(s.forkText, v) })),
    [updateActive]
  );
  // setForkBusy 已下沉到 useForkable hook（C1：fork 流程内 updateRunner 直接写）
  const setAgentId = useCallback(
    (v: Updater<string | null>) =>
      updateActive((s) => ({ agentId: resolve(s.agentId, v) })),
    [updateActive]
  );
  const setAgentSessionId = useCallback(
    (v: Updater<string | null>) =>
      updateActive((s) => ({ agentSessionId: resolve(s.agentSessionId, v) })),
    [updateActive]
  );
  const setCurrentSessionFile = useCallback(
    (v: Updater<string | null>) =>
      updateActive((s) => ({ sessionFile: resolve(s.sessionFile, v) })),
    [updateActive]
  );
  const setInput = useCallback(
    (v: Updater<string>) =>
      updateActive((s) => ({ input: resolve(s.input, v) })),
    [updateActive]
  );
  const setPendingImages = useCallback(
    (v: Updater<ImageContentLite[]>) =>
      updateActive((s) => ({ pendingImages: resolve(s.pendingImages, v) })),
    [updateActive]
  );
  const setPendingFiles = useCallback(
    (v: Updater<PendingAttachment[]>) =>
      updateActive((s) => ({ pendingFiles: resolve(s.pendingFiles, v) })),
    [updateActive]
  );
  const setStreaming = useCallback(
    (v: Updater<boolean>) =>
      updateActive((s) => ({ streaming: resolve(s.streaming, v) })),
    [updateActive]
  );
  const setAgentPhase = useCallback(
    (v: Updater<AgentPhase>) =>
      updateActive((s) => ({ agentPhase: resolve(s.agentPhase, v) })),
    [updateActive]
  );
  const setCompacting = useCallback(
    (v: Updater<boolean>) =>
      updateActive((s) => ({ compacting: resolve(s.compacting, v) })),
    [updateActive]
  );
  const setCompactError = useCallback(
    (v: Updater<string | null>) =>
      updateActive((s) => ({ compactError: resolve(s.compactError, v) })),
    [updateActive]
  );
  const setRetryInfo = useCallback(
    (
      v: Updater<{
        attempt: number;
        maxAttempts: number;
        errorMessage?: string;
      } | null>
    ) => updateActive((s) => ({ retryInfo: resolve(s.retryInfo, v) })),
    [updateActive]
  );
  const setStats = useCallback(
    (
      v: Updater<{
        input: number;
        output: number;
        cacheRead: number;
        total: number;
        cost: number;
        ctxTokens: number | null;
        ctxPct: number | null;
        ctxWindow: number | null;
      } | null>
    ) => updateActive((s) => ({ stats: resolve(s.stats, v) })),
    [updateActive]
  );
  const setToolsCount = useCallback(
    (v: Updater<{ active: number; total: number } | null>) =>
      updateActive((s) => ({ toolsCount: resolve(s.toolsCount, v) })),
    [updateActive]
  );
  const setThinkingLevelState = useCallback(
    (v: Updater<ThinkingLevel>) =>
      updateActive((s) => ({ thinkingLevel: resolve(s.thinkingLevel, v) })),
    [updateActive]
  );
  const setAvailableThinkingLevels = useCallback(
    (v: Updater<ThinkingLevel[]>) =>
      updateActive((s) => ({
        availableThinkingLevels: resolve(s.availableThinkingLevels, v),
      })),
    [updateActive]
  );
  const setSupportsThinking = useCallback(
    (v: Updater<boolean>) =>
      updateActive((s) => ({ supportsThinking: resolve(s.supportsThinking, v) })),
    [updateActive]
  );
  const setSseStatus = useCallback(
    (v: Updater<"idle" | "active" | "lost">) =>
      updateActive((s) => ({ sseStatus: resolve(s.sseStatus, v) })),
    [updateActive]
  );

  // ===== Composer 附件子模块（RFC-1 阶段 B2-b，已抽到 useComposerAttachments） =====
  // 图片/文件拖入、粘贴、移除：依赖 setPendingImages/setPendingFiles，必须在 setter wrappers 之后
  const {
    addImageFiles,
    removePendingImage,
    onDropFiles,
    removePendingFile,
  } = useComposerAttachments({
    setPendingImages,
    setPendingFiles,
    setError,
  });

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
      }
    },
    [addImageFiles]
  );

  // compactError 3 秒自动消失（原本贴在 useState 旁,现在挪到 wrapper 之后）
  useEffect(() => {
    if (!compactError) return;
    const id = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(id);
  }, [compactError, setCompactError]);

  // ===== 宠物状态推送（hook 化，见 app/hooks/usePetPusher.ts）=====
  usePetPusher({
    runnersRef,
    sessions,
    selectedId,
    lastSeenMapRef,
    lastSeenMap,
    activeSnapshot,
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
  }, [sessions]);

  /**
   * 把 forkableUserMessages 按顺序回填到 chatState.messages 里的 user message 上。
   * 假设：SDK 返回的列表顺序 == 前端展示的 user message 顺序。
   * 若数量不一致（比如刚发完一条但还没收到 agent_end 时拉的旧列表），多余的 user 不挂 entryId。
   */
  const messages = useMemo<ChatMessage[]>(() => {
    if (forkableUserMessages.length === 0) return chatState.messages;
    const out: ChatMessage[] = [];
    let cursor = 0;
    for (const m of chatState.messages) {
      if (m.role === "user" && cursor < forkableUserMessages.length) {
        out.push({ ...m, entryId: forkableUserMessages[cursor].entryId });
        cursor++;
      } else {
        out.push(m);
      }
    }
    return out;
  }, [chatState.messages, forkableUserMessages]);

  // 给 minimap 用：按 visible(user/assistant) 数量准备 ref 数组
  const visibleMessageCount = useMemo(
    () =>
      messages.filter((m) => m.role === "user" || m.role === "assistant")
        .length,
    [messages]
  );
  const messageRefs = useMessageRefs(visibleMessageCount);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  // 用户是否"贴底"：贴底时新内容自动跟随，往上滚一旦离开底部 64px 就停止跟随。
  const stickToBottomRef = useRef(true);
  // send 后锚定到刚发的 user 消息:记 send 时的 user 消息总数,
  // 等新 user 消息从 SSE 回来后扫到对应那条,把它滚到屏顶。
  // null = 不锚定(普通贴底跟随);number = 期望"这条 user 一出现就锚"
  const pendingPinUserCountRef = useRef<number | null>(null);
  // 锚定阶段:仅此期间渲染 60vh 底部占位,让最后一条 user 能被 scroll-to-top
  // 一旦锚定完成或被取消,移除占位,避免列表底部一大片空白可滚。
  const [pinSpacer, setPinSpacer] = useState(false);

  function handleMessagesScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceToBottom < 64;
    // 用户主动滚动 = 取消锚定意图(占位也跟着移除,见 effect)
    if (pendingPinUserCountRef.current !== null) {
      pendingPinUserCountRef.current = null;
      setPinSpacer(false);
    }
  }

  useEffect(() => {
    // 兜底:streaming 已结束还留着锚定/占位的话清掉,避免占位永久滞留
    if (!streaming && pendingPinUserCountRef.current !== null) {
      pendingPinUserCountRef.current = null;
      setPinSpacer(false);
    }
    // 优先级 1:有锚定目标 → 等那条 user 消息从 SSE 回来后锚到屏顶,只锚一次
    const targetCount = pendingPinUserCountRef.current;
    if (targetCount !== null) {
      // 走 visible(user/assistant) 顺序计算 user 在 refs 里的下标
      let visibleIdx = -1;
      let lastUserVisibleIdx = -1;
      let userCount = 0;
      for (const m of messages) {
        if (m.role === "user" || m.role === "assistant") {
          visibleIdx++;
          if (m.role === "user") {
            userCount++;
            lastUserVisibleIdx = visibleIdx;
          }
        }
      }
      if (userCount >= targetCount && lastUserVisibleIdx >= 0) {
        const el = messageRefs.current?.[lastUserVisibleIdx];
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          // 锚定完成 → 清意图 + 移除占位,列表底部回到"最后一条 + padding"
          pendingPinUserCountRef.current = null;
          setPinSpacer(false);
          return;
        }
      }
      // 目标消息还没到/ref 还没挂上,这一轮先不滚,等下一次 messages 更新再试
      return;
    }
    // 优先级 2:贴底时跟随新内容
    if (!stickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, messageRefs]);

  // 选已有 session(P1-8):
  //  - runnersRef 已有该 session 的 runner → 直接 switchTo(不动 SSE,后台流式继续)
  //  - 没有 → 冷启动:emptyRunner + fetch context 填 chatState + switchTo
  //          (不立即 attachSse;用户发送时 send() 会走 create-with-sessionPath 路径)
  useEffect(() => {
    if (!selectedId) return;
    setError(null);
    const sel = sessions.find((s) => s.id === selectedId);
    if (!sel) return;
    const key: RunnerKey = sel.path;

    if (runnersRef.current.has(key)) {
      // 已有 runner —— 直接切。后台 SSE 继续,切回时累积内容立即可见。
      switchTo(key);
      return;
    }

    // 冷启动:建空 runner,先切过去显示空(很快),再异步填 context
    const fresh = emptyRunner();
    fresh.sessionFile = sel.path;
    setRunner(key, fresh);
    switchTo(key);

    void fetch(`/api/sessions/${selectedId}/context`)
      .then((r) => r.json())
      .then((ctx) => {
        if (ctx.error) {
          setError(ctx.error);
          return;
        }
        updateRunner(key, {
          chatState: createInitialState(ctxToMessages(ctx.messages ?? [])),
          ...(Array.isArray(ctx.forkableUserMessages)
            ? {
                forkableUserMessages:
                  ctx.forkableUserMessages as ForkableUserMessage[],
              }
            : {}),
        });
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // 切完分支后从 session context 重建 chat state
  const reloadFromCurrentSession = useCallback(async () => {
    const sid = agentSessionId ?? selectedId;
    if (!sid) return;
    try {
      const r = await fetch(`/api/sessions/${sid}/context`);
      const ctx = await r.json();
      if (ctx.error) {
        setError(ctx.error);
        return;
      }
      setChatState(createInitialState(ctxToMessages(ctx.messages ?? [])));
      if (Array.isArray(ctx.forkableUserMessages)) {
        setForkableUserMessages(
          ctx.forkableUserMessages as ForkableUserMessage[]
        );
      }
      if (agentId) {
        void refreshStats(agentId);
        void refreshToolsCount(agentId);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [agentSessionId, selectedId, agentId]);

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
    [updateRunner]
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
    [updateRunner]
  );

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
  }, [sessions, attachSseFor]);

  /**
   * +New chat:
   * 1) 先确保 draft runner 存在(初始化已经建过,做兜底)
   * 2) 切到 draft —— 用户切走再切回时输入框/状态都还在
   * 3) 仍然 eager create 一个 agent 绑到 draft,这样 thinking pill / 模型能力
   *    立即就有数据(老 UX 保留)。首次发送时 send() 会把 draft 升级到 sessionFile key。
   */
  const startNewSession = useCallback(async () => {
    setError(null);
    if (!providerId || !modelId) {
      setError("请先选择 provider 和 model");
      return;
    }
    // 兜底:draft 槽如果被异常清掉了,重建一个
    if (!runnersRef.current.has(DRAFT_KEY)) {
      setRunner(DRAFT_KEY, emptyRunner());
    }
    setSelectedId(null);
    switchTo(DRAFT_KEY);
    // draft 已经有上一次留下的 agent? 关掉它再起新的 —— +New chat 语义就是"重置"
    closeSseFor(DRAFT_KEY);
    setRunner(DRAFT_KEY, emptyRunner());
    // 重新 switchTo 让 useRunners 把新的 empty snapshot 同步给 React state
    switchTo(DRAFT_KEY);

    try {
      const r = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          modelId,
          cwd,
          thinkingLevel,
        }),
      });
      const data = await r.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      updateRunner(DRAFT_KEY, {
        agentId: data.id,
        agentSessionId: data.sessionId,
        sessionFile: data.sessionFile ?? null,
        ...(data.thinkingLevel
          ? { thinkingLevel: data.thinkingLevel as ThinkingLevel }
          : {}),
        ...(data.availableThinkingLevels
          ? {
              availableThinkingLevels:
                data.availableThinkingLevels as ThinkingLevel[],
            }
          : {}),
        ...(typeof data.supportsThinking === "boolean"
          ? { supportsThinking: data.supportsThinking }
          : {}),
      });
      attachSseFor(DRAFT_KEY, data.id);
      void refreshStats(data.id, DRAFT_KEY);
      void refreshToolsCount(data.id, DRAFT_KEY);
    } catch (e) {
      setError(String(e));
    }
  }, [
    cwd,
    providerId,
    modelId,
    thinkingLevel,
    refreshStats,
    refreshToolsCount,
    switchTo,
    setRunner,
    closeSseFor,
    attachSseFor,
    updateRunner,
  ]);

  // ===== SSE agent 事件分发器（RFC-1 阶段 A3，已抽到 useAgentEvents） =====
  // 上游：useSseManager.onEvent → handleAgentEventRef.current（见 hook 区） → 本 handleAgentEvent
  // 下游：updateRunner（写 runner）+ 4 个全局副作用回调
  const { handleAgentEvent } = useAgentEvents({
    updateRunner,
    playDoneSound,
    refreshSessions,
    refreshForkList: (aid, key) => refreshForkListRef.current?.(aid, key),
    refreshStats,
  });

  // ===== Turn 控制中枢（RFC-1 阶段 B2-a，已抽到 useChatStream） =====
  // agentAction（通用 POST 通道）+ send / onAbort / onCompact / onAbortCompaction
  // / onSteer / onFollowUp / onChangeThinking
  // 留下：startNewSession / runSlashCommand / onChangeModel（仍在本文件，复用 agentAction）
  const {
    agentAction,
    send,
    onAbort,
    onCompact,
    onAbortCompaction,
    onSteer,
    onFollowUp,
    onChangeThinking,
  } = useChatStream({
    agentId,
    input,
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
    refreshStats,
    refreshToolsCount,
    pendingPinUserCountRef,
    setPinSpacer,
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 自动补全弹层打开时拦截上下/Enter/Tab/Esc
    if (acMode && acItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!e.nativeEvent.isComposing) {
          e.preventDefault();
          applyAutocomplete(acItems[acIndex]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAutocomplete();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // streaming 时 Enter 默认走 follow_up（排队），shift+Enter 才换行
      if (streaming) void onFollowUp();
      else void send();
    }
  };

  const headerLabel = useMemo(() => {
    if (agentSessionId) return `agent · ${agentSessionId.slice(0, 8)}`;
    if (selectedId) return `session · ${selectedId.slice(0, 8)}`;
    return "no session";
  }, [agentSessionId, selectedId]);

  // ===== Slash 命令执行 =====
  const runSlashCommand = useCallback(
    (name: SlashName) => {
      switch (name) {
        case "clear":
          void startNewSession();
          break;
        case "compact":
          void onCompact();
          break;
        case "branches":
          if (agentId) setShowBranches(true);
          break;
        case "system":
          setShowSystemPrompt(true);
          break;
        case "models":
          setShowModelsConfig(true);
          break;
        case "auth":
          setShowAuth(true);
          break;
        case "help":
          setInput(
            "支持命令：\n" +
              SLASH_COMMANDS.map((c) => `  /${c.name} — ${c.hint}`).join("\n")
          );
          return;
      }
      setInput("");
    },
    [agentId, onCompact, startNewSession]
  );

  /** 关闭 autocomplete 状态 */
  const closeAutocomplete = useCallback(() => {
    setAcMode(null);
    setAcItems([]);
    setAcIndex(0);
    acTriggerPosRef.current = -1;
  }, []);

  /** 输入或光标位置变化时刷新 autocomplete */
  const refreshAutocomplete = useCallback(
    async (text: string, caret: number) => {
      const tok = detectAutocompleteToken(text, caret);
      if (!tok) {
        closeAutocomplete();
        return;
      }
      acTriggerPosRef.current = tok.triggerPos;
      setAcMode(tok.mode);
      setAcQuery(tok.query);
      setAcIndex(0);
      if (tok.mode === "/") {
        const q = tok.query.toLowerCase();
        const items: AutocompleteItem[] = SLASH_COMMANDS.filter((c) =>
          c.name.startsWith(q)
        ).map((c) => ({
          label: `/${c.name}`,
          hint: c.hint,
          value: `/${c.name}`,
        }));
        setAcItems(items);
        return;
      }
      // @ 文件：从 cwd 读目录
      try {
        const r = await fetch(
          `/api/files?path=${encodeURIComponent(cwd)}`
        );
        const d = await r.json();
        if (!Array.isArray(d.entries)) {
          setAcItems([]);
          return;
        }
        const q = tok.query.toLowerCase();
        const filtered = (
          d.entries as Array<{ name: string; isDir: boolean; path: string }>
        )
          .filter(
            (e) =>
              !e.name.startsWith(".") && e.name.toLowerCase().includes(q)
          )
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 20)
          .map<AutocompleteItem>((e) => ({
            label: e.name + (e.isDir ? "/" : ""),
            hint: e.isDir ? "dir" : "file",
            value: `@${e.path}`,
          }));
        setAcItems(filtered);
      } catch {
        setAcItems([]);
      }
    },
    [cwd, closeAutocomplete]
  );

  /** 选中一个补全项：替换 input 中的触发 token */
  const applyAutocomplete = useCallback(
    (item: AutocompleteItem) => {
      const ta = inputRef.current;
      const triggerPos = acTriggerPosRef.current;
      if (triggerPos < 0) {
        closeAutocomplete();
        return;
      }
      const caret = ta?.selectionStart ?? input.length;
      // value 已经包含触发字符（@xx 或 /xx），后接一个空格便于继续输入
      const before = input.slice(0, triggerPos);
      const after = input.slice(caret);
      const insert = item.value + " ";
      const next = before + insert + after;
      setInput(next);
      const newCaret = before.length + insert.length;
      // 让 cursor 落到插入末尾
      requestAnimationFrame(() => {
        const t = inputRef.current;
        if (t) {
          t.focus();
          t.setSelectionRange(newCaret, newCaret);
        }
      });
      closeAutocomplete();
      // 如果是 slash 命令，立即执行
      if (acMode === "/" && item.value.startsWith("/")) {
        const name = item.value.slice(1) as SlashName;
        if (SLASH_COMMANDS.some((c) => c.name === name)) {
          runSlashCommand(name);
        }
      }
    },
    [acMode, input, closeAutocomplete, runSlashCommand]
  );

  const onChangeModel = useCallback(
    async (provider: string, mid: string) => {
      const ownerKey = activeKeyRef.current;
      setProviderId(provider);
      setModelId(mid);
      if (agentId) {
        try {
          const data = await agentAction(agentId, {
            type: "set_model",
            provider,
            modelId: mid,
          });
          // 切完模型后,thinking 能力可能变了,重新拉一下(写回触发本次操作的 runner)
          const meta = await fetch(`/api/agent/${agentId}`).then((r) =>
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
        } catch {}
      }
    },
    [agentId, agentAction, updateRunner]
  );

  // ===== Fork 模块（RFC-1 阶段 C1，已抽到 useForkable hook） =====
  const {
    forksCollapsed,
    toggleForks,
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
        {/* sessions 列表 */}
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
                        <div className="text-sm truncate">
                          {s.name || s.firstMessage || "(empty)"}
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

      {/* 右：对话 */}
      <main
        className="flex flex-1 flex-col min-w-0 relative"
        style={{ minWidth: 360 }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div
            className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center"
            style={{
              background: "rgba(37,99,235,0.06)",
              backdropFilter: "blur(1px)",
              animation: "drop-zone-in 0.15s ease both",
            }}
          >
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {[0, 0.8, 1.6].map((delay) => (
                <div
                  key={delay}
                  className="absolute rounded-full"
                  style={{
                    height: 720,
                    width: 720,
                    border: "1.5px solid rgba(37,99,235,0.5)",
                    transformOrigin: "center",
                    animation:
                      "drop-ripple 2.4s ease-out infinite backwards",
                    animationDelay: `${delay}s`,
                  }}
                />
              ))}
            </div>
            <svg
              width="280"
              height="280"
              viewBox="0 0 140 140"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{
                filter: "drop-shadow(0 6px 18px rgba(37,99,235,0.18))",
              }}
            >
              <rect
                x="28"
                y="44"
                width="84"
                height="60"
                rx="8"
                fill="rgba(37,99,235,0.08)"
                stroke="rgba(37,99,235,0.50)"
                strokeWidth="1.8"
              />
              <path
                d="M36 100 L54 72 L68 88 L80 74 L104 100Z"
                fill="rgba(37,99,235,0.16)"
                stroke="rgba(37,99,235,0.40)"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <circle
                cx="96"
                cy="58"
                r="8"
                fill="rgba(37,99,235,0.22)"
                stroke="rgba(37,99,235,0.55)"
                strokeWidth="1.6"
              />
            </svg>
            <div
              style={{
                position: "absolute",
                bottom: "22%",
                left: 0,
                right: 0,
                textAlign: "center",
                fontSize: 13,
                color: "rgba(37,99,235,0.8)",
                fontFamily: "var(--font-mono)",
                letterSpacing: 0.2,
              }}
            >
              松手添加 · 图片直接预览,文件/文件夹以 @path 形式注入
            </div>
          </div>
        )}
        <header
          className="border-b grid items-center text-xs"
          style={{
            height: 36,
            borderColor: "var(--border)",
            color: "var(--text-muted)",
            paddingLeft: 8,
            paddingRight: 8,
            // 三列:左/中/右,各占自己的 grid track,绝不互相挤压。
            // 右列 minmax(0,auto) 让 token meter 长起来时不撑爆中列。
            gridTemplateColumns: "auto 1fr auto",
            columnGap: 8,
          }}
        >
          {/* 左：sidebar toggle + theme toggle */}
          <span className="flex items-center gap-1 shrink-0 min-w-0">
            <IconButton
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
              aria-label="侧栏开关"
              icon={<PanelLeft size={iconSizeMap.sm} />}
            />
            <IconButton
              onClick={toggleTheme}
              title={theme === "dark" ? "切到浅色" : "切到深色"}
              aria-label="主题切换"
              icon={
                theme === "dark" ? (
                  <Sun size={iconSizeMap.sm} />
                ) : (
                  <Moon size={iconSizeMap.sm} />
                )
              }
            />
          </span>

          {/* 中：居中 Branches / System tabs */}
          <span className="flex items-stretch h-full justify-center min-w-0">
            <button
              type="button"
              disabled={!agentId}
              onClick={() => agentId && setShowBranches(true)}
              className="inline-flex items-center gap-1.5 h-full px-3 text-[12px] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
              style={{ color: "var(--text)" }}
              title={agentId ? "查看 / 切换分支" : "需先发送一条消息"}
            >
              <GitBranch size={13} />
              Branches
            </button>
            <button
              type="button"
              disabled={!agentId}
              onClick={async () => {
                if (!agentId) return;
                setShowSystemPrompt(true);
                try {
                  const r = await fetch(
                    `/api/agent/${agentId}?action=system_prompt`
                  );
                  const d = (await r.json()) as { systemPrompt?: string };
                  setSystemPromptText(d.systemPrompt ?? "");
                } catch (e) {
                  setSystemPromptText(`error: ${String(e)}`);
                }
              }}
              className="inline-flex items-center gap-1.5 h-full px-3 text-[12px] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
              style={{ color: "var(--text)" }}
              title={agentId ? "查看 system prompt" : "需先发送一条消息"}
            >
              <FileText size={13} />
              System
            </button>
          </span>

          {/* 右：token meter + 辅助操作 + panel toggle */}
          <span className="flex items-center gap-2 justify-end min-w-0">
            {stats && stats.total > 0 && <HudMeter stats={stats} />}
            {sseStatus !== "idle" && (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background:
                    sseStatus === "active" ? "#22c55e" : "#ef4444",
                }}
                title={
                  sseStatus === "active"
                    ? "Live sync active"
                    : "Connection lost"
                }
              />
            )}
            {electronApi && currentSessionFile && (
              <IconButton
                onClick={() =>
                  void electronApi
                    .revealInFinder(currentSessionFile)
                    .catch((e) => setError(String(e)))
                }
                title={`在 Finder 中显示: ${currentSessionFile}`}
                aria-label="在 Finder 中显示"
                icon={<FolderOpen size={iconSizeMap.sm} />}
              />
            )}
            <IconButton
              onClick={() => setShowAuth(true)}
              title="管理 Provider 凭证"
              aria-label="管理凭证"
              icon={<KeyRound size={iconSizeMap.sm} />}
            />
            <IconButton
              onClick={toggleTools}
              disabled={!agentId}
              title={
                !agentId
                  ? "需先发送一条消息以建立 session"
                  : showTools
                    ? "关闭 Tools 面板"
                    : "打开 Tools 面板"
              }
              aria-label="Tools 面板"
              active={showTools}
              icon={<Wrench size={iconSizeMap.sm} />}
            />
            <IconButton
              onClick={toggleFiles}
              title={showFiles ? "关闭右侧面板" : "打开文件浏览器"}
              aria-label="右侧面板"
              active={showFiles}
              icon={<PanelRight size={iconSizeMap.sm} />}
            />
          </span>
        </header>

        {messages.length === 0 && !error ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
            <div className="w-full max-w-[820px]">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginLeft: 16,
                  marginRight: 52,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minWidth: 0,
                    flex: 1,
                    lineHeight: 1.4,
                  }}
                >
                  <div style={{ flexShrink: 0 }}>
                    <BrandLogo size={56} />
                  </div>
                  <span
                    style={{
                      fontSize: 22,
                      color: "var(--text)",
                      fontWeight: 700,
                      letterSpacing: "-0.01em",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    Diga Agent
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      minWidth: 0,
                      flex: 1,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <Typewriter phrases={TYPEWRITER_PHRASES} />
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 2,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    web{" "}
                    <span style={{ color: "var(--text)" }}>
                      v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}
                    </span>
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    pi{" "}
                    <span style={{ color: "var(--text)" }}>
                      v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
        <div className="relative flex flex-1 overflow-hidden">
        <div
          ref={messagesScrollRef}
          onScroll={handleMessagesScroll}
          className="flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-[820px] px-4 py-6 space-y-6">
            {error && (
              <div className="p-3 rounded bg-red-900/40 border border-red-700 text-sm text-red-200">
                {error}
              </div>
            )}
            {(() => {
              const lastAssistantIdx = (() => {
                for (let k = messages.length - 1; k >= 0; k--) {
                  if (messages[k].role === "assistant") return k;
                }
                return -1;
              })();
              const modelLabel = currentProvider?.models.find(
                (mm) => mm.id === modelId
              )?.name;
              let refIdx = 0;
              return messages.map((m, i) => {
                const isVisible =
                  m.role === "user" || m.role === "assistant";
                const currentRefIdx = isVisible ? refIdx++ : -1;
                const isLastAssistant =
                  m.role === "assistant" && i === lastAssistantIdx;
                // key 稳定且唯一：
                //   1) 优先 entryId（user message 从后端拿到的稳定 id）
                //   2) 否则用 role:timestamp:index 三元组
                //      —— 同一 SSE 流里 user/assistant 可能毫秒级共享 timestamp，
                //         单纯 `t${timestamp}` 会出现 key 重复（React 警告）
                //      —— role + index 用于在同 timestamp 时 disambiguate
                //   3) 兜底 i${index}（不应到达，timestamp 一般都有）
                const stableKey =
                  m.entryId ??
                  (m.timestamp != null
                    ? `${m.role}:${m.timestamp}:${i}`
                    : `i${i}`);
                const view = (
                  <MessageView
                    msg={m}
                    index={i}
                    canFork={
                      m.role === "user" &&
                      !!m.entryId &&
                      !streaming &&
                      !forksCollapsed
                    }
                    isForking={forkingIndex === i}
                    forkText={forkText}
                    forkBusy={forkBusy}
                    onStartFork={startFork}
                    onCancelFork={cancelFork}
                    onChangeForkText={setForkText}
                    onSubmitFork={submitFork}
                    onForkToNewSession={forkToNewSession}
                    modelLabel={modelLabel}
                    meta={
                      isLastAssistant && stats && stats.total > 0
                        ? {
                            input: stats.input,
                            output: stats.output,
                            cost: stats.cost,
                          }
                        : undefined
                    }
                    streamingPhase={
                      isLastAssistant && streaming ? agentPhase : undefined
                    }
                    isStreaming={isLastAssistant && streaming}
                    cwd={cwd}
                  />
                );
                if (!isVisible) return <div key={stableKey}>{view}</div>;
                return (
                  <div
                    key={stableKey}
                    ref={(el) => {
                      messageRefs.current[currentRefIdx] = el;
                    }}
                  >
                    {view}
                  </div>
                );
              });
            })()}
            {/* 仅在"刚发送 → 锚定那条 user 到屏顶"的窗口期塞 60vh 占位;
                锚定完成或用户主动滚动后即移除,避免向下滚到无内容空白区。 */}
            {pinSpacer && <div aria-hidden style={{ minHeight: "60vh" }} />}
            {/* 列表底部留一点 padding,让最后一条气泡和输入框之间不贴边 */}
            <div aria-hidden style={{ height: 24 }} />
            <div ref={messagesEndRef} />
          </div>
        </div>
        <ChatMinimap
          messages={messages}
          scrollContainer={messagesScrollRef}
          messageRefs={messageRefs}
        />
        </div>
        )}

        {/* 输入区：820px 居中卡片 + 控制条 */}
        <div className="px-4 pb-4 pt-2">
          <div className="mx-auto w-full max-w-[820px]">
            {retryInfo && (
              <div
                className="mb-2 px-3 py-1.5 rounded-md text-[12px] flex items-center gap-2"
                style={{
                  background: "rgba(234,179,8,0.10)",
                  border: "1px solid rgba(234,179,8,0.35)",
                  color: "#a16207",
                }}
                role="status"
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
                  style={{ background: "#eab308" }}
                />
                <span className="font-medium">
                  Retrying ({retryInfo.attempt}/{retryInfo.maxAttempts})…
                </span>
                {retryInfo.errorMessage && (
                  <span
                    className="truncate opacity-80"
                    title={retryInfo.errorMessage}
                  >
                    {retryInfo.errorMessage}
                  </span>
                )}
              </div>
            )}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {pendingImages.map((img, i) => (
                  <div
                    key={i}
                    className="relative group rounded border overflow-hidden"
                    style={{
                      borderColor: "var(--border)",
                      background: "var(--bg-panel)",
                    }}
                    title={`${img.mimeType} · ${formatBytes(approxBase64Bytes(img.data))}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={`pending-${i}`}
                      className="block w-16 h-16 object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(i)}
                      className="absolute top-0 right-0 w-5 h-5 flex items-center justify-center text-[10px] bg-black/60 text-white opacity-0 group-hover:opacity-100"
                      title="移除"
                    >
                      ✕
                    </button>
                    <div
                      className="absolute bottom-0 left-0 right-0 text-[10px] px-1 truncate"
                      style={{
                        background: "rgba(0,0,0,0.5)",
                        color: "#fff",
                      }}
                    >
                      {formatBytes(approxBase64Bytes(img.data))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {pendingFiles.map((att) => (
                  <FileChip
                    key={att.path}
                    att={att}
                    onRemove={() => removePendingFile(att.path)}
                  />
                ))}
              </div>
            )}
            {/* 卡片：textarea + 内嵌 Send */}
            <div
              className="relative rounded-xl border transition-colors focus-within:border-[color:var(--accent)]"
              style={{
                background: "var(--bg-panel)",
                borderColor: "var(--border)",
              }}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  const v = e.target.value;
                  setInput(v);
                  void refreshAutocomplete(v, e.target.selectionStart ?? v.length);
                }}
                onSelect={(e) => {
                  const t = e.currentTarget;
                  void refreshAutocomplete(t.value, t.selectionStart ?? t.value.length);
                }}
                onBlur={() => closeAutocomplete()}
                onKeyDown={onKeyDown}
                onPaste={onPasteTextarea}
                placeholder={
                  streaming ? "Steer 立即注入 / Follow-up 排队…" : "Message…"
                }
                rows={3}
                className="w-full bg-transparent resize-none outline-none border-0 text-sm px-4 pt-3 pb-12"
                style={{ color: "var(--text)" }}
              />
              {acMode && (
                <InputAutocomplete
                  mode={acMode}
                  items={acItems}
                  selectedIndex={acIndex}
                  onPick={applyAutocomplete}
                  onHover={setAcIndex}
                />
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    void addImageFiles(e.target.files);
                  }
                  e.target.value = "";
                }}
              />
              {/* 卡片底部内嵌：右下 Send */}
              <div className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5">
                {streaming ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void onSteer()}
                      disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                      style={{ color: "var(--text-muted)" }}
                      title="Steer：立即注入当前 turn（不打断）"
                    >
                      <Target size={12} />
                      Steer
                    </button>
                    <button
                      type="button"
                      onClick={() => void onFollowUp()}
                      disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                      style={{ color: "var(--text-muted)" }}
                      title="Follow-up：排队，当前 turn 结束后自动发送"
                    >
                      <CornerDownLeft size={12} />
                      Follow-up
                    </button>
                    <button
                      type="button"
                      onClick={() => void onAbort()}
                      className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-red-600 hover:bg-red-500"
                      title="中止当前 turn"
                      aria-label="Stop"
                    >
                      <span className="block w-2.5 h-2.5 bg-white rounded-sm" />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => void send()}
                    disabled={
                      (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) ||
                      (!agentId && (!providerId || !modelId))
                    }
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium text-white disabled:opacity-40 transition-opacity"
                    style={{ background: "var(--accent)" }}
                    title="Send"
                  >
                    <span aria-hidden="true">→</span>
                    Send
                  </button>
                )}
              </div>
            </div>

            {/* 控制条：与 pi-web 对齐的 6 控件横排 */}
            <div
              className="flex items-center mt-2 gap-1.5 text-xs flex-wrap"
              style={{ color: "var(--text-muted)" }}
            >
              {/* 1. 图片附件 */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center h-6 w-6 rounded-full border hover:bg-[color:var(--bg-hover)]"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                }}
                title="附加图片"
                aria-label="附加图片"
              >
                <ImageIcon size={12} />
              </button>

              {/* 2. Provider（紧凑显示，仅当 show all 或多 provider 时） */}
              {visibleProviders.length > 1 && (
                <PillSelect
                  value={providerId}
                  onChange={(e) => onChangeModel(e.target.value, "")}
                  title={
                    currentProvider?.hasAuth
                      ? `auth: ${currentProvider.authSource ?? "?"} (${currentProvider.authLabel ?? ""})`
                      : "no auth configured"
                  }
                  leading={
                    providerId ? (
                      <ProviderIcon provider={providerId} size={12} />
                    ) : null
                  }
                >
                  {visibleProviders.map((p) => (
                    <option key={p.provider} value={p.provider}>
                      {p.hasAuth ? "✓ " : "  "}
                      {p.displayName}
                    </option>
                  ))}
                </PillSelect>
              )}

              {/* 3. Model（Cpu 图标 + 模型名） */}
              <PillSelect
                value={modelId}
                onChange={(e) => onChangeModel(providerId, e.target.value)}
                disabled={!currentProvider}
                widthClassName="max-w-[180px]"
                leading={<Cpu size={12} />}
                title={
                  currentProvider
                    ? `${currentProvider.displayName} / ${modelId || "(no model)"}`
                    : "no provider"
                }
              >
                {currentProvider?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.reasoning ? " ·thinking" : ""}
                  </option>
                ))}
              </PillSelect>

              {/* 4. Thinking level（Lightbulb 图标） */}
              {supportsThinking && (
                <PillSelect
                  value={thinkingLevel}
                  onChange={(e) =>
                    void onChangeThinking(e.target.value as ThinkingLevel)
                  }
                  leading={<Lightbulb size={12} />}
                  title="thinking level"
                >
                  {availableThinkingLevels.map((lv) => (
                    <option key={lv} value={lv}>
                      {THINKING_LEVEL_LABELS[lv]}
                    </option>
                  ))}
                </PillSelect>
              )}

              {/* 5. Tools（Wrench 图标 + 启用计数） */}
              {agentId && (
                <button
                  type="button"
                  onClick={toggleTools}
                  className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-[color:var(--bg-hover)]"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                  }}
                  title="管理可用工具"
                >
                  <Wrench
                    size={12}
                    style={{ color: "var(--text-muted)" }}
                  />
                  {toolsCount
                    ? `${toolsCount.active}/${toolsCount.total}`
                    : "Tools"}
                </button>
              )}

              {/* 6. Compact（Minimize2 图标） */}
              {!streaming && agentId && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    onClick={() =>
                      compacting ? void onAbortCompaction() : void onCompact()
                    }
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-[color:var(--bg-hover)]"
                    style={{
                      borderColor: compacting
                        ? "rgba(248,113,113,0.45)"
                        : "var(--border)",
                      background: "var(--bg-panel)",
                      color: compacting ? "#ef4444" : "var(--text)",
                    }}
                    title={compacting ? "Cancel compaction" : "Compact context"}
                  >
                    <Minimize2
                      size={12}
                      style={{
                        color: compacting ? "#ef4444" : "var(--text-muted)",
                      }}
                    />
                    {compacting ? "Compacting…" : "Compact"}
                  </button>
                  {compactError && (
                    <div
                      className="absolute bottom-full mb-1.5 right-0 z-50 rounded-md px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap max-w-[320px]"
                      style={{
                        background: "rgba(127,29,29,0.95)",
                        border: "1px solid rgba(248,113,113,0.6)",
                        color: "#fecaca",
                      }}
                      role="alert"
                    >
                      <div className="flex items-center gap-1.5">
                        <AlertTriangle size={11} />
                        <span className="font-medium">Compact failed</span>
                      </div>
                      <div className="mt-0.5 opacity-90 truncate">
                        {compactError}
                      </div>
                    </div>
                  )}
                </span>
              )}

              {/* 7. 完成提示音开关 */}
              <button
                type="button"
                onClick={onSoundToggle}
                className="inline-flex items-center justify-center h-6 w-6 rounded-full border"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-panel)",
                  color: soundEnabled
                    ? "var(--text)"
                    : "var(--text-muted)",
                  opacity: soundEnabled ? 1 : 0.55,
                }}
                title={soundEnabled ? "完成提示音：开" : "完成提示音：关"}
                aria-label="Sound toggle"
                aria-pressed={soundEnabled}
              >
                {soundEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
              </button>

              {/* 右侧状态：no key 警告（折到末尾，避免抢眼） */}
              {currentProvider && !currentProvider.hasAuth && (
                <span className="text-yellow-600 dark:text-yellow-500 inline-flex items-center gap-1 ml-1">
                  <AlertTriangle size={12} />
                  no key
                </span>
              )}
            </div>
          </div>
        </div>
      </main>

      {showFiles && (
        <>
          <div
            onMouseDown={onSplitterMouseDown}
            title="拖动调整宽度"
            style={{
              width: 4,
              cursor: "ew-resize",
              background: "var(--border-soft)",
              flexShrink: 0,
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--border-soft)";
            }}
          />
          <div
            style={{
              // 用 flex-basis 表达"想要的宽度",允许 shrink:窗口窄时压到 minWidth
              flex: `0 1 ${filesContainerWidth}px`,
              minWidth: filesLayout.viewerHidden && filesLayout.treeCollapsed ? 56 : 200,
              maxWidth: "80vw",
              transition: "flex-basis 0.16s ease",
            }}
          >
            <FileBrowser
              initialPath={cwd || "/"}
              onClose={toggleFiles}
              onPickPath={(absPath) => {
                // 把路径加到输入框末尾（用 @ 前缀，pi-coding-agent 约定的引用语法）
                setInput((cur) => {
                  const sep = cur.length === 0 || cur.endsWith(" ") ? "" : " ";
                  return `${cur}${sep}@${absPath} `;
                });
              }}
              onLayoutChange={setFilesLayout}
            />
          </div>
        </>
      )}
      {showCwdPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setShowCwdPicker(false)}
        >
          <div
            className="rounded-md overflow-hidden flex flex-col"
            style={{
              width: 520,
              maxWidth: "90vw",
              height: 520,
              maxHeight: "85vh",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <FileBrowser
              initialPath={cwd || "/"}
              onClose={() => setShowCwdPicker(false)}
              onPickDir={(picked) => {
                setCwd(picked);
                setShowCwdPicker(false);
              }}
              mode="picker"
            />
          </div>
        </div>
      )}
      {showFilePicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setShowFilePicker(false)}
        >
          <div
            className="rounded-md overflow-hidden flex flex-col"
            style={{
              width: 520,
              maxWidth: "90vw",
              height: 520,
              maxHeight: "85vh",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <FileBrowser
              initialPath={cwd || "/"}
              onClose={() => setShowFilePicker(false)}
              onPickPath={(absPath) => {
                setInput((cur) => {
                  const sep =
                    cur.length === 0 || cur.endsWith(" ") ? "" : " ";
                  return `${cur}${sep}@${absPath} `;
                });
                setShowFilePicker(false);
              }}
              mode="picker"
            />
          </div>
        </div>
      )}
      {showSkills && <SkillsPanel cwd={cwd} onClose={toggleSkills} />}
      {showTools && agentId && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={toggleTools}
        >
          <div
            className="h-full w-[480px] max-w-[90vw] shadow-xl"
            style={{ background: "var(--bg-panel)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <ToolsPanel agentId={agentId} onClose={toggleTools} />
          </div>
        </div>
      )}
      {showAuth && (
        <AuthPanel
          onClose={() => setShowAuth(false)}
          onChanged={() => reloadProviders(false)}
        />
      )}
      {showModelsConfig && (
        <ModelsConfigPanel
          onClose={() => setShowModelsConfig(false)}
          onChanged={() => reloadProviders(false)}
        />
      )}
      {showSystemPrompt && (
        <SystemPromptModal
          text={systemPromptText}
          onClose={() => {
            setShowSystemPrompt(false);
            setSystemPromptText(null);
          }}
        />
      )}
      {showBranches && agentId && (
        <BranchesPopover
          agentId={agentId}
          onClose={() => setShowBranches(false)}
          onNavigated={() => {
            void reloadFromCurrentSession();
          }}
        />
      )}
      <ImageLightbox />
    </div>
  );
}

function SystemPromptModal({
  text,
  onClose,
}: {
  text: string | null;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md w-full max-w-3xl max-h-[80vh] flex flex-col"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--fg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <h2 className="text-sm font-semibold">System prompt</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (text) void navigator.clipboard.writeText(text);
              }}
              className="px-2 py-1 text-xs rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
              disabled={!text}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 text-xs rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
            >
              Close
            </button>
          </div>
        </div>
        <div className="overflow-auto flex-1 p-3">
          {text == null ? (
            <div className="text-xs" style={{ color: "var(--fg-faint)" }}>
              Loading…
            </div>
          ) : text === "" ? (
            <div className="text-xs" style={{ color: "var(--fg-faint)" }}>
              Send a message to load the system prompt
            </div>
          ) : (
            <pre
              className="text-[12px] whitespace-pre-wrap font-mono leading-[1.45]"
              style={{ color: "var(--fg)" }}
            >
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============== MessageView ============== */

interface MessageViewProps {
  msg: ChatMessage;
  index: number;
  /** 是否允许 fork（user message + 有 entryId + 不在 streaming） */
  canFork: boolean;
  /** 是否正在编辑该条 */
  isForking: boolean;
  forkText: string;
  forkBusy: boolean;
  onStartFork: (index: number, currentText: string) => void;
  onCancelFork: () => void;
  onChangeForkText: (text: string) => void;
  onSubmitFork: (entryId: string) => void;
  /** 从此 entry fork 出新 session（带 parentSessionPath） */
  onForkToNewSession: (entryId: string) => void;
  /** assistant caption 用的模型名（仅本轮的 modelId 名） */
  modelLabel?: string;
  /** 仅最后一条 assistant 的本轮 token meta */
  meta?: { input: number; output: number; cost: number };
  /** 仅最后一条 assistant + 正在 streaming 时传入：用于 phase 标签 + t/s pill */
  streamingPhase?: AgentPhase;
  isStreaming?: boolean;
  /** 当前会话 cwd：传给 Markdown 用于解析消息里出现的相对图片路径 */
  cwd?: string;
}

/**
 * MessageView：用 React.memo 包裹，shallow-compare props。
 * 流式期间只有最后一条 assistant 的 msg/streamingPhase/meta 变，其它 N-1 条 props 引用不变直接跳过 reconcile。
 *
 * 关键前提：父组件传的回调要稳定（用 useCallback 包），否则 shallow-equal 始终不命中。
 * 当前 startFork/cancelFork/setForkText/submitFork/forkToNewSession 已是 setState 包装或 useCallback。
 */
const MessageView = memo(function MessageView({
  msg,
  index,
  canFork,
  isForking,
  forkText,
  forkBusy,
  onStartFork,
  onCancelFork,
  onChangeForkText,
  onSubmitFork,
  onForkToNewSession,
  modelLabel,
  meta,
  streamingPhase,
  isStreaming,
  cwd,
}: MessageViewProps) {
  // user：右侧气泡（支持 text + image parts 混合）
  if (msg.role === "user") {
    const parts: MessagePart[] =
      msg.parts && msg.parts.length > 0
        ? msg.parts
        : msg.text
        ? [{ kind: "text", text: msg.text }]
        : [];

    // 拼出当前 user message 的"纯文本"作为 fork 编辑器初值
    const joinedText = parts
      .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
      .map((p) => p.text)
      .join("");

    return (
      <div className="group relative flex flex-col items-end">
        <div className="flex flex-col items-end gap-1.5 max-w-[75%]">
          {parts.map((p, i) => {
            if (p.kind === "text") {
              if (!p.text) return null;
              return (
                <div
                  key={i}
                  className="rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap inline-block"
                  style={{
                    background: "var(--user-bg)",
                    color: "var(--text)",
                  }}
                >
                  {p.text}
                </div>
              );
            }
            if (p.kind === "image") {
              const src = `data:${p.mimeType};base64,${p.data}`;
              return (
                <div
                  key={i}
                  className="rounded-2xl overflow-hidden inline-block"
                  style={{
                    background: "var(--user-bg)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={`user-img-${i}`}
                    onClick={() => previewStore.openImage(src, "我发送的图片")}
                    className="block max-w-full max-h-80 object-contain"
                    style={{ cursor: "zoom-in" }}
                  />
                </div>
              );
            }
            return null;
          })}
        </div>

        {/* 时间戳 + hover 操作行（Copy / Edit from here / New session） */}
        <div
          className="text-[11px] mt-1 flex items-center gap-2"
          style={{ color: "var(--text-muted)" }}
        >
          {!isForking && (
            <span className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-3">
              {joinedText && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(joinedText);
                    } catch {
                      /* ignore */
                    }
                  }}
                  className="inline-flex items-center gap-1 hover:text-[color:var(--text)]"
                  title="复制"
                >
                  <FileText size={11} />
                  Copy
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  onClick={() => onStartFork(index, joinedText)}
                  className="inline-flex items-center gap-1 hover:text-[color:var(--text)]"
                  title="从此处编辑：截断后续对话并重新发送（同 session）"
                >
                  <CornerDownLeft size={11} />
                  Edit from here
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  onClick={() => onForkToNewSession(msg.entryId!)}
                  className="inline-flex items-center gap-1 hover:text-[color:var(--text)]"
                  title="从此处分叉成新 session"
                >
                  <GitBranch size={11} />
                  New session
                </button>
              )}
            </span>
          )}
          {msg.timestamp && (
            <span
              className="ml-auto text-[10px]"
              style={{ color: "var(--fg-faint)" }}
            >
              {formatMessageTime(msg.timestamp)}
            </span>
          )}
        </div>

        <div className="w-full">
          {/* 内联 fork 编辑器 */}
          {isForking && msg.entryId && (
            <div
              className="rounded-lg p-2 space-y-2"
              style={{
                background: "var(--bg-panel-2)",
                border: "1px dashed var(--accent)",
              }}
            >
              <div
                className="text-[10px]"
                style={{ color: "var(--fg-faint)" }}
              >
                Fork from entry {msg.entryId.slice(0, 8)} · 提交后此后所有消息将被丢弃
              </div>
              <textarea
                value={forkText}
                onChange={(e) => onChangeForkText(e.target.value)}
                rows={4}
                disabled={forkBusy}
                className="w-full rounded p-2 text-sm resize-none outline-none border"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border-soft)",
                  color: "var(--fg)",
                }}
              />
              <div className="flex justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={onCancelFork}
                  disabled={forkBusy}
                  className="px-2 py-1 rounded border hover:opacity-80 disabled:opacity-50"
                  style={{
                    borderColor: "var(--border)",
                    color: "var(--fg)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => onSubmitFork(msg.entryId!)}
                  disabled={forkBusy || !forkText.trim()}
                  className="px-2 py-1 rounded text-white disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  {forkBusy ? "Forking…" : "Fork"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // assistant：左侧，按 parts 顺序渲染
  // 兼容老 message（只有 thinking/text 字段，没有 parts）
  let parts: MessagePart[] = msg.parts ?? [];
  if (parts.length === 0 && (msg.thinking || msg.text)) {
    if (msg.thinking) parts = [...parts, { kind: "thinking", text: msg.thinking }];
    if (msg.text) parts = [...parts, { kind: "text", text: msg.text }];
  }

  const captionText = modelLabel || "Assistant";

  const plainText = extractPlainText(parts);
  return (
    <div className="group">
      <div
        className="text-[11px] mb-1 flex items-center gap-2"
        style={{ color: "var(--text-muted)" }}
      >
        <span>{captionText}</span>
        {isStreaming && (
          <AssistantStreamMeta phase={streamingPhase ?? null} parts={parts} />
        )}
      </div>
      <div className="space-y-2 text-sm">
        {(() => {
          // 流式中只有"最后一个 text part"在累积 token,提前算好它的 index,
          // 给那个 Markdown 标 streaming=true(走纯 pre,跳过 ReactMarkdown)
          let tailTextIdx = -1;
          if (isStreaming) {
            for (let j = parts.length - 1; j >= 0; j--) {
              if (parts[j].kind === "text") { tailTextIdx = j; break; }
            }
          }
          return parts.map((p, i) => {
          if (p.kind === "thinking") {
            return (
              <ThinkingBlock
                key={i}
                text={p.text}
                startedAt={p.startedAt}
                endedAt={p.endedAt}
              />
            );
          }
          if (p.kind === "text") {
            return (
              <div key={i} style={{ color: "var(--text)" }}>
                <Markdown text={p.text} streaming={i === tailTextIdx} cwd={cwd} />
              </div>
            );
          }
          if (p.kind === "tool") {
            return <ToolRender key={i} tool={p} />;
          }
          if (p.kind === "image") {
            const src = `data:${p.mimeType};base64,${p.data}`;
            return (
              <div key={i} className="rounded-lg overflow-hidden inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt=""
                  onClick={() => previewStore.openImage(src, "生成的图片")}
                  className="block max-w-full max-h-96 object-contain"
                  style={{ cursor: "zoom-in" }}
                />
              </div>
            );
          }
          return null;
        });
        })()}
      </div>
      <div
        className="text-[11px] mt-2 flex items-center gap-2"
        style={{ color: "var(--text-muted)" }}
      >
        {meta && (
          <>
            <span>{formatTokens(meta.input)} in</span>
            <span aria-hidden="true">·</span>
            <span>{formatTokens(meta.output)} out</span>
            {meta.cost > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {meta.cost < 0.0001
                    ? "<$0.0001"
                    : `$${meta.cost.toFixed(4)}`}
                </span>
              </>
            )}
          </>
        )}
        <CopyButton text={plainText} />
        {msg.timestamp && (
          <span
            className="ml-auto text-[10px]"
            style={{ color: "var(--fg-faint)" }}
          >
            {formatMessageTime(msg.timestamp)}
          </span>
        )}
      </div>
    </div>
  );
});

type PendingAttachmentKind = "folder" | "doc" | "archive" | "code" | "table" | "pdf" | "other";

/**
 * 拖入的非图片附件(zip/pdf/csv/md/txt/word/folder ...)。
 * 仅持有"显示元信息+绝对路径";发送时自动以 @path 形式拼到 prompt 头部,
 * 保留 chip 视觉,避免输入框被一长串 @path 污染。
 */
interface PendingAttachment {
  path: string;
  name: string;
  /** 字节数;文件夹/未知时为 null */
  size: number | null;
  kind: PendingAttachmentKind;
}

/** 拖入附件 chip：图标 + 文件名 + 大小 + ✕ 移除 */
function FileChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  const Icon =
    att.kind === "folder"
      ? Folder
      : att.kind === "archive"
      ? FileArchive
      : att.kind === "table"
      ? FileSpreadsheet
      : att.kind === "code"
      ? FileCode
      : att.kind === "doc" || att.kind === "pdf"
      ? FileText
      : Paperclip;
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border pl-2 pr-1 py-1 max-w-[260px]"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
      }}
      title={att.path}
    >
      <Icon size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
      <span
        className="truncate text-[12px] font-mono"
        style={{ color: "var(--text)" }}
      >
        {att.name}
      </span>
      <span
        className="text-[10px] shrink-0"
        style={{ color: "var(--text-muted)" }}
      >
        {att.size == null ? "dir" : formatBytes(att.size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center justify-center w-4 h-4 rounded hover:bg-[color:var(--bg-hover)]"
        style={{ color: "var(--text-muted)", flexShrink: 0 }}
        title="移除"
        aria-label="移除附件"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function formatMessageTime(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * Streaming 中的 phase 标签 + 实时 t/s pill。
 * - phase：跟随 agentPhase 切换 "Thinking…/Waiting for model…/Running X…"
 * - tps：每 300ms 估算一次（chars / 4 / elapsed），按速度染色
 */
function AssistantStreamMeta({
  phase,
  parts,
}: {
  phase: AgentPhase;
  parts: MessagePart[];
}) {
  const [tps, setTps] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  useEffect(() => {
    const tick = () => {
      const bs = partsRef.current;
      let chars = 0;
      for (const p of bs) {
        if (p.kind === "text") chars += p.text.length;
        else if (p.kind === "thinking") chars += p.text.length;
        else if (p.kind === "tool") {
          try {
            chars += JSON.stringify(p.args ?? {}).length;
          } catch {
            /* ignore */
          }
        }
      }
      if (chars === 0) return;
      const now = Date.now();
      if (startRef.current === null) startRef.current = now;
      const elapsed = (now - startRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => {
      clearInterval(id);
      startRef.current = null;
    };
  }, []);

  const label = phaseLabel(phase);
  const pillBg =
    tps == null
      ? null
      : tps >= 50
      ? "#53b3cb"
      : tps >= 30
      ? "#9bc53d"
      : tps >= 15
      ? "#f9c22e"
      : "#e01a4f";

  return (
    <span className="inline-flex items-center gap-2">
      {label && (
        <span className="animate-pulse" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
      )}
      {tps != null && pillBg && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            background: pillBg,
            color: "#fff",
            fontVariantNumeric: "tabular-nums",
          }}
          title="预估 token 速率（chars/4/elapsed）"
        >
          {tps.toFixed(1)} t/s
        </span>
      )}
    </span>
  );
}

function phaseLabel(phase: AgentPhase): string {
  if (!phase) return "";
  if (phase.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return "Running tool…";
    if (names.length === 1) return `Running ${names[0]}…`;
    if (names.length <= 3) return `Running ${names.join(", ")}…`;
    return `Running ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase.kind === "waiting_model") return "Waiting for model…";
  if (phase.kind === "thinking") return "Thinking…";
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[color:var(--bg-hover)]"
      style={{ color: "var(--text-muted)" }}
      title="Copy"
    >
      <FileText size={11} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function extractPlainText(parts: MessagePart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === "text") out.push(p.text);
    else if (p.kind === "thinking") {
      // 不复制 thinking 内容
    }
  }
  return out.join("\n").trim();
}

/**
 * 顶栏 token / cost / context HUD。
 * hover 时显示完整数字 tooltip（fixed 浮层，避开原生 title 的 1s 延迟）。
 */
function HudMeter({
  stats,
}: {
  stats: {
    input: number;
    output: number;
    cacheRead: number;
    total: number;
    cost: number;
    ctxTokens: number | null;
    ctxPct: number | null;
    ctxWindow: number | null;
  };
}) {
  const [open, setOpen] = useState(false);
  const ctxColor =
    stats.ctxPct == null
      ? "var(--accent)"
      : stats.ctxPct > 0.85
      ? "#ef4444"
      : stats.ctxPct > 0.7
      ? "#eab308"
      : "var(--accent)";
  return (
    <span
      className="relative inline-flex items-center gap-2 px-1 shrink-0"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span>↑{formatTokens(stats.input)}</span>
      <span>↓{formatTokens(stats.output)}</span>
      {stats.cost > 0 && (
        <span>
          {stats.cost < 0.01 ? "<$0.01" : `$${stats.cost.toFixed(2)}`}
        </span>
      )}
      {stats.ctxPct != null && (
        <span
          className="inline-block rounded-full overflow-hidden"
          style={{ width: 28, height: 3, background: "var(--bg-hover)" }}
          aria-hidden="true"
        >
          <span
            className="block h-full"
            style={{
              width: `${Math.min(100, stats.ctxPct * 100).toFixed(1)}%`,
              background: ctxColor,
            }}
          />
        </span>
      )}
      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 z-50 rounded-md shadow-lg text-[11px] whitespace-nowrap"
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            padding: "8px 10px",
            minWidth: 200,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span style={{ color: "var(--text-muted)" }}>Input</span>
            <span className="text-right">{stats.input.toLocaleString()}</span>
            <span style={{ color: "var(--text-muted)" }}>Output</span>
            <span className="text-right">{stats.output.toLocaleString()}</span>
            <span style={{ color: "var(--text-muted)" }}>Cache read</span>
            <span className="text-right">
              {stats.cacheRead.toLocaleString()}
            </span>
            <span style={{ color: "var(--text-muted)" }}>Total</span>
            <span className="text-right">{stats.total.toLocaleString()}</span>
            {stats.cost > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>Cost</span>
                <span className="text-right">
                  ${stats.cost.toFixed(4)}
                </span>
              </>
            )}
            {stats.ctxTokens != null && stats.ctxWindow != null && (
              <>
                <span
                  className="col-span-2 mt-1 pt-1"
                  style={{ borderTop: "1px solid var(--border-soft)" }}
                />
                <span style={{ color: "var(--text-muted)" }}>Context</span>
                <span className="text-right" style={{ color: ctxColor }}>
                  {stats.ctxPct != null
                    ? `${(stats.ctxPct * 100).toFixed(1)}%`
                    : "—"}
                </span>
                <span style={{ color: "var(--text-muted)" }}>Used</span>
                <span className="text-right">
                  {stats.ctxTokens.toLocaleString()}
                </span>
                <span style={{ color: "var(--text-muted)" }}>Window</span>
                <span className="text-right">
                  {stats.ctxWindow.toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

function formatRelativeTime(ts: number | string): string {
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("zh-CN");
}

function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const home = cwd.match(/^\/Users\/[^/]+/)?.[0];
  const trimmed = home ? cwd.replace(home, "~") : cwd;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 2) return trimmed;
  return `…/${parts.slice(-2).join("/")}`;
}

function ThinkingBlock({
  text,
  startedAt,
  endedAt,
}: {
  text: string;
  startedAt?: number;
  endedAt?: number;
}) {
  if (!text) return null;
  // 仅在思考阶段已结束（有 endedAt）时展示时长；流式中不显示
  const duration =
    startedAt && endedAt && endedAt > startedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
      : null;
  return (
    <details
      className="rounded-md text-xs"
      style={{
        background: "var(--bg-panel-2)",
        color: "var(--text-muted)",
      }}
    >
      <summary
        className="cursor-pointer px-3 py-2 select-none flex items-center gap-1.5"
        style={{ color: "var(--text-muted)" }}
      >
        <Lightbulb size={12} />
        <span>Thinking</span>
        {duration !== null && (
          <span
            className="ml-auto tabular-nums"
            style={{ fontSize: 11, color: "var(--fg-faint)" }}
          >
            {duration}s
          </span>
        )}
      </summary>
      <div
        className="px-3 pb-2 thinking-md"
        style={{ color: "var(--text-dim)", fontSize: 12 }}
      >
        <Markdown text={text} size="small" />
      </div>
    </details>
  );
}
