"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionInfoLite,
  ChatMessage,
  ProviderInfo,
  ProvidersResponse,
  ThinkingLevel,
  ImageContentLite,
  ForkableUserMessage,
} from "@/lib/types";
import { extractImagesFromClipboard } from "@/lib/image-utils";
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
  type AgentPhase,
  type PendingAttachment,
} from "@/lib/session-runner";
import { useRunners } from "./hooks/useRunners";
import { useSseManager } from "./hooks/useSseManager";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useSessions } from "./hooks/useSessions";
import { useChatStream } from "./hooks/useChatStream";
import { useComposerAttachments } from "./hooks/useComposerAttachments";
import { usePetPusher } from "./hooks/usePetPusher";
import { useBudget } from "./hooks/useBudget";
import { useBudgetEnforcer, type BudgetTrigger } from "./hooks/useBudgetEnforcer";
import { useForkable } from "./hooks/useForkable";
import { useApprovals } from "./hooks/useApprovals";
import { useAutocomplete } from "./hooks/useAutocomplete";
import { useMessageRefs } from "./ChatMinimap";
import { EmptyState } from "./components/EmptyState";
import { Composer } from "./components/Composer";
import { DropOverlay } from "./components/DropOverlay";
import { Sidebar } from "./components/Sidebar";
import { TopHeader } from "./components/TopHeader";
import { MessagesScrollArea } from "./components/MessagesScrollArea";
import { RightPanelContainer } from "./components/RightPanelContainer";
import { ChatModals } from "./components/ChatModals";
import { BudgetExceededModal } from "./components/BudgetExceededModal";

interface Props {
  initialSessions: SessionInfoLite[];
  defaultCwd: string;
}

type Theme = "dark" | "light";

// SLASH_COMMANDS / SlashName / detectAutocompleteToken 已搬到 hooks/useAutocomplete.ts（RFC-1 阶段 C2）。

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
  // 输入框 @ / 自动补全已挪到 hooks/useAutocomplete.ts（RFC-1 阶段 C2）。
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
  /** RFC-2 Phase A3：Budget 命中后由 useBudgetEnforcer 设置；非 null 时弹 BudgetExceededModal */
  const [budgetPausedTrigger, setBudgetPausedTrigger] =
    useState<BudgetTrigger | null>(null);
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
  const { approve: approveCall, deny: denyCall } = useApprovals({
    agentId,
    onError: setError,
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

  // RFC-2 Phase A3：Budget 触发后执行 abort/pause
  useBudgetEnforcer({
    agentId,
    streaming,
    runStartedAt: activeSnapshot.runStartedAt,
    status: budgetStatus,
    budget,
    onAbort,
    onPause: setBudgetPausedTrigger,
  });

  // "提高上限并继续"：把当前 budget 各启用维度 × 2 写入 session override
  const handleRaiseAndContinue = useCallback(
    (trigger: BudgetTrigger) => {
      if (!agentId) {
        setBudgetPausedTrigger(null);
        return;
      }
      const b = trigger.budget;
      setSessionOverride({
        maxCostUsd: b.maxCostUsd && b.maxCostUsd > 0 ? b.maxCostUsd * 2 : b.maxCostUsd,
        maxTurns: b.maxTurns && b.maxTurns > 0 ? b.maxTurns * 2 : b.maxTurns,
        maxDurationSec:
          b.maxDurationSec && b.maxDurationSec > 0
            ? b.maxDurationSec * 2
            : b.maxDurationSec,
        action: b.action,
      });
      setBudgetPausedTrigger(null);
      // Phase A 暂不自动续发；用户需手动在 Composer 里继续追问
    },
    [agentId, setSessionOverride]
  );

  const headerLabel = useMemo(() => {
    if (agentSessionId) return `agent · ${agentSessionId.slice(0, 8)}`;
    if (selectedId) return `session · ${selectedId.slice(0, 8)}`;
    return "no session";
  }, [agentSessionId, selectedId]);

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
    input,
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // streaming 时 Enter 默认走 follow_up（排队），shift+Enter 才换行
      if (streaming) void onFollowUp();
      else void send();
    }
  };

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
      <Sidebar
        sidebarOpen={sidebarOpen}
        cwd={cwd}
        setShowCwdPicker={setShowCwdPicker}
        sessions={sessions}
        groupedSessions={groupedSessions}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
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
        setInput={setInput}
        setShowFilePicker={setShowFilePicker}
        setShowModelsConfig={setShowModelsConfig}
        showSkills={showSkills}
        toggleSkills={toggleSkills}
      />

      {/* 右：对话 */}
      <main
        className="flex flex-1 flex-col min-w-0 relative"
        style={{ minWidth: 360 }}
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
          showTools={showTools}
          showFiles={showFiles}
          budget={budget}
          budgetSpent={budgetSpent}
          budgetStatus={budgetStatus}
          budgetHasOverride={budgetHasOverride}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleTheme={toggleTheme}
          onOpenBranches={() => setShowBranches(true)}
          onOpenSystemPrompt={async () => {
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
          onRevealInFinder={() => {
            if (electronApi && currentSessionFile) {
              void electronApi
                .revealInFinder(currentSessionFile)
                .catch((e) => setError(String(e)));
            }
          }}
          onOpenAuth={() => setShowAuth(true)}
          onToggleTools={toggleTools}
          onToggleFiles={toggleFiles}
        />

        {messages.length === 0 && !error ? (
          <EmptyState />
        ) : (
          <MessagesScrollArea
            messages={messages}
            error={error}
            currentProvider={currentProvider}
            modelId={modelId}
            stats={stats}
            agentPhase={agentPhase}
            cwd={cwd}
            streaming={streaming}
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
            onApproveCall={approveCall}
            onDenyCall={denyCall}
          />
        )}

        <Composer
          input={input}
          setInput={setInput}
          inputRef={inputRef}
          fileInputRef={fileInputRef}
          onKeyDown={onKeyDown}
          onPasteTextarea={onPasteTextarea}
          streaming={streaming}
          compacting={compacting}
          agentId={agentId}
          pendingImages={pendingImages}
          pendingFiles={pendingFiles}
          removePendingImage={removePendingImage}
          removePendingFile={removePendingFile}
          addImageFiles={addImageFiles}
          acMode={acMode}
          acItems={acItems}
          acIndex={acIndex}
          setAcIndex={setAcIndex}
          applyAutocomplete={applyAutocomplete}
          refreshAutocomplete={refreshAutocomplete}
          closeAutocomplete={closeAutocomplete}
          send={send}
          onSteer={onSteer}
          onFollowUp={onFollowUp}
          onAbort={onAbort}
          onCompact={onCompact}
          onAbortCompaction={onAbortCompaction}
          retryInfo={retryInfo}
          compactError={compactError}
          visibleProviders={visibleProviders}
          providerId={providerId}
          modelId={modelId}
          currentProvider={currentProvider ?? null}
          onChangeModel={onChangeModel}
          supportsThinking={supportsThinking}
          thinkingLevel={thinkingLevel}
          availableThinkingLevels={availableThinkingLevels}
          onChangeThinking={onChangeThinking}
          toolsCount={toolsCount}
          toggleTools={toggleTools}
          soundEnabled={soundEnabled}
          onSoundToggle={onSoundToggle}
        />
      </main>

      <RightPanelContainer
        show={showFiles}
        cwd={cwd}
        filesContainerWidth={filesContainerWidth}
        filesLayout={filesLayout}
        onSplitterMouseDown={onSplitterMouseDown}
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
      <ChatModals
        cwd={cwd}
        agentId={agentId}
        showCwdPicker={showCwdPicker}
        onCloseCwdPicker={() => setShowCwdPicker(false)}
        onPickCwd={(picked) => {
          setCwd(picked);
          setShowCwdPicker(false);
        }}
        showFilePicker={showFilePicker}
        onCloseFilePicker={() => setShowFilePicker(false)}
        onPickFile={(absPath) => {
          setInput((cur) => {
            const sep =
              cur.length === 0 || cur.endsWith(" ") ? "" : " ";
            return `${cur}${sep}@${absPath} `;
          });
          setShowFilePicker(false);
        }}
        showSkills={showSkills}
        onCloseSkills={toggleSkills}
        showTools={showTools}
        onCloseTools={toggleTools}
        showAuth={showAuth}
        onCloseAuth={() => setShowAuth(false)}
        onAuthChanged={() => reloadProviders(false)}
        showModelsConfig={showModelsConfig}
        onCloseModelsConfig={() => setShowModelsConfig(false)}
        onModelsConfigChanged={() => reloadProviders(false)}
        showSystemPrompt={showSystemPrompt}
        systemPromptText={systemPromptText}
        onCloseSystemPrompt={() => {
          setShowSystemPrompt(false);
          setSystemPromptText(null);
        }}
        showBranches={showBranches}
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

