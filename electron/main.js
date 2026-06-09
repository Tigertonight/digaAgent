/**
 * Electron 主进程入口。
 *
 * 两种模式：
 *  - dev:  ELECTRON_DEV=1，期望外部已经 `npm run dev` 起好 :3000，直接 loadURL
 *  - prod: 默认模式，主进程 fork .next/standalone/server.js 监听随机端口
 *
 * key 透传策略：把主进程 process.env 整个传给 child（含 MINIMAX_CN_API_KEY、OPENAI_API_KEY 等）。
 * 等 D3 做设置窗 + keytar 后，再改成"按需注入"。
 *
 * MINI_PI_WEB_ROOT：文件 API 的根护栏，默认设成 home 目录，避免误删别人文件。
 */
const {
  app,
  BrowserWindow,
  shell,
  dialog,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
} = require("electron");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const settingsModule = require("./settings");
const updaterModule = require("./updater");

const DEV = process.env.ELECTRON_DEV === "1";
const DEV_URL = process.env.ELECTRON_DEV_URL || "http://localhost:3000";
const DISABLE_PET_WINDOW = process.env.ELECTRON_DISABLE_PET === "1";

/**
 * 把 asar 路径转成 asar.unpacked 路径。
 * 启用 asar=true 后，asarUnpack 命中的文件实际落在 Resources/app.asar.unpacked/<...>
 * 而 __dirname / app.getAppPath() 返回的是虚拟路径 Resources/app.asar/<...>。
 * fork() 的目标脚本因为 Node child process 不识别 asar，必须传 unpacked 路径。
 */
function asarUnpackedPath(p) {
  return p.includes(`app.asar${path.sep}`)
    ? p.replace(
        `app.asar${path.sep}`,
        `app.asar.unpacked${path.sep}`
      )
    : p;
}

/** 标准化 standalone 产物路径。dev 下不用。 */
function standaloneServerPath() {
  // 行为说明：
  //   - 用 `npx electron electron/main.js` 直跑时，app.getAppPath() = electron/ 目录，
  //     需要往上一层找 .next/standalone/server.js
  //   - electron-builder 打包后，main 由 package.json#main 指向 electron/main.js，
  //     app.getAppPath() = Resources/app，.next 也在同级
  // 统一用 __dirname 上一层做项目根，两种场景都对。
  // asar 开启后 __dirname 是 app.asar 虚拟路径；require() 能透明读，无需转 unpacked。
  const root = path.resolve(__dirname, "..");
  return path.join(root, ".next", "standalone", "server.js");
}

/** 拿一个空闲端口 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询直到 server 起来 */
async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode != null && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let serverChild = null;
/** standalone server 的 base URL，IPC getApiBase 返回 */
let apiBase = null;
/** 主窗口必须保留强引用，否则加载完成后可能被 GC 回收成无窗口进程。 */
let mainWin = null;
/** macOS menu bar / tray icon 必须保留强引用，否则会被 GC 回收。 */
let tray = null;

function getPrimaryMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) return mainWin;
  return BrowserWindow.getAllWindows().find(
    (w) =>
      w !== petWin &&
      (settingsWin ? w !== settingsWin : true) &&
      !w.isDestroyed()
  );
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  app.focus({ steal: true });
  win.focus();
  return true;
}

async function openMainWindow() {
  const win = getPrimaryMainWindow();
  if (focusWindow(win)) return win;
  return createWindow();
}

function createTrayIcon() {
  const iconPath = DEV
    ? path.resolve(__dirname, "..", "build", "trayTemplate.png")
    : path.join(process.resourcesPath, "trayTemplate.png");
  const retinaIconPath = DEV
    ? path.resolve(__dirname, "..", "build", "trayTemplate@2x.png")
    : path.join(process.resourcesPath, "trayTemplate@2x.png");
  const image = nativeImage.createFromBuffer(fs.readFileSync(iconPath));
  if (fs.existsSync(retinaIconPath)) {
    image.addRepresentation({
      scaleFactor: 2,
      buffer: fs.readFileSync(retinaIconPath),
    });
  }
  if (image.isEmpty()) {
    console.warn(`[electron] tray icon is empty: ${iconPath}`);
  }
  return image;
}

function updateTrayMenu() {
  if (!tray) return;
  const petVisible = !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
  const template = [
    {
      label: "打开 Diga Agent",
      click: () => void openMainWindow(),
    },
    {
      label: "设置…",
      accelerator: process.platform === "darwin" ? "Cmd+," : "Ctrl+,",
      click: () => void openSettingsWindow(),
    },
    {
      label: petVisible ? "隐藏宠物" : "显示宠物",
      click: async () => {
        if (DISABLE_PET_WINDOW) return;
        const base = apiBase || DEV_URL;
        if (!petWin || petWin.isDestroyed()) {
          await createPetWindow(base);
        }
        if (!petWin || petWin.isDestroyed()) return;
        if (petWin.isVisible()) petWin.hide();
        else petWin.show();
        updateTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "检查更新",
      enabled: !DEV,
      click: () => {
        void updaterModule.checkForUpdates({ manual: true });
      },
    },
    { type: "separator" },
    {
      label: "退出 Diga Agent",
      accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
      click: () => app.quit(),
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  if (tray) return tray;
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setImage(icon);
  tray.setToolTip("Diga Agent");
  tray.on("click", () => void openMainWindow());
  tray.on("right-click", () => {
    updateTrayMenu();
    tray.popUpContextMenu();
  });
  updateTrayMenu();
  console.log("[electron] tray created");
  if (DEV) {
    setTimeout(() => {
      if (!tray) return;
      console.log("[electron] tray bounds", tray.getBounds());
    }, 1000).unref();
  }
  return tray;
}

function attachWindowDiagnostics(win, label) {
  if (!DEV) return;
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.warn(
        `[electron:${label}:did-fail-load] ${errorCode} ${errorDescription} ${validatedURL} mainFrame=${isMainFrame}`
      );
    }
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    console.warn(`[electron:${label}:render-process-gone]`, details);
  });
}

async function startStandaloneServer() {
  const port = await getFreePort();
  const serverFile = standaloneServerPath();
  // wrapper 被 asarUnpack：fork 的目标必须走 unpacked 物理路径，Node child 不识别 asar
  const wrapperFile = asarUnpackedPath(path.join(__dirname, "server-wrapper.js"));
  console.log(
    `[electron] forking standalone server via wrapper: ${serverFile} on :${port} (wrapper=${wrapperFile})`
  );

  // 从 keytar 收集 key → env，注入 child
  // 优先级策略：
  //   - 默认（PROD）：keytar 覆盖 process.env，所见即所得（UI 删了就真没了）
  //   - 设 MINI_PI_PREFER_ENV=1：env 覆盖 keytar（开发者 dev 时常用）
  //
  // 实现方式：基于 process.env 副本，就地 patch；不重建 env 字典。
  // 之前重建字典 + delete undefined 的写法在 Electron 24 下导致 fork 出来的
  // Node 找不到 require 的绝对路径（疑似某些 Electron 注入的内部 env 被破坏）。
  // 见 D3-8 调试记录。
  const keytarEnv = await settingsModule.buildEnvFromKeytar().catch((e) => {
    console.warn("[electron] buildEnvFromKeytar failed:", e.message);
    return {};
  });
  const preferEnv = process.env.MINI_PI_PREFER_ENV === "1";
  const mergedEnv = { ...process.env };

  if (preferEnv) {
    // env-wins: 只补 keytar 里有、env 里没有的
    for (const [k, v] of Object.entries(keytarEnv)) {
      if (mergedEnv[k] === undefined || mergedEnv[k] === "") mergedEnv[k] = v;
    }
  } else {
    // keytar-wins: 先擦 PROVIDER_ENV_MAP 列表里所有已知 key env，再写入 keytar 的
    const knownEnvNames = new Set(
      Object.values(settingsModule.PROVIDER_ENV_MAP).flat()
    );
    for (const name of knownEnvNames) {
      delete mergedEnv[name];
    }
    for (const [k, v] of Object.entries(keytarEnv)) {
      mergedEnv[k] = v;
    }
  }

  // 固定字段（端口/hostname/wrapper 元信息）
  mergedEnv.PORT = String(port);
  mergedEnv.HOSTNAME = "127.0.0.1";
  mergedEnv.MINI_PI_WEB_ROOT = process.env.MINI_PI_WEB_ROOT || os.homedir();
  mergedEnv.NODE_ENV = "production";
  mergedEnv.MINI_PI_SERVER_ENTRY = serverFile;
  mergedEnv.MINI_PI_PARENT_PID = String(process.pid);

  const keysFromKeytar = Object.keys(keytarEnv);
  console.log(
    `[electron] env strategy: ${preferEnv ? "env-wins (dev)" : "keytar-wins (prod)"}; keytar provides ${keysFromKeytar.length}: ${keysFromKeytar.join(", ") || "(none)"}`
  );

  // D3-8 调试：dump child vs parent env keys 差异
  if (process.env.MINI_PI_DEBUG_ENV === "1") {
    const parentKeys = new Set(Object.keys(process.env));
    const childKeys = new Set(Object.keys(mergedEnv));
    const onlyInParent = [...parentKeys].filter((k) => !childKeys.has(k)).sort();
    const onlyInChild = [...childKeys].filter((k) => !parentKeys.has(k)).sort();
    console.log(
      `[electron] env diff: parent=${parentKeys.size}, child=${childKeys.size}`
    );
    console.log(`[electron] only-in-parent (${onlyInParent.length}):`, onlyInParent);
    console.log(`[electron] only-in-child  (${onlyInChild.length}):`, onlyInChild);
  }

  // 走 wrapper：parent 死了它会自杀（防 Electron 被 SIGKILL 时留孤儿）
  serverChild = fork(wrapperFile, [], {
    env: mergedEnv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  serverChild.on("exit", (code, signal) => {
    console.log(`[electron] server exited code=${code} signal=${signal}`);
    serverChild = null;
    // 如果 app 还活着，意味着 server 异常挂掉，整个退出
    if (!app.isQuitting) {
      app.quit();
    }
  });

  // 优先用 wrapper 的 IPC ready 信号（HTTP listen 一就绪立刻收到），
  // 失败回退到 200ms 步进的 waitForHttp 探测。省 200-400ms 冷启动。
  const ipcReady = new Promise((resolve) => {
    const onMsg = (msg) => {
      if (msg && msg.type === "server-ready") {
        serverChild?.off?.("message", onMsg);
        resolve(true);
      }
    };
    serverChild.on("message", onMsg);
  });
  const ready = await Promise.race([
    ipcReady,
    waitForHttp(`http://127.0.0.1:${port}/api/health`),
  ]);
  if (!ready) {
    throw new Error(`standalone server failed to become ready on :${port}`);
  }
  apiBase = `http://127.0.0.1:${port}`;
  return apiBase;
}

/**
 * [PoC] webview 容器方案验证：通过 webContents.debugger（CDP）控制 <webview>。
 *
 * 验证目标：Electron 主进程能否 attach 到 webview 的 webContents，执行 CDP 命令
 * （导航/截图/取 DOM），从而替代当前「Playwright 独立 Chromium + 截图流」方案，
 * 让画面原生渲染、所见即所控。
 *
 * 这是隔离的实验通道（webviewPoc:*），不触碰现有 /api/browser 与 screencast 路径。
 */
function registerWebviewPocIpc() {
  const { webContents } = require("electron");

  /** 拿到 webview 的 webContents（前端传 getWebContentsId() 的返回值） */
  function getWebviewContents(webContentsId) {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`webview webContents not found: ${webContentsId}`);
    }
    return wc;
  }

  /** 确保 debugger 已 attach（幂等） */
  function ensureDebuggerAttached(wc) {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach("1.3");
    }
  }

  // attach debugger 到指定 webview，验证 CDP 通道可用
  ipcMain.handle("webviewPoc:attach", async (_e, webContentsId) => {
    const wc = getWebviewContents(webContentsId);
    ensureDebuggerAttached(wc);
    // 启用核心 CDP domain，验证命令可下发
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("DOM.enable");
    await wc.debugger.sendCommand("Runtime.enable");
    return { ok: true, attached: wc.debugger.isAttached() };
  });

  // 通过 CDP 导航（区别于 webview.src，验证 agent 可主动驱动导航）
  ipcMain.handle("webviewPoc:navigate", async (_e, webContentsId, url) => {
    const wc = getWebviewContents(webContentsId);
    ensureDebuggerAttached(wc);
    try {
      await wc.debugger.sendCommand("Page.navigate", { url });
      return { ok: true, url };
    } catch (e) {
      // Chromium may abort an in-flight same-target navigation when the webview
      // receives a newer load request. Treat that as non-fatal for the PoC IPC.
      if (e && (e.code === "ERR_ABORTED" || e.errno === -3)) {
        return { ok: true, url, aborted: true };
      }
      throw e;
    }
  });

  // 取页面标题/URL（验证 DOM/Runtime 读取链路）
  ipcMain.handle("webviewPoc:inspect", async (_e, webContentsId) => {
    const wc = getWebviewContents(webContentsId);
    ensureDebuggerAttached(wc);
    const titleEval = await wc.debugger.sendCommand("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    const urlEval = await wc.debugger.sendCommand("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    return {
      ok: true,
      title: titleEval?.result?.value ?? null,
      url: urlEval?.result?.value ?? null,
    };
  });

  // CDP 截图（验证画面采集；对比 screencast，这里是按需单帧）
  ipcMain.handle("webviewPoc:screenshot", async (_e, webContentsId) => {
    const wc = getWebviewContents(webContentsId);
    const image = await Promise.race([
      wc.capturePage(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("webview screenshot timed out")), 8000)
      ),
    ]);
    return {
      ok: true,
      dataUrl: image && typeof image.toDataURL === "function" ? image.toDataURL() : null,
    };
  });

  // CDP 坐标点击（验证 agent 操控链路：Input.dispatchMouseEvent）
  ipcMain.handle("webviewPoc:click", async (_e, webContentsId, x, y) => {
    const wc = getWebviewContents(webContentsId);
    ensureDebuggerAttached(wc);
    const base = { x, y, button: "left", clickCount: 1 };
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...base,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...base,
    });
    return { ok: true, x, y };
  });

  // detach（清理）
  ipcMain.handle("webviewPoc:detach", async (_e, webContentsId) => {
    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
      wc.debugger.detach();
    }
    return { ok: true };
  });
}

/**
 * 注册 IPC handlers。
 * 命名约定：domain:action（例如 "shell:openExternal"）
 */
function registerIpc() {
  registerWebviewPocIpc();
  updaterModule.registerUpdateIpc({
    app,
    ipcMain,
    shell,
    getWindow: () => mainWin,
  });

  ipcMain.handle("app:getInfo", () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isElectron: true,
    isDev: DEV,
  }));

  ipcMain.handle("app:getApiBase", () => apiBase || DEV_URL);

  ipcMain.handle("dialog:selectDirectory", async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: opts?.title ?? "选择目录",
      defaultPath: opts?.defaultPath ?? os.homedir(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("shell:revealInFinder", (_event, filePath) => {
    if (typeof filePath !== "string" || !filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle("shell:openExternal", async (_event, url) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  /* ---- D3：设置 IPC ---- */
  ipcMain.handle("settings:open", async () => {
    await openSettingsWindow();
    return true;
  });
  ipcMain.handle("settings:listProviders", () =>
    settingsModule.listStoredProviders()
  );
  ipcMain.handle("settings:getKey", (_e, provider) =>
    settingsModule.getKey(provider)
  );
  ipcMain.handle("settings:setKey", (_e, provider, value) =>
    settingsModule.setKey(provider, value)
  );
  ipcMain.handle("settings:deleteKey", (_e, provider) =>
    settingsModule.deleteKey(provider)
  );
  ipcMain.handle("settings:load", () => settingsModule.loadSettings(app));
  ipcMain.handle("settings:save", (_e, partial) =>
    settingsModule.saveSettings(app, partial)
  );
  ipcMain.handle("settings:getProviderEnvMap", () =>
    settingsModule.PROVIDER_ENV_MAP
  );

  /**
   * reloadServer：杀掉当前 standalone child，等 wrapper 死透，再 fork 一个。
   * 这样新 keytar key 立刻生效，无需重启 Electron。
   * 主窗口随后 reload 一下 URL（端口会变）。
   */
  ipcMain.handle("settings:reloadServer", async () => {
    if (DEV) return { ok: true, dev: true }; // dev 模式不动外部 next dev
    console.log("[electron] settings:reloadServer requested");
    killServerChild("reloadServer");
    // 等 child 真死
    await new Promise((r) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (!serverChild || serverChild.killed || Date.now() - t0 > 3000) {
          clearInterval(tick);
          r();
        }
      }, 50);
    });
    serverChild = null;
    apiBase = null;
    const newBase = await startStandaloneServer();
    // 通知所有窗口 reload
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        await win.loadURL(newBase);
      } catch (e) {
        console.warn("[electron] reload window failed:", e.message);
      }
    }
    return { ok: true, base: newBase };
  });

  // ===== 宠物挂件 IPC =====

  // 主窗口渲染进程推来的状态 → 转发给宠物窗口
  ipcMain.on("pet:state-from-main", (_event, state) => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send("pet:state", state);
    }
  });

  // 宠物窗口请求聚焦主窗口，并可选切换 session
  ipcMain.on("pet:focus-main", (_event, sessionId) => {
    const mainWin = getPrimaryMainWindow();
    if (focusWindow(mainWin)) {
      if (sessionId) {
        mainWin.webContents.send("pet:switch-session", sessionId);
      }
    }
  });

  /**
   * 宠物窗口请求重连指定 session 的 SSE。
   * 宠物侧没有 EventSource，必须经主进程转发给主窗口由它发起重连。
   * 主窗口订阅 pet:reconnect-session，找到对应 runner key 后调 attachSseFor()。
   */
  ipcMain.on("pet:reconnect-session", (_event, sessionId) => {
    if (!sessionId) return;
    const mainWin = getPrimaryMainWindow();
    if (mainWin) {
      mainWin.webContents.send("pet:reconnect-session", sessionId);
    }
  });

  // 控制宠物窗口显示/隐藏
  ipcMain.on("pet:set-visible", (_event, visible) => {
    if (!petWin || petWin.isDestroyed()) return;
    if (visible) petWin.show();
    else petWin.hide();
    updateTrayMenu();
  });

  // 宠物拖拽：移动宠物窗口位置
  ipcMain.on("pet:move", (_event, { x, y }) => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.setPosition(Math.round(x), Math.round(y));
    }
  });

  /**
   * 返回宠物窗口当前所在显示器的工作区（排除任务栏/Dock）。
   * 用于渲染层边缘吸附计算 —— renderer 用 window.screenX/Y 知道自己位置，
   * 但拿不到屏幕边界，必须由主进程提供。
   *
   * 多显示器：以宠物窗口当前位置所在的 display 为准（不是 primary），
   * 这样跨屏拖拽时吸附边界正确。
   */
  ipcMain.handle("pet:get-work-area", () => {
    if (!petWin || petWin.isDestroyed()) return null;
    const { screen } = require("electron");
    const [winX, winY] = petWin.getPosition();
    const [winW, winH] = petWin.getSize();
    // 以窗口中心点所在显示器为基准
    const centerX = winX + winW / 2;
    const centerY = winY + winH / 2;
    const display = screen.getDisplayNearestPoint({
      x: Math.round(centerX),
      y: Math.round(centerY),
    });
    const wa = display.workArea; // { x, y, width, height }
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  });

  // 动态控制鼠标穿透：有 UI 交互时关闭穿透，空白区域继续穿透
  ipcMain.on("pet:set-ignore-mouse", (_event, ignore) => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  /**
   * 右键菜单（P1）
   * 用 native Menu.popup 而非 DOM 实现：
   *  - 320×400 的宠物窗 + transparent，DOM 菜单超出会被裁剪
   *  - native 菜单可弹到屏幕任意位置 + 系统级一致体验 + 失焦自动关
   *
   * payload schema（renderer 传入）：
   *   {
   *     hasSession: boolean,           // 当前是否有 displaySession
   *     streaming: boolean,            // 当前 session 是否在流式
   *     sessions: [{id, name, focused}],// 全部 agent session 列表，用于"切换会话"子菜单
   *   }
   */
  ipcMain.on("pet:show-context-menu", (event, payload = {}) => {
    if (!petWin || petWin.isDestroyed()) return;
    const hasSession = !!payload.hasSession;
    const streaming = !!payload.streaming;
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

    const template = [
      {
        label: "打开主窗口",
        accelerator: "CmdOrCtrl+1",
        click: () => {
          // 复用 pet:focus-main 行为：找到主窗 + show/focus
          void openMainWindow();
        },
      },
      // 切换会话子菜单：>1 个 session 才显示
      ...(sessions.length > 1
        ? [
            {
              label: "切换会话",
              submenu: sessions.map((s) => ({
                label: s.name || "(未命名)",
                type: "radio",
                checked: !!s.focused,
                click: () => {
                  if (!petWin || petWin.isDestroyed()) return;
                  // 直接告诉 renderer 切换 localFocusId
                  petWin.webContents.send("pet:switch-local-session", s.id);
                },
              })),
            },
          ]
        : []),
      {
        label: streaming ? "暂停当前任务" : "暂停当前任务（无运行中）",
        enabled: streaming,
        click: () => {
          if (!petWin || petWin.isDestroyed()) return;
          petWin.webContents.send("pet:request-abort");
        },
      },
      { type: "separator" },
      {
        label: "设置…",
        accelerator: process.platform === "darwin" ? "Cmd+," : "Ctrl+,",
        click: () => void openSettingsWindow(),
      },
      {
        label: "隐藏宠物",
        click: () => {
          if (petWin && !petWin.isDestroyed()) petWin.hide();
          updateTrayMenu();
          // v1 没暴露"再次显示"入口，但主窗口设置里可控
          // 主窗启动时会自动 createPetWindow，下次重启可见
        },
      },
      { type: "separator" },
      {
        label: "退出 Diga Agent",
        accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
        click: () => app.quit(),
      },
    ];

    // 不引用 hasSession 也合法：暂停项已用 streaming 控制；保留预留位
    void hasSession;

    const menu = Menu.buildFromTemplate(template);
    // 不传 x/y → Electron 自动用当前鼠标位置弹出，正是用户右键的位置
    menu.popup({ window: petWin });
  });
}

async function createWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    focusWindow(mainWin);
    return mainWin;
  }
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    // 实测算法:sidebar 260 + main 360(min) + splitter 4 + files 200(min) ≈ 824
    // 给个边距,880 保证组件不重叠
    minWidth: 880,
    minHeight: 600,
    title: "Diga Agent",
    webPreferences: {
      // 渲染进程就是 Next 的页面，sandbox 模式下走 preload 安全暴露 IPC
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      // 中文/拼音 IME 下 Chromium spellcheck 会卡输入；本应用纯代码/聊天，关掉
      spellcheck: false,
      // 流式期间窗口被遮挡也不要降帧（Electron 默认 30s 后会节流）
      backgroundThrottling: false,
      // [PoC] 开启 <webview> 标签，用于 browser use 的 webview 容器方案验证。
      // 仅启用标签能力，是否真正使用由前端实验开关控制，不影响现有 screencast 路径。
      webviewTag: true,
    },
    backgroundColor: "#0a0a0a",
  });

  // 外链用系统浏览器打开，不要在 Electron 内导航
  const win = mainWin;
  attachWindowDiagnostics(win, "main");

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const url = DEV ? DEV_URL : apiBase || await startStandaloneServer();
  console.log(`[electron] loading ${url}`);

  // dev 下 next dev 启动可能需要时间，做个简单 retry
  if (DEV) {
    const ok = await waitForHttp(`${url}/api/health`, 30000);
    if (!ok) {
      console.error(`[electron] dev server not reachable at ${url}; 请先 npm run dev`);
    }
  }

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  await win.loadURL(url);
  console.log(`[electron] main window loaded ${url}`);
  if (!DEV) {
    updaterModule.checkOnStartup();
  }
  if (!win.isVisible()) {
    win.show();
  }
  // Desktop automation and fullscreen Spaces can leave a visible Electron window
  // outside the active Space. Bring the main window onto the current desktop
  // before focusing so Computer Use and normal users can actually reach it.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.center();
  win.show();
  win.moveTop();
  app.focus({ steal: true });
  win.focus();
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setVisibleOnAllWorkspaces(false);
    }
  }, 2000).unref();
  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
    updateTrayMenu();
  });
  return win;
}

/**
 * 设置窗口（独立 BrowserWindow，加载 /settings 路由）
 * 单例，已存在就 focus。
 */
let settingsWin = null;
async function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 600,
    minHeight: 480,
    title: "Diga Agent · 设置",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      spellcheck: false,
      backgroundThrottling: false,
    },
    backgroundColor: "#0a0a0a",
    parent: BrowserWindow.getAllWindows()[0] ?? undefined,
  });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  attachWindowDiagnostics(settingsWin, "settings");
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  const base = apiBase || DEV_URL;
  await settingsWin.loadURL(`${base}/settings`);
  return settingsWin;
}

let petWin = null;

async function createPetWindow(baseUrl) {
  if (petWin && !petWin.isDestroyed()) return petWin;

  const { screen } = require("electron");
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // 窗口足够大以容纳气泡/卡片弹出，宠物 sprite 固定在右下角
  petWin = new BrowserWindow({
    width: 320,
    height: 400,
    x: width - 340,
    y: height - 420,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // 默认透明区域穿透（forward=true），有内容时渲染进程通知关闭穿透
  petWin.setIgnoreMouseEvents(true, { forward: true });
  attachWindowDiagnostics(petWin, "pet");
  petWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  petWin.on("closed", () => {
    petWin = null;
    updateTrayMenu();
  });
  // 失焦时通知 renderer 关闭可关闭的浮层（如卡片）
  // 触发场景：用户点击其他窗口 / 点击桌面 / 切到别的 App
  petWin.on("blur", () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send("pet:window-blur");
    }
  });

  await petWin.loadURL(`${baseUrl}/pet`);
  updateTrayMenu();
  return petWin;
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "设置…",
                accelerator: "Cmd+,",
                click: () => void openSettingsWindow(),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(isMac
          ? []
          : [
              {
                label: "Settings…",
                accelerator: "Ctrl+,",
                click: () => void openSettingsWindow(),
              },
              { type: "separator" },
            ]),
        { role: isMac ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Learn More",
          click: () =>
            void shell.openExternal(
              "https://github.com/earendil-works/pi-coding-agent"
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  registerIpc();
  buildAppMenu();
  createTray();

  // 一次性 env → keytar 迁移（首次启动若 keytar 空且 env 里有 key，自动入库）
  try {
    const migrated = await settingsModule.migrateFromEnvIfNeeded(app);
    if (migrated.length > 0) {
      console.log(
        `[electron] migrated env keys to keytar: ${migrated.join(", ")}`
      );
    }
  } catch (e) {
    console.warn("[electron] env→keytar migration failed:", e.message);
  }

  try {
    await createWindow();
  } catch (e) {
    console.error("[electron] failed to start:", e);
    app.quit();
  }

  // 启动宠物窗口；验收/自动化可通过 env 关闭，避免透明悬浮窗干扰可访问性遍历。
  if (!DISABLE_PET_WINDOW) {
    const petBase = apiBase || DEV_URL;
    try {
      await createPetWindow(petBase);
    } catch (e) {
      console.warn("[electron] pet window failed to start:", e.message);
    }
  }

  app.on("activate", () => {
    void openMainWindow();
  });
});

/** 同步 best-effort kill；多次调用安全 */
function killServerChild(reason) {
  if (!serverChild || serverChild.killed) return;
  console.log(`[electron] killing standalone server (${reason})`);
  try {
    serverChild.kill("SIGTERM");
  } catch (e) {
    console.warn("[electron] SIGTERM failed:", e);
  }
  // 兜底：500ms 还没死就 SIGKILL
  const pid = serverChild.pid;
  setTimeout(() => {
    if (pid) {
      try {
        process.kill(pid, 0); // 探活
        console.warn(`[electron] server pid=${pid} still alive after SIGTERM, SIGKILL`);
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    }
  }, 500).unref();
}

app.on("before-quit", () => {
  app.isQuitting = true;
  killServerChild("before-quit");
});

app.on("will-quit", () => killServerChild("will-quit"));

// 同步阶段最后一次机会
process.on("exit", () => {
  if (serverChild && !serverChild.killed && serverChild.pid) {
    try {
      process.kill(serverChild.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
});

// Electron 主进程被信号杀掉时也尝试带走 child
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    killServerChild(`main got ${sig}`);
    // 走标准 quit 流程，触发 before-quit 等
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
