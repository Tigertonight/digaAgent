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
  fileToImageContent,
  extractImagesFromClipboard,
  approxBase64Bytes,
  formatBytes,
} from "@/lib/image-utils";
import { getElectronApi, type AppInfo } from "@/lib/electron-bridge";
import { useAudio } from "@/lib/use-audio";
import { useDragDrop } from "@/lib/use-drag-drop";
import { previewStore } from "@/lib/preview-store";
import {
  applyEvent,
  createInitialState,
  ctxToMessages,
  type ReducerState,
} from "@/lib/chat-reducer";
import {
  emptyRunner,
  DRAFT_KEY,
  type RunnerKey,
  type RunnerState,
} from "@/lib/session-runner";
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
 * 从 .jsonl 路径解出 session UUID。
 * 形如 ".../<timestamp>_<uuid>.jsonl" 或 ".../<uuid>.jsonl"。
 * 解不出返回 null —— 调用方走兜底(等 refreshSessions 后从列表里匹配)。
 */
function extractSessionIdFromPath(p: string): string | null {
  const base = p.split("/").pop() ?? "";
  const noExt = base.replace(/\.jsonl$/, "");
  const m = noExt.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

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
  const [sessions, setSessions] = useState<SessionInfoLite[]>(initialSessions);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSessions[0]?.id ?? null
  );
  /**
   * 已查看的 session id → 上次查看时该 session 的 modified ISO。
   * 若 sessions[i].modified > lastSeenMap[sessions[i].id],视为有新内容(未读)。
   * 当前选中的 session 永远算已读。localStorage 持久化。
   */
  const [lastSeenMap, setLastSeenMap] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem("sessionLastSeen");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") setLastSeenMap(parsed);
      }
    } catch {}
  }, []);
  // 选中或 sessions 列表更新 → 把当前选中那条的 modified 写进 lastSeenMap
  useEffect(() => {
    if (!selectedId) return;
    const cur = sessions.find((s) => s.id === selectedId);
    if (!cur) return;
    setLastSeenMap((prev) => {
      if (prev[selectedId] === cur.modified) return prev;
      const next = { ...prev, [selectedId]: cur.modified };
      try {
        localStorage.setItem("sessionLastSeen", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [selectedId, sessions]);
  // chatState / forkable* 等 per-runner 字段已挪到 RunnerState。
  // messages / visibleMessageCount / messageRefs 依赖 chatState/forkableUserMessages,
  // 已下移到 activeSnapshot 解构之后(否则用前先声明会报错)。

  /**
   * 把扁平 sessions 按 parentSessionPath 分组：
   *   - parents: 没有 parentSessionPath（或 parent 不在列表里）的 session，保持原顺序
   *   - childrenByParent: parent.path -> child[]（按 modified 倒序排）
   * 渲染时 parent 之后立即渲染它的 children（缩进），其余 children 也作为 parent 显示在末尾兜底。
   */
  const groupedSessions = useMemo(() => {
    const byPath = new Map<string, SessionInfoLite>();
    for (const s of sessions) byPath.set(s.path, s);
    const childrenByParent = new Map<string, SessionInfoLite[]>();
    const parents: SessionInfoLite[] = [];
    for (const s of sessions) {
      if (s.parentSessionPath && byPath.has(s.parentSessionPath)) {
        const arr = childrenByParent.get(s.parentSessionPath) ?? [];
        arr.push(s);
        childrenByParent.set(s.parentSessionPath, arr);
      } else {
        parents.push(s);
      }
    }
    return { parents, childrenByParent };
  }, [sessions]);

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
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState(defaultCwd);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** 把一组 File 转 ImageContentLite 并 append 到 pendingImages */
  const addImageFiles = useCallback(async (files: File[] | FileList) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;
    try {
      const converted = await Promise.all(arr.map((f) => fileToImageContent(f)));
      setPendingImages((prev) => [...prev, ...converted]);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const removePendingImage = useCallback((idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  /**
   * 拖入分流:
   *   - 图片(image/*) → 转 base64 进 pendingImages 内联预览
   *   - 其它(zip/pdf/csv/md/txt/word/folder) → 通过 Electron webUtils 拿绝对路径,
   *     以"附件 chip"塞进 pendingFiles,发送时自动拼成 @path 注入 prompt 头
   *
   * Web 模式没有 webUtils → 文件路径不可得,提示用户改用文件浏览器。
   */
  const onDropFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      const others = files.filter((f) => !f.type.startsWith("image/"));

      if (images.length) void addImageFiles(images);

      if (others.length === 0) return;

      const api = getElectronApi();
      if (!api?.getPathForFile) {
        setError(
          "拖拽非图片文件需要在桌面端使用（浏览器无法获取绝对路径）。请用左下文件浏览器选择文件。"
        );
        return;
      }
      const newAttachments: PendingAttachment[] = [];
      for (const f of others) {
        const p = api.getPathForFile(f);
        if (!p) continue;
        // File API 给文件夹时 type === "" 且 size === 0,作为粗略识别
        const isFolder = f.type === "" && f.size === 0 && !/\.[a-z0-9]{1,8}$/i.test(f.name);
        newAttachments.push({
          path: p,
          name: f.name || p.split("/").pop() || p,
          size: isFolder ? null : f.size,
          kind: isFolder ? "folder" : kindFromName(f.name),
        });
      }
      if (newAttachments.length === 0) {
        setError("无法获取拖入文件的路径。");
        return;
      }
      setPendingFiles((prev) => {
        const seen = new Set(prev.map((a) => a.path));
        return [...prev, ...newAttachments.filter((a) => !seen.has(a.path))];
      });
    },
    [addImageFiles]
  );

  const removePendingFile = useCallback((path: string) => {
    setPendingFiles((prev) => prev.filter((a) => a.path !== path));
  }, []);
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
  /** FileBrowser 内部折叠状态:用于让外层容器跟着收缩,避免留白 */
  const [filesLayout, setFilesLayout] = useState<{
    treeCollapsed: boolean;
    viewerHidden: boolean;
  }>({ treeCollapsed: false, viewerHidden: false });
  /** 实际渲染宽度:viewer 隐藏时只剩 tree(或两侧都收起时只剩窄条) */
  const filesContainerWidth = filesLayout.viewerHidden
    ? filesLayout.treeCollapsed
      ? 56 // 两个窄条
      : 268 // tree 240 + border 1 + viewer 边栏 28
    : rightPanelWidth;
  /** 收起时 splitter 也没意义,顺手隐藏 */
  const filesSplitterEnabled = !filesLayout.viewerHidden;
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
  const [showBranches, setShowBranches] = useState(false);
  const [systemPromptText, setSystemPromptText] = useState<string | null>(
    null
  );
  // sseStatus 已挪到 RunnerState(每个会话独立的 SSE 状态)。
  /** 折叠 fork 按钮（pi-web 风格 Collapse/Expand forks） */
  const [forksCollapsed, setForksCollapsed] = useState(false);
  useEffect(() => {
    try {
      setForksCollapsed(localStorage.getItem("pi-forks-collapsed") === "1");
    } catch {}
  }, []);
  const toggleForks = useCallback(() => {
    setForksCollapsed((v) => {
      const nv = !v;
      try {
        localStorage.setItem("pi-forks-collapsed", nv ? "1" : "0");
      } catch {}
      return nv;
    });
  }, []);
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

  // 刷新左侧 session 列表
  const refreshSessions = useCallback(() => {
    void fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions?: SessionInfoLite[] }) =>
        setSessions(d.sessions ?? [])
      )
      .catch(() => {});
  }, []);

  /**
   * 轻量轮询 session 列表 —— 用来追踪"别的 agent"在后台的进展。
   * 自己的 agent_end 事件已经会主动 refreshSessions（见 reducer 监听）,
   * 所以这里只负责兜底跨 session 同步,15s 间隔足够;tab 不可见时跳过。
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      refreshSessions();
    };
    const id = setInterval(tick, 15000);
    // 标签页从隐藏切回可见时立即拉一次（避免要等到下一个 15s 周期）
    const onVis = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshSessions]);

  // session 菜单操作
  const submitRename = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        setRenamingFor(null);
        return;
      }
      try {
        const r = await fetch(`/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) setError(data.error);
        else refreshSessions();
      } catch (e) {
        setError(String(e));
      } finally {
        setRenamingFor(null);
        setMenuFor(null);
      }
    },
    [refreshSessions]
  );

  const executeDeleteSession = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setError(data.error);
          return;
        }
        // 如果删的是当前打开的，重置
        if (selectedId === id) {
          setSelectedId(null);
          setAgentId(null);
          setChatState(createInitialState());
          if (esRef.current) {
            esRef.current.close();
            esRef.current = null;
          }
        }
        refreshSessions();
      } catch (e) {
        setError(String(e));
      } finally {
        setMenuFor(null);
        setPendingDeleteId(null);
      }
    },
    [refreshSessions, selectedId]
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

  const esRef = useRef<EventSource | null>(null);

  // ===== 多会话 runner 容器(P1) =====
  // runnersRef 是所有会话工作面的"权威存储":未在视野中的 runner(SSE 仍连)在这里继续累积事件。
  // esMapRef 是每个 runner 的 SSE 连接;切换会话时不关 SSE,让后台流式继续。
  // [activeKey, setActiveKey] 触发渲染:UI 从 activeSnapshot 读当前活跃 runner 的不可变快照。
  // 当前(P1-2)只是建容器,不接管现有 useState;后续 step 才把 useState 替换为 snapshot 解构。
  const runnersRef = useRef<Map<RunnerKey, RunnerState>>(
    new Map([[DRAFT_KEY, emptyRunner()]])
  );
  const esMapRef = useRef<Map<RunnerKey, EventSource>>(new Map());
  const [activeKey, setActiveKey] = useState<RunnerKey>(DRAFT_KEY);
  const [activeSnapshot, setActiveSnapshot] = useState<RunnerState>(() =>
    emptyRunner()
  );

  // === Runner helper（P1-3）===
  // 为了避免 stale closure,所有 helper 都从 ref 读最新 active key/snapshot:
  // setState 异步,但 ref 同步 mutate,callbacks 里读 activeKeyRef.current 永远是最新值。
  const activeKeyRef = useRef<RunnerKey>(DRAFT_KEY);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  /** 把 patch 写入指定 runner;若该 runner 是当前活跃的,同步 setActiveSnapshot 触发渲染。 */
  const updateRunner = useCallback(
    (
      key: RunnerKey,
      patch:
        | Partial<RunnerState>
        | ((prev: RunnerState) => Partial<RunnerState>)
    ) => {
      const cur = runnersRef.current.get(key);
      if (!cur) return; // 已被 LRU 淘汰或还没 lazy 加载,丢弃
      const delta = typeof patch === "function" ? patch(cur) : patch;
      const next: RunnerState = {
        ...cur,
        ...delta,
        lastTouched: Date.now(),
      };
      runnersRef.current.set(key, next);
      if (key === activeKeyRef.current) {
        setActiveSnapshot(next);
      }
    },
    []
  );

  /** 写当前活跃 runner —— 等价于 updateRunner(activeKey, patch),但永远走 active 路径。 */
  const updateActive = useCallback(
    (
      patch:
        | Partial<RunnerState>
        | ((prev: RunnerState) => Partial<RunnerState>)
    ) => {
      updateRunner(activeKeyRef.current, patch);
    },
    [updateRunner]
  );

  /**
   * 切换活跃 runner。
   *  - 不关任何 SSE(让后台流式继续)
   *  - 目标 runner 必须已经存在于 Map(草稿/已切换过的);冷启动选历史会话由调用方
   *    先 runnersRef.current.set(key, runnerWithCtx) 再 switchTo(key)。
   */
  const switchTo = useCallback((newKey: RunnerKey) => {
    const target = runnersRef.current.get(newKey);
    if (!target) {
      // 目标不存在 —— 调用方该先 lazy create runner 再 switchTo。
      // 这里兜底建一个空 runner,避免渲染崩。
      const fresh = emptyRunner();
      runnersRef.current.set(newKey, fresh);
      activeKeyRef.current = newKey;
      setActiveKey(newKey);
      setActiveSnapshot(fresh);
      return;
    }
    // 更新 lastTouched 进 LRU 表
    const touched: RunnerState = { ...target, lastTouched: Date.now() };
    runnersRef.current.set(newKey, touched);
    activeKeyRef.current = newKey;
    setActiveKey(newKey);
    setActiveSnapshot(touched);
  }, []);

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
  const setForkBusy = useCallback(
    (v: Updater<boolean>) =>
      updateActive((s) => ({ forkBusy: resolve(s.forkBusy, v) })),
    [updateActive]
  );
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

  // compactError 3 秒自动消失（原本贴在 useState 旁,现在挪到 wrapper 之后）
  useEffect(() => {
    if (!compactError) return;
    const id = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(id);
  }, [compactError, setCompactError]);

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

  // 选已有 session → 拉 context，重置 chat state
  useEffect(() => {
    if (!selectedId) return;
    setError(null);
    setChatState(createInitialState());
    setForkableUserMessages([]);
    setForkingIndex(null);
    setAgentId(null);
    setAgentSessionId(null);
    const sel = sessions.find((s) => s.id === selectedId);
    setCurrentSessionFile(sel?.path ?? null);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    void fetch(`/api/sessions/${selectedId}/context`)
      .then((r) => r.json())
      .then((ctx) => {
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

  // 拉当前 agent 的 forkable user messages
  // refreshForkList / refreshStats / refreshToolsCount 写到指定 runner;
  // ownerKey 缺省 = 当前活跃 runner —— 兼容老调用点。
  const refreshForkList = useCallback(
    async (aid: string, ownerKey?: RunnerKey) => {
      try {
        const r = await fetch(
          `/api/agent/${aid}?action=user_messages_for_forking`
        );
        const data = await r.json();
        if (Array.isArray(data.messages)) {
          updateRunner(ownerKey ?? activeKeyRef.current, {
            forkableUserMessages: data.messages as ForkableUserMessage[],
          });
        }
      } catch (e) {
        console.warn("refreshForkList failed", e);
      }
    },
    [updateRunner]
  );

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

  // 通用 agent action POST
  const agentAction = useCallback(
    async (aid: string, payload: Record<string, unknown>) => {
      const r = await fetch(`/api/agent/${aid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data.error) {
        setError(data.error);
        throw new Error(data.error);
      }
      return data;
    },
    []
  );

  /**
   * 关掉指定 runner 的 SSE(P1-5)。LRU 淘汰、组件卸载、显式重置 都走这里。
   * 不改任何 runner 状态;仅释放 EventSource。
   */
  const closeSseFor = useCallback((key: RunnerKey) => {
    const es = esMapRef.current.get(key);
    if (es) {
      es.close();
      esMapRef.current.delete(key);
    }
    // 兼容期:把单实例 esRef 也清掉,避免残留
    if (esRef.current && !esMapRef.current.size) {
      esRef.current = null;
    }
  }, []);

  /**
   * 为指定 runner 打开 SSE(P1-5)。每个 runner 一个独立 EventSource,
   * 路由到 handleAgentEvent(ev, agentId) —— P1-6 里会再加 ownerKey。
   * 当前(P1-5):活跃 runner 的事件继续走 setX wrapper(写入 active runner);
   * 非活跃 runner 还无法被切到(P1-7/8 才有),所以路由到 active 等价于路由到自身。
   */
  const attachSseFor = useCallback(
    (key: RunnerKey, aid: string) => {
      // 已存在则先关掉,避免泄漏
      const prev = esMapRef.current.get(key);
      if (prev) prev.close();
      const es = new EventSource(`/api/agent/${aid}/events`);
      esMapRef.current.set(key, es);
      // 兼容旧逻辑:active runner 的 SSE 也写一份到 esRef 兜底
      if (key === activeKeyRef.current) esRef.current = es;
      es.onopen = () => updateRunner(key, { sseStatus: "active" });
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data);
          // 后端 SSE envelope 带 id: <seq>,浏览器把它写到 ev.lastEventId
          const seq = ev.lastEventId ? Number(ev.lastEventId) : NaN;
          if (Number.isFinite(seq)) {
            updateRunner(key, { lastSeq: seq });
          }
          handleAgentEvent(event, aid, key);
        } catch (e) {
          console.error("bad sse data", e, ev.data);
        }
      };
      es.onerror = (e) => {
        console.warn("sse error", e);
        updateRunner(key, { sseStatus: "lost" });
      };
    },
    // handleAgentEvent 是函数声明,每次 render 重建;依赖刷新由 ref 控制
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateRunner]
  );

  /**
   * 兼容 shim:旧的 attachSse(aid) 调用点全部转发到 attachSseFor(activeKey, aid)。
   * P1-7/8 完成后再批量替换调用点为 attachSseFor。
   */
  const attachSse = useCallback(
    (aid: string) => {
      attachSseFor(activeKeyRef.current, aid);
    },
    [attachSseFor]
  );

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
      runnersRef.current.set(DRAFT_KEY, emptyRunner());
    }
    setSelectedId(null);
    switchTo(DRAFT_KEY);
    // draft 已经有上一次留下的 agent? 关掉它再起新的 —— +New chat 语义就是"重置"
    closeSseFor(DRAFT_KEY);
    runnersRef.current.set(DRAFT_KEY, emptyRunner());
    setActiveSnapshot(runnersRef.current.get(DRAFT_KEY)!);

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
    closeSseFor,
    attachSseFor,
    updateRunner,
  ]);

  /**
   * 处理一条 SSE 事件并把状态写到对应 runner(P1-6)。
   *
   * ownerKey 是事件归属的 runner key —— 不一定是当前活跃的:
   * 切到 B 时 A 的 SSE 仍在跑,A 的事件会带 ownerKey=A 的写法路由到 runnersRef.get(A);
   * updateRunner 内部判断 key === activeKey 才同步 setActiveSnapshot,
   * 所以 A 的事件不会污染 B 的渲染。
   *
   * playDoneSound / refreshSessions 这类全局副作用,无论 owner 是谁都触发。
   */
  function handleAgentEvent(
    ev: { type: string; [k: string]: unknown },
    aidForEvents: string,
    ownerKey: RunnerKey
  ) {
    switch (ev.type) {
      case "agent_start":
        updateRunner(ownerKey, {
          streaming: true,
          agentPhase: { kind: "waiting_model" },
        });
        return;
      case "agent_end":
        updateRunner(ownerKey, {
          streaming: false,
          agentPhase: null,
          retryInfo: null,
        });
        playDoneSound();
        refreshSessions();
        if (aidForEvents) {
          void refreshForkList(aidForEvents, ownerKey);
          void refreshStats(aidForEvents, ownerKey);
        }
        return;
      case "compaction_start":
      case "auto_compaction_start":
        updateRunner(ownerKey, { compacting: true, compactError: null });
        return;
      case "compaction_end":
      case "auto_compaction_end": {
        const err = (ev as { error?: string; errorMessage?: string }).error
          ?? (ev as { errorMessage?: string }).errorMessage;
        updateRunner(ownerKey, {
          compacting: false,
          ...(err ? { compactError: err } : {}),
        });
        if (aidForEvents) void refreshStats(aidForEvents, ownerKey);
        return;
      }
      case "auto_retry_start": {
        const e = ev as {
          attempt?: number;
          maxAttempts?: number;
          errorMessage?: string;
        };
        if (e.attempt && e.maxAttempts) {
          updateRunner(ownerKey, {
            retryInfo: {
              attempt: e.attempt,
              maxAttempts: e.maxAttempts,
              errorMessage: e.errorMessage,
            },
          });
        }
        return;
      }
      case "auto_retry_end":
        updateRunner(ownerKey, { retryInfo: null });
        return;
      case "thinking_level_changed": {
        const lv = (ev as { level?: ThinkingLevel }).level;
        if (lv) updateRunner(ownerKey, { thinkingLevel: lv });
        return;
      }
      // reducer-driven 事件
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        updateRunner(ownerKey, (s) => {
          const nextChat = applyEvent(s.chatState, ev);
          // phase 派生:跟 pi-web 对齐
          let nextPhase = s.agentPhase;
          if (ev.type === "message_update") {
            const sub = (ev as { assistantMessageEvent?: { type?: string } })
              .assistantMessageEvent;
            if (sub?.type === "thinking_delta") {
              if (nextPhase?.kind !== "running_tools")
                nextPhase = { kind: "thinking" };
            } else if (sub?.type === "text_delta") {
              if (nextPhase?.kind !== "running_tools") nextPhase = null;
            }
          } else if (ev.type === "message_end") {
            nextPhase = { kind: "waiting_model" };
          } else if (ev.type === "tool_execution_start") {
            const id = (ev as { toolCallId?: string }).toolCallId;
            const name = (ev as { toolName?: string }).toolName;
            if (id && name) {
              const tools =
                nextPhase?.kind === "running_tools" ? [...nextPhase.tools] : [];
              if (!tools.some((t) => t.id === id)) tools.push({ id, name });
              nextPhase = { kind: "running_tools", tools };
            }
          } else if (ev.type === "tool_execution_end") {
            const id = (ev as { toolCallId?: string }).toolCallId;
            if (id && nextPhase?.kind === "running_tools") {
              const tools = nextPhase.tools.filter((t) => t.id !== id);
              nextPhase =
                tools.length === 0
                  ? { kind: "waiting_model" }
                  : { kind: "running_tools", tools };
            }
          }
          return { chatState: nextChat, agentPhase: nextPhase };
        });
        return;
      default:
        return;
    }
  }

  // 发送
  const send = useCallback(async () => {
    if (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) return;
    let aid = agentId;
    if (!aid) {
      if (!providerId || !modelId) {
        setError("请先选择 provider 和 model");
        return;
      }
      const r = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          modelId,
          cwd,
          thinkingLevel,
          sessionPath: selectedId
            ? sessions.find((s) => s.id === selectedId)?.path
            : undefined,
        }),
      });
      const data = await r.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      aid = data.id;
      // 当前活跃 runner 接收 agent 信息(可能是 draft,也可能是 session.path)
      const ownerKey = activeKeyRef.current;
      updateRunner(ownerKey, {
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

      // 草稿升级:把当前 draft runner 重命名到 sessionFile,留一个空 draft 给下次 +New chat
      if (ownerKey === DRAFT_KEY && data.sessionFile) {
        const newKey: RunnerKey = data.sessionFile;
        const upgraded = runnersRef.current.get(DRAFT_KEY);
        if (upgraded) {
          runnersRef.current.set(newKey, upgraded);
          runnersRef.current.delete(DRAFT_KEY);
          // 同时把 SSE 也搬到新 key(如果已经存在)
          const es = esMapRef.current.get(DRAFT_KEY);
          if (es) {
            esMapRef.current.set(newKey, es);
            esMapRef.current.delete(DRAFT_KEY);
          }
          // 切活跃指针 + sidebar 选中
          activeKeyRef.current = newKey;
          setActiveKey(newKey);
          // 根据 sessionFile 反查 session.id —— 此时 sessions 列表可能还没刷新到这条
          // 兜底:从 path 解 UUID(文件名 _<uuid>.jsonl 形态)
          const idFromPath = extractSessionIdFromPath(data.sessionFile);
          if (idFromPath) setSelectedId(idFromPath);
          // 重新建一个空 draft
          runnersRef.current.set(DRAFT_KEY, emptyRunner());
        }
      }

      attachSseFor(activeKeyRef.current, data.id);
      void refreshStats(data.id, activeKeyRef.current);
      void refreshToolsCount(data.id, activeKeyRef.current);
    }
    const userText = input;
    const images = pendingImages;
    const attachments = pendingFiles;
    // 拼最终 prompt:把所有 @path 顶在前面,后端按引用语法读文件/列文件夹
    const refLine = attachments.map((a) => `@${a.path}`).join(" ");
    const finalText = refLine
      ? userText
        ? `${refLine}\n${userText}`
        : refLine
      : userText;
    setInput("");
    setPendingImages([]);
    setPendingFiles([]);
    setError(null);
    // 锚定:期望"现有 user 数 + 1"那条新消息一出现就滚到屏顶
    // 同时启用底部 60vh 占位,确保最后一条 user 能被滚到屏顶;锚定完成后会自动移除。
    const currentUserCount = messages.filter((m) => m.role === "user").length;
    pendingPinUserCountRef.current = currentUserCount + 1;
    setPinSpacer(true);
    try {
      await agentAction(aid!, {
        type: "prompt",
        text: finalText || "(image)",
        images: images.length > 0 ? images : undefined,
      });
    } catch {
      /* error 已被 agentAction 设置 */
    }
  }, [
    agentId,
    input,
    messages,
    pendingImages,
    pendingFiles,
    cwd,
    selectedId,
    sessions,
    providerId,
    modelId,
    thinkingLevel,
    attachSseFor,
    agentAction,
    refreshStats,
    refreshToolsCount,
    updateRunner,
  ]);

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

  // ===== action handlers =====
  const onAbort = useCallback(async () => {
    if (!agentId) return;
    try {
      await agentAction(agentId, { type: "abort" });
    } catch {}
  }, [agentId, agentAction]);

  const onCompact = useCallback(async () => {
    if (!agentId) return;
    try {
      setCompactError(null);
      await agentAction(agentId, { type: "compact" });
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : "compact failed");
    }
  }, [agentId, agentAction]);

  const onAbortCompaction = useCallback(async () => {
    if (!agentId) return;
    try {
      await agentAction(agentId, { type: "abort_compaction" });
    } catch {}
  }, [agentId, agentAction]);

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

  /** Steer：streaming 时把输入框内容塞进当前 turn 的 system 引导 */
  const onSteer = useCallback(async () => {
    if (!agentId) return;
    const text = input.trim();
    if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;
    const refLine = pendingFiles.map((a) => `@${a.path}`).join(" ");
    const finalText = refLine ? (text ? `${refLine}\n${text}` : refLine) : text;
    try {
      await agentAction(agentId, {
        type: "steer",
        text: finalText,
        ...(pendingImages.length ? { images: pendingImages } : {}),
      });
      setInput("");
      setPendingImages([]);
      setPendingFiles([]);
    } catch {}
  }, [agentId, agentAction, input, pendingImages, pendingFiles]);

  /** Follow-up：streaming 时把输入框内容排队到当前 turn 结束后追发 */
  const onFollowUp = useCallback(async () => {
    if (!agentId) return;
    const text = input.trim();
    if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;
    const refLine = pendingFiles.map((a) => `@${a.path}`).join(" ");
    const finalText = refLine ? (text ? `${refLine}\n${text}` : refLine) : text;
    try {
      await agentAction(agentId, {
        type: "follow_up",
        text: finalText,
        ...(pendingImages.length ? { images: pendingImages } : {}),
      });
      setInput("");
      setPendingImages([]);
      setPendingFiles([]);
    } catch {}
  }, [agentId, agentAction, input, pendingImages, pendingFiles]);

  const onChangeThinking = useCallback(
    async (lv: ThinkingLevel) => {
      setThinkingLevelState(lv);
      if (agentId) {
        try {
          await agentAction(agentId, { type: "set_thinking_level", level: lv });
        } catch {}
      }
    },
    [agentId, agentAction]
  );

  const onChangeModel = useCallback(
    async (provider: string, mid: string) => {
      setProviderId(provider);
      setModelId(mid);
      if (agentId) {
        try {
          const data = await agentAction(agentId, {
            type: "set_model",
            provider,
            modelId: mid,
          });
          // 切完模型后，thinking 能力可能变了，重新拉一下
          const meta = await fetch(`/api/agent/${agentId}`).then((r) =>
            r.json()
          );
          if (meta.thinkingLevel) setThinkingLevelState(meta.thinkingLevel);
          if (meta.availableThinkingLevels)
            setAvailableThinkingLevels(meta.availableThinkingLevels);
          if (typeof meta.supportsThinking === "boolean")
            setSupportsThinking(meta.supportsThinking);
          void data;
        } catch {}
      }
    },
    [agentId, agentAction]
  );

  // ===== Fork handlers =====
  const startFork = useCallback((index: number, currentText: string) => {
    setForkingIndex(index);
    setForkText(currentText);
  }, []);

  const cancelFork = useCallback(() => {
    setForkingIndex(null);
    setForkText("");
  }, []);

  /**
   * 从某条 user message 起 fork 出一个**新 session 文件**：
   *   1. POST /api/sessions/{srcId}/fork  -> 拿到新 session 的 id/path/cwd
   *   2. POST /api/agent/new  with sessionPath=新文件 -> 新 agent
   *   3. navigate_tree(targetEntryId)  -> 把 leaf 截断到 fork 点
   *   4. 切到新 session 的 UI（左侧高亮、右侧重载 context）
   *   5. 刷新 sessions 列表（新 session 应作为 child 显示在 parent 下）
   */
  const forkToNewSession = useCallback(
    async (entryId: string) => {
      if (!selectedId && !agentSessionId) {
        setError("当前没有可 fork 的 session");
        return;
      }
      if (!providerId || !modelId) {
        setError("请先选择 provider 和 model");
        return;
      }
      const srcId = agentSessionId ?? selectedId!;
      setError(null);
      try {
        // 1. 创建新 session 文件
        const fr = await fetch(`/api/sessions/${srcId}/fork`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetEntryId: entryId }),
        });
        const fd = (await fr.json()) as {
          ok?: boolean;
          id?: string;
          path?: string;
          cwd?: string;
          error?: string;
        };
        if (fd.error || !fd.id || !fd.path) {
          setError(fd.error || "fork failed");
          return;
        }
        // 2. 关旧 SSE，准备打开新 agent
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
        setAgentId(null);
        setAgentSessionId(null);
        setForkableUserMessages([]);
        setForkingIndex(null);
        // 3. 创建新 agent，绑定新 session 文件
        const ar = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerId,
            modelId,
            cwd: fd.cwd || cwd,
            thinkingLevel,
            sessionPath: fd.path,
          }),
        });
        const ad = await ar.json();
        if (ad.error) {
          setError(ad.error);
          return;
        }
        const newAid = ad.id as string;
        setAgentId(newAid);
        setAgentSessionId(ad.sessionId);
        setCurrentSessionFile(ad.sessionFile ?? null);
        attachSse(newAid);
        // 4. 把 leaf 截到 fork 点
        await agentAction(newAid, {
          type: "navigate_tree",
          targetId: entryId,
          summarize: false,
        });
        // 5. 重新拉 context 渲染
        try {
          const ctx = await fetch(`/api/sessions/${ad.sessionId}/context`).then(
            (r) => r.json()
          );
          if (!ctx.error) {
            setChatState(
              createInitialState(ctxToMessages(ctx.messages ?? []))
            );
            if (Array.isArray(ctx.forkableUserMessages)) {
              setForkableUserMessages(
                ctx.forkableUserMessages as ForkableUserMessage[]
              );
            }
          }
        } catch {
          /* ignore */
        }
        await refreshForkList(newAid);
        void refreshStats(newAid);
        void refreshToolsCount(newAid);
        // 6. 列表更新 + 选中新 session
        setSelectedId(ad.sessionId);
        refreshSessions();
      } catch (e) {
        setError(String(e));
      }
    },
    [
      selectedId,
      agentSessionId,
      providerId,
      modelId,
      cwd,
      thinkingLevel,
      attachSse,
      agentAction,
      refreshForkList,
      refreshSessions,
      refreshStats,
      refreshToolsCount,
    ]
  );

  const submitFork = useCallback(
    async (entryId: string) => {
      const text = forkText.trim();
      if (!text) {
        setError("fork 文本不能为空");
        return;
      }
      // 没 agent 就基于当前 session 现起一个（用户可能直接打开历史 session 就 hover Edit）
      let aid = agentId;
      if (!aid) {
        if (!providerId || !modelId) {
          setError("请先选择 provider 和 model");
          return;
        }
        const sel = selectedId
          ? sessions.find((s) => s.id === selectedId)
          : undefined;
        if (!sel) {
          setError("无法定位当前 session");
          return;
        }
        const r = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerId,
            modelId,
            cwd: sel.cwd || cwd,
            thinkingLevel,
            sessionPath: sel.path,
          }),
        });
        const data = await r.json();
        if (data.error) {
          setError(data.error);
          return;
        }
        aid = data.id as string;
        setAgentId(aid);
        setAgentSessionId(data.sessionId);
        setCurrentSessionFile(data.sessionFile ?? null);
        attachSse(aid);
      }
      setForkBusy(true);
      setError(null);
      try {
        // 1. 切到该 entry（不 summarize，直接截断）
        await agentAction(aid, {
          type: "navigate_tree",
          targetId: entryId,
          summarize: false,
        });
        // 2. 重新拉 session context（reducer 从头来）
        if (selectedId || agentSessionId) {
          // session 文件可能没立刻 flush；优先用 sessionId
          const sid = agentSessionId ?? selectedId;
          try {
            const ctx = await fetch(`/api/sessions/${sid}/context`).then((r) =>
              r.json()
            );
            if (!ctx.error) {
              setChatState(
                createInitialState(ctxToMessages(ctx.messages ?? []))
              );
            }
          } catch {
            /* 忽略：发完 prompt 后 SSE 也会重建 messages */
          }
        }
        // 3. 用新文本发 prompt
        await agentAction(aid, { type: "prompt", text });
        // 4. 关编辑器、刷 fork 列表
        setForkingIndex(null);
        setForkText("");
        await refreshForkList(aid);
      } catch (e) {
        setError(String(e));
      } finally {
        setForkBusy(false);
      }
    },
    [
      agentId,
      agentSessionId,
      selectedId,
      sessions,
      providerId,
      modelId,
      cwd,
      thinkingLevel,
      forkText,
      attachSse,
      agentAction,
      refreshForkList,
    ]
  );

  // panel 颜色用 CSS 变量驱动；class 里只放结构相关
  return (
    <div
      className="flex h-screen"
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
              // 状态点:运行中(转圈) > 未读(蓝点) > 无
              const isRunning = !!s.isRunning;
              const seenAt = lastSeenMap[s.id];
              const isUnread = !active && !isRunning && (!seenAt || seenAt < s.modified);
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
            onOpenChooser={() => setShowCwdPicker(true)}
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
          className="border-b flex items-center text-xs relative"
          style={{
            height: 36,
            borderColor: "var(--border)",
            color: "var(--text-muted)",
            paddingLeft: 8,
            paddingRight: 8,
          }}
        >
          {/* 左：sidebar toggle + theme toggle */}
          <span className="flex items-center gap-1 shrink-0">
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
          <span className="absolute left-1/2 -translate-x-1/2 flex items-stretch h-full">
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
          <span className="flex items-center gap-2 shrink-0 ml-auto">
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
                  <BrandLogo size={56} />
                  <span
                    style={{
                      fontSize: 22,
                      color: "var(--text)",
                      fontWeight: 700,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    Diga Agent
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      minWidth: 0,
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
                // key 稳定：优先 entryId（user message 有），否则 timestamp，否则 index
                // 用稳定 key 让 React diff 不会把第 N 条的 state 错误地复用到第 N+1 条
                const stableKey = m.entryId ?? (m.timestamp != null ? `t${m.timestamp}` : `i${i}`);
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
          {filesSplitterEnabled && (
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
          )}
          <div
            style={{
              width: filesContainerWidth,
              flexShrink: 0,
              maxWidth: "80vw",
              transition: "width 0.16s ease",
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

/** 按扩展名粗分类,只用来选附件 chip 的 icon/底色 */
function kindFromName(name: string): Exclude<PendingAttachmentKind, "folder"> {
  const lower = name.toLowerCase();
  if (/\.(zip|tar|gz|tgz|bz2|7z|rar|xz)$/.test(lower)) return "archive";
  if (/\.pdf$/.test(lower)) return "pdf";
  if (/\.(csv|tsv|xlsx?|ods|numbers)$/.test(lower)) return "table";
  if (/\.(md|markdown|txt|rtf|docx?|pages|odt)$/.test(lower)) return "doc";
  if (/\.(js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|cs|rb|php|swift|kt|sh|bash|zsh|json|toml|yaml|yml|xml|html?|css|scss|sql)$/.test(lower)) return "code";
  return "other";
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
        className="px-3 pb-2 whitespace-pre-wrap"
        style={{ color: "var(--text-muted)" }}
      >
        {text}
      </div>
    </details>
  );
}
