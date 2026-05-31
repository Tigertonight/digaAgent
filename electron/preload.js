/**
 * Renderer 端的安全桥。
 *
 * 通过 contextBridge 暴露 window.miniPi.*，在 sandbox + contextIsolation 下也能用。
 * 所有方法都是 thin shim → ipcMain.handle。
 *
 * 设计原则：
 *  - 只暴露 Electron 独有能力（原生 dialog / Finder / OAuth keytar 等）
 *  - 业务 API 继续走 fetch("/api/...")，保证 Web 端代码不分叉
 *  - 渲染进程通过 `if (window.miniPi)` 判断是否在桌面环境
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("miniPi", {
  /**
   * 返回拖入的 File 对象在系统上的绝对路径。
   * Electron 32+ 把 File.path 移除了,必须走 webUtils.getPathForFile。
   * 浏览器 web 模式下渲染进程没有 webUtils,getElectronApi() 会返回 null,调用方自行兜底。
   */
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) ?? "";
    } catch {
      return "";
    }
  },

  /** 标识符 + 版本，用于 renderer 判断 */
  getAppInfo: () => ipcRenderer.invoke("app:getInfo"),

  /** standalone server 的真实 URL（留作未来给 main 进程内部用，renderer 不需要） */
  getApiBase: () => ipcRenderer.invoke("app:getApiBase"),

  /** 弹原生目录选择器，返回绝对路径或 null */
  selectDirectory: (opts) => ipcRenderer.invoke("dialog:selectDirectory", opts),

  /** 在 Finder/Explorer 里高亮一个文件 */
  revealInFinder: (path) => ipcRenderer.invoke("shell:revealInFinder", path),

  /** 用系统默认浏览器打开 URL（用于外链） */
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  /* ---- D3：设置 / keytar ---- */
  settings: {
    /** 列出已存的 provider 名（不返回 key 原文） */
    listProviders: () => ipcRenderer.invoke("settings:listProviders"),
    /** 取一个 provider 的 key（仅设置 UI 用，谨慎暴露） */
    getKey: (provider) => ipcRenderer.invoke("settings:getKey", provider),
    /** 写 key */
    setKey: (provider, value) =>
      ipcRenderer.invoke("settings:setKey", provider, value),
    /** 删 key */
    deleteKey: (provider) =>
      ipcRenderer.invoke("settings:deleteKey", provider),
    /** 拉非敏感配置 */
    load: () => ipcRenderer.invoke("settings:load"),
    /** 写非敏感配置（合并） */
    save: (partial) => ipcRenderer.invoke("settings:save", partial),
    /** 触发主进程重启 standalone server（key 改了后让它重新拉 env） */
    reloadServer: () => ipcRenderer.invoke("settings:reloadServer"),
    /** 已知 provider → env 名映射，给 UI 显示 */
    getProviderEnvMap: () =>
      ipcRenderer.invoke("settings:getProviderEnvMap"),
  },
});
