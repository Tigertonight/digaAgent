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
