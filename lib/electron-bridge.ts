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

export interface PetSessionInfo {
  id: string;
  agentId: string | null;
  name: string;
  streaming: boolean;
  agentPhase: {
    kind: "waiting_model" | "thinking" | "running_tools";
    tools?: { id: string; name: string }[];
  } | null;
  lastMessage: string;
  currentTool: string | null;
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
