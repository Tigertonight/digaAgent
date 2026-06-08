/**
 * Electron 渲染进程桥的 TypeScript 类型 + 安全访问器。
 *
 * 用法：
 *   const api = getElectronApi();
 *   if (api) {
 *     const dir = await api.selectDirectory();
 *   }
 *
 * 在 Web 模式（普通浏览器）下 getElectronApi() 返回 null，调用方应 fallback。
 */

/** 宠物窗口能感知到的 SSE 连接状态 */
export type PetSseStatus = "idle" | "active" | "lost";

/** 宠物窗口能感知到的"临时事件"，用于驱动临时气泡 */
export interface PetRetryInfo {
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

export interface PetApprovalInfo {
  count: number;
  toolName: string;
  toolTarget: string | null;
  ruleId?: string;
  createdAt: number;
}

export interface PetClarificationInfo {
  count: number;
  title: string;
  question: string;
  recommendedLabel: string | null;
  createdAt: number;
}

export type PetBudgetLevel = "ok" | "warning" | "blocked";

export interface PetBudgetInfo {
  level: PetBudgetLevel;
  label: string;
  detail: string | null;
  triggered: ("cost" | "turns" | "duration")[];
  peakRatio: number | null;
}

export interface PetSessionInfo {
  id: string;
  agentId: string | null;
  name: string;
  streaming: boolean;
  agentPhase: {
    kind: "waiting_model" | "thinking" | "running_tools";
    tools?: { id: string; name: string }[];
  } | null;
  /** 最后一条 assistant 消息文本，已截断到 200 字符 */
  lastMessage: string;
  /** 第一个进行中的 tool 名称（running_tools 阶段才有） */
  currentTool: string | null;
  /** 进行中的 tool 的"目标"摘要（比如文件名 / 命令前缀），用于气泡副文案 */
  currentToolTarget: string | null;
  /** 自动重试中（auto_retry_start ~ auto_retry_end 之间） */
  retry: PetRetryInfo | null;
  /** 上下文压缩中（手动 compact 或 auto_compaction 之间） */
  compacting: boolean;
  /** 当前 session 是否有待处理的工具审批 */
  pendingApproval: PetApprovalInfo | null;
  /** 当前 session 是否有待处理的 agent 主动追问 */
  pendingClarification: PetClarificationInfo | null;
  /** 当前 session 的预算状态摘要（仅推送到当前活跃 session） */
  budget: PetBudgetInfo | null;
  /** agent 级错误（致命错误，需要主动喊用户） */
  error: string | null;
  /** SSE 连接状态 */
  sseStatus: PetSseStatus;
  /** 该 session 的 streaming 开始时间戳（ms），用于气泡显示"已耗时 Xs" */
  streamingStartedAt: number | null;
  /**
   * 用户是否已"读过"该 session 的最新内容（与主窗口左侧会话列表的未读标识完全一致）。
   * 主窗口判定：isUnread = !active && !isRunning && (!seenAt || seenAt < s.modified)
   * read 取其反，外加 active / running 视为已读。
   * 宠物侧用它决定是否显示 attention 蓝点。
   */
  read: boolean;
}

export interface PetState {
  sessions: PetSessionInfo[];
  focusedSessionId: string | null;
  petVisible: boolean;
  petAlwaysShow: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  isElectron: true;
  isDev: boolean;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "skipped"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string | null;
  releaseName?: string | null;
  releaseNotes?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  publishedAt?: string | null;
  checkedAt?: number | null;
  error?: string | null;
  autoCheckEnabled: boolean;
  skippedVersion?: string | null;
}

export interface UpdaterApi {
  getState(): Promise<UpdateState>;
  check(opts?: { manual?: boolean }): Promise<UpdateState>;
  openDownload(): Promise<boolean>;
  skipVersion(version?: string): Promise<UpdateState>;
  remindLater(): Promise<UpdateState>;
  setAutoCheck(enabled: boolean): Promise<UpdateState>;
  onState(cb: (state: UpdateState) => void): () => void;
}

export interface SelectDirectoryOptions {
  title?: string;
  defaultPath?: string;
}

export interface AppSettings {
  defaultProvider?: string;
  defaultModelId?: string;
  lastCwd?: string;
  fromEnvMigrated?: boolean;
}

export interface SettingsApi {
  open(): Promise<boolean>;
  listProviders(): Promise<string[]>;
  getKey(provider: string): Promise<string | null>;
  setKey(provider: string, value: string): Promise<boolean>;
  deleteKey(provider: string): Promise<boolean>;
  load(): Promise<AppSettings>;
  save(partial: Partial<AppSettings>): Promise<AppSettings>;
  reloadServer(): Promise<{ ok: boolean; base?: string; dev?: boolean }>;
  getProviderEnvMap(): Promise<Record<string, string[]>>;
}

export interface ElectronApi {
  getAppInfo(): Promise<AppInfo>;
  getApiBase(): Promise<string>;
  updater: UpdaterApi;
  selectDirectory(opts?: SelectDirectoryOptions): Promise<string | null>;
  revealInFinder(path: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  /** 同步取拖入 File 的绝对路径；Electron 32+ 之后必须经 webUtils 走 */
  getPathForFile(file: File): string;
  settings: SettingsApi;
  pet: {
    /** 主窗口推送宠物状态（单向，fire-and-forget） */
    sendState(state: PetState): void;
    /** 宠物窗口订阅状态更新，返回取消函数 */
    onState(cb: (state: PetState) => void): () => void;
    /** 宠物窗口请求聚焦主窗口，并切到指定 session */
    focusMain(sessionId?: string): void;
    /** 切换宠物显示/隐藏 */
    setPetVisible(visible: boolean): void;
    /** 宠物窗口拖拽：通知主进程移动窗口 */
    move(pos: { x: number; y: number }): void;
    /**
     * 查询宠物窗口当前所在显示器的工作区（排除任务栏/Dock）。
     * 用于拖拽吸附计算；窗口不存在返回 null。
     */
    getWorkArea(): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>;
    /** 宠物窗口订阅"切换 session"请求（来自宠物点击跳回主窗口），返回取消函数 */
    onSwitchSession(cb: (sessionId: string) => void): () => void;
    /** 动态控制鼠标穿透（true=穿透，false=不穿透） */
    setIgnoreMouse(ignore: boolean): void;
    /** 宠物窗口订阅"自身失焦"事件（点击其他窗口/桌面/App），返回取消函数 */
    onWindowBlur(cb: () => void): () => void;
    /**
     * 宠物窗口请求弹出 native 右键菜单
     * sessions: 全部 agent session（用于"切换会话"子菜单）
     */
    showContextMenu(payload: {
      hasSession: boolean;
      streaming: boolean;
      sessions: { id: string; name: string; focused: boolean }[];
    }): void;
    /** 订阅"切换本地 focus session"（来自菜单），返回取消函数 */
    onSwitchLocalSession(cb: (sessionId: string) => void): () => void;
    /** 订阅"请求中止当前任务"（来自菜单），返回取消函数 */
    onRequestAbort(cb: () => void): () => void;
    /**
     * 宠物窗口请求重连指定 session 的 SSE。
     * 转发给主窗口由它发起 attachSseFor。
     */
    requestReconnect(sessionId: string | null): void;
    /** 主窗口订阅"宠物请求重连 session"事件，返回取消函数 */
    onReconnectSession(cb: (sessionId: string) => void): () => void;
  };
}

declare global {
  interface Window {
    miniPi?: ElectronApi;
  }
}

/** 在浏览器环境返回 null，在 Electron 渲染进程返回 API */
export function getElectronApi(): ElectronApi | null {
  if (typeof window === "undefined") return null;
  return window.miniPi ?? null;
}

/** 同步判断当前是否在 Electron 中（用于条件渲染） */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.miniPi;
}
