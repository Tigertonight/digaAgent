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
  /** agent 级错误（致命错误，需要主动喊用户） */
  error: string | null;
  /** SSE 连接状态 */
  sseStatus: PetSseStatus;
  /** 该 session 的 streaming 开始时间戳（ms），用于气泡显示"已耗时 Xs" */
  streamingStartedAt: number | null;
  /**
   * 用户是否已看过最新一条 lastMessage。
   * 派生规则：主窗口聚焦 + selectedId === session.id 时为 true。
   * 宠物侧用它决定是否显示 attention 红/蓝点。
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
    /** 宠物窗口订阅"切换 session"请求（来自宠物点击跳回主窗口），返回取消函数 */
    onSwitchSession(cb: (sessionId: string) => void): () => void;
    /** 动态控制鼠标穿透（true=穿透，false=不穿透） */
    setIgnoreMouse(ignore: boolean): void;
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
