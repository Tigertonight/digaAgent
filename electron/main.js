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
 * DIGA_AGENT_WEB_ROOT：文件 API 的根护栏，默认设成 home 目录，避免误删别人文件。
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
const { fork, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const settingsModule = require("./settings");
const updaterModule = require("./updater");
const securityPolicy = require("./security-policy");
const diagLogger = require("./diag-logger");
const diagCollector = require("./diag-collector");
const powerSave = require("./power-save");

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
function getFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function isTailscaleIPv4(ip) {
  const parts = String(ip).split(".").map((x) => Number(x));
  return (
    parts.length === 4 &&
    parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) &&
    parts[0] === 100 &&
    parts[1] >= 64 &&
    parts[1] <= 127
  );
}

function bindHostForRemoteMode(mode) {
  if (mode === "off") return "127.0.0.1";
  if (mode === "lan") return "0.0.0.0";
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (!item.internal && item.family === "IPv4" && isTailscaleIPv4(item.address)) {
        return item.address;
      }
    }
  }
  return "127.0.0.1";
}

function loadRemoteAccessSettings() {
  const remote = settingsModule.loadSettings(app).remoteAccess || {};
  const mode = remote.mode === "vpn" || remote.mode === "lan" ? remote.mode : "off";
  return {
    mode,
    port:
      Number.isInteger(remote.port) && remote.port > 0
        ? remote.port
        : 37373,
  };
}

function resolveExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveCloudflaredPath() {
  const configured = process.env.DIGA_AGENT_CLOUDFLARED_PATH?.trim();
  return resolveExecutable([
    configured,
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ]);
}

function resolveBrewPath() {
  return resolveExecutable([
    process.env.HOMEBREW_PREFIX
      ? path.join(process.env.HOMEBREW_PREFIX, "bin", "brew")
      : null,
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
  ]);
}

function runCommand(command, args, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          process.env.PATH,
        ]
          .filter(Boolean)
          .join(":"),
      },
    });
    const append = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 20000) output = output.slice(-20000);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        ok: false,
        code: null,
        output,
        error: "安装超时，请稍后重试或在终端运行：brew install cloudflared",
      });
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output, error: e.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        output,
        error: code === 0 ? null : `命令退出码 ${code ?? "unknown"}`,
      });
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
let localSessionSecret = crypto.randomBytes(32).toString("base64url");
let localSecretHeaderHookInstalled = false;
/** 主窗口必须保留强引用，否则加载完成后可能被 GC 回收成无窗口进程。 */
let mainWin = null;
/** macOS menu bar / tray icon 必须保留强引用，否则会被 GC 回收。 */
let tray = null;

function applyPowerSaveFromSettings() {
  const settings = settingsModule.loadSettings(app);
  const enabled = Boolean(settings.keepAwake && settings.keepAwake.enabled);
  const status = powerSave.setKeepAwakeEnabled(enabled);
  console.log(
    `[electron] keepAwake ${status.enabled ? "enabled" : "disabled"}${status.id ? ` id=${status.id}` : ""}`
  );
  return status;
}

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

async function reloadMainWindow(win, url) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.stop();
  } catch {
    /* ignore */
  }
  win.show();
  win.focus();
  await win.loadURL(url);
  if (!win.isDestroyed()) {
    win.show();
    win.moveTop();
    win.focus();
    if (typeof win.webContents.invalidate === "function") {
      win.webContents.invalidate();
    }
  }
}

function installLocalSecretHeaderHook() {
  if (localSecretHeaderHookInstalled) return;
  localSecretHeaderHookInstalled = true;
  const ses = require("electron").session.defaultSession;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const target = new URL(details.url);
      const bases = [apiBase, DEV_URL].filter(Boolean).map((raw) => new URL(raw));
      const sameAppOrigin = bases.some(
        (base) =>
          target.protocol === base.protocol &&
          target.hostname === base.hostname &&
          target.port === base.port
      );
      if (sameAppOrigin) {
        details.requestHeaders["x-diga-agent-local-secret"] = localSessionSecret;
      }
    } catch {
      // leave headers untouched
    }
    callback({ requestHeaders: details.requestHeaders });
  });
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
  // Diag-1：生产也要订阅，以便“白屏 / chunk 加载失败 / renderer 崩溃”进入 diag
  // ring buffer 并能在“导出诊断信息”里看到。
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const line = `[${label}:did-fail-load] code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`;
      console.warn("[electron]", line);
      try {
        diagLogger.logDiag("warn", "renderer", line);
      } catch {
        /* ignore */
      }
    }
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    const line = `[${label}:render-process-gone] reason=${details && details.reason} exitCode=${details && details.exitCode}`;
    console.warn("[electron]", line);
    try {
      diagLogger.logDiag("error", "renderer", line);
    } catch {
      /* ignore */
    }
  });
  win.webContents.on("unresponsive", () => {
    const line = `[${label}:unresponsive]`;
    console.warn("[electron]", line);
    try {
      diagLogger.logDiag("warn", "renderer", line);
    } catch {
      /* ignore */
    }
  });
  win.webContents.on("console-message", (_event, level, message, _line, sourceId) => {
    // 只抓 error 级别的 renderer console，避免震荡 ring buffer。level: 0=verbose 1=info 2=warning 3=error
    if (level !== 3) return;
    try {
      diagLogger.logDiag("error", "renderer", `[${label}] ${message} (${sourceId || ""})`);
    } catch {
      /* ignore */
    }
  });
}

async function startStandaloneServer() {
  const remote = loadRemoteAccessSettings();
  const bindHost = bindHostForRemoteMode(remote.mode);
  const port = remote.mode === "off" ? await getFreePort(bindHost) : remote.port;
  const serverFile = standaloneServerPath();
  // wrapper 被 asarUnpack：fork 的目标必须走 unpacked 物理路径，Node child 不识别 asar
  const wrapperFile = asarUnpackedPath(path.join(__dirname, "server-wrapper.js"));
  console.log(
    `[electron] forking standalone server via wrapper: ${serverFile} on ${bindHost}:${port} remote=${remote.mode} (wrapper=${wrapperFile})`
  );

  // 从 keytar 收集 key → env，注入 child
  // 优先级策略：
  //   - 默认（PROD）：keytar 覆盖 process.env，所见即所得（UI 删了就真没了）
  //   - 设 DIGA_AGENT_PREFER_ENV=1：env 覆盖 keytar（开发者 dev 时常用）
  //
  // 实现方式：基于 process.env 副本，就地 patch；不重建 env 字典。
  // 之前重建字典 + delete undefined 的写法在 Electron 24 下导致 fork 出来的
  // Node 找不到 require 的绝对路径（疑似某些 Electron 注入的内部 env 被破坏）。
  // 见 D3-8 调试记录。
  const keytarEnv = await settingsModule.buildEnvFromKeytar().catch((e) => {
    console.warn("[electron] buildEnvFromKeytar failed:", e.message);
    return {};
  });
  const preferEnv = process.env.DIGA_AGENT_PREFER_ENV === "1";
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
  mergedEnv.HOSTNAME = bindHost;
  mergedEnv.DIGA_AGENT_WEB_ROOT = process.env.DIGA_AGENT_WEB_ROOT || os.homedir();
  mergedEnv.DIGA_AGENT_SETTINGS_FILE = settingsModule.settingsFile(app);
  mergedEnv.DIGA_AGENT_LOCAL_SECRET = localSessionSecret;
  mergedEnv.NODE_ENV = "production";
  mergedEnv.DIGA_AGENT_SERVER_ENTRY = serverFile;
  mergedEnv.DIGA_AGENT_PARENT_PID = String(process.pid);

  const keysFromKeytar = Object.keys(keytarEnv);
  console.log(
    `[electron] env strategy: ${preferEnv ? "env-wins (dev)" : "keytar-wins (prod)"}; keytar provides ${keysFromKeytar.length}: ${keysFromKeytar.join(", ") || "(none)"}`
  );

  // D3-8 调试：dump child vs parent env keys 差异
  if (process.env.DIGA_AGENT_DEBUG_ENV === "1") {
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
  // 从“stdio: inherit”改为“pipe”，让 diagLogger 能记下 server 子进程的 stdout/stderr；
  // 这是诊断包中“server 启动失败”问题唯一可靠的证据源。
  // 同时原艸 inherit 会拍到 Console.app，TUI 调试不交互。
  serverChild = fork(wrapperFile, [], {
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  diagLogger.attachChildProcess(serverChild, "server");

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
    waitForHttp(
      `http://${bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost}:${port}/api/health`
    ),
  ]);
  if (!ready) {
    throw new Error(`standalone server failed to become ready on :${port}`);
  }
  apiBase = `http://${bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost}:${port}`;
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

  /**
   * 校验 IPC sender 是主窗口 / 设置窗 / 宠物窗之一，不接受未知 webContents
   * （例如被嵌入 <webview> 中的页面伪造 IPC，虽然 contextIsolation 下
   * 极不可能，但多一道门锁不赔）。
   */
  function assertSenderIsAppWindow(sender) {
    const known = [mainWin, settingsWin, petWin]
      .filter(Boolean)
      .map((win) => win.webContents.id);
    if (!known.includes(sender.id)) {
      throw new Error(
        `webviewPoc IPC rejected: sender ${sender.id} is not a known app window`
      );
    }
  }

  /**
   * 拿到 webview 的 webContents。狭化点（fix-S2.b）：
   *   - 必须存在且未销毁
   *   - type 必须是 "webview"——避免调用方传入主窗口 / 设置窗
   *     的 webContentsId 后越权控制。
   *   - hostWebContents 必须是 sender。防 A 窗口拿 B 窗口下的 webview。
   */
  function getWebviewContents(sender, webContentsId) {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`webview webContents not found: ${webContentsId}`);
    }
    if (wc.getType() !== "webview") {
      throw new Error(
        `webviewPoc IPC rejected: target is type=${wc.getType()}, expected webview`
      );
    }
    if (
      wc.hostWebContents &&
      sender &&
      wc.hostWebContents.id !== sender.id
    ) {
      throw new Error(
        "webviewPoc IPC rejected: webview does not belong to caller window"
      );
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
  ipcMain.handle("webviewPoc:attach", async (e, webContentsId) => {
    assertSenderIsAppWindow(e.sender);
    const wc = getWebviewContents(e.sender, webContentsId);
    ensureDebuggerAttached(wc);
    // 启用核心 CDP domain，验证命令可下发
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("DOM.enable");
    await wc.debugger.sendCommand("Runtime.enable");
    return { ok: true, attached: wc.debugger.isAttached() };
  });

  // 通过 CDP 导航（区别于 webview.src，验证 agent 可主动驱动导航）
  ipcMain.handle("webviewPoc:navigate", async (e, webContentsId, url) => {
    assertSenderIsAppWindow(e.sender);
    const wc = getWebviewContents(e.sender, webContentsId);
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
  ipcMain.handle("webviewPoc:inspect", async (e, webContentsId) => {
    assertSenderIsAppWindow(e.sender);
    const wc = getWebviewContents(e.sender, webContentsId);
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
  ipcMain.handle("webviewPoc:screenshot", async (e, webContentsId) => {
    assertSenderIsAppWindow(e.sender);
    const wc = getWebviewContents(e.sender, webContentsId);
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
  ipcMain.handle("webviewPoc:click", async (e, webContentsId, x, y) => {
    assertSenderIsAppWindow(e.sender);
    const wc = getWebviewContents(e.sender, webContentsId);
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
  ipcMain.handle("webviewPoc:detach", async (e, webContentsId) => {
    assertSenderIsAppWindow(e.sender);
    const wc = webContents.fromId(webContentsId);
    if (
      wc &&
      !wc.isDestroyed() &&
      wc.getType() === "webview" &&
      wc.hostWebContents?.id === e.sender.id &&
      wc.debugger.isAttached()
    ) {
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
  // 注意：app:getLocalSecret 已被移除。renderer 不该拿到明文 secret
  // ——避免 XSS / webview / 二方脚本事后拿去调鉴权接口。
  // 必须带 secret 的 same-origin fetch，由 webRequest.onBeforeSendHeaders 自动注入。

  // 诊断信息导出：renderer 点“导出诊断信息”按钮时会调。
  // 主进程负责 collect + dialog，避免 renderer 接触 fs / dialog。
  // Diag-2：renderer 可传一份 snapshot（location.href / providers 数 / window.errorCount 等）
  // 会被 merge 到 JSON 的 .renderer 字段。
  ipcMain.handle("diag:export", async (_e, rendererSnapshot) => {
    await exportDiagnosticsInteractive(
      sanitizeRendererSnapshot(rendererSnapshot)
    );
    return { ok: true };
  });
  ipcMain.handle("diag:collect", async (_e, rendererSnapshot) => {
    return diagCollector.collectDiagnostics({
      app,
      apiBase,
      localSecret: localSessionSecret,
      renderer: sanitizeRendererSnapshot(rendererSnapshot),
    });
  });

  ipcMain.handle("deps:cloudflaredStatus", () => {
    const cloudflaredPath = resolveCloudflaredPath();
    const brewPath = resolveBrewPath();
    return {
      installed: Boolean(cloudflaredPath),
      path: cloudflaredPath,
      installable: Boolean(brewPath),
      installer: brewPath ? "homebrew" : null,
      installCommand: "brew install cloudflared",
      error: brewPath ? null : "未检测到 Homebrew，无法自动安装 cloudflared。",
    };
  });

  ipcMain.handle("deps:installCloudflared", async () => {
    const existingPath = resolveCloudflaredPath();
    if (existingPath) {
      process.env.DIGA_AGENT_CLOUDFLARED_PATH = existingPath;
      return {
        ok: true,
        installed: true,
        path: existingPath,
        output: "cloudflared 已安装。",
      };
    }
    const brewPath = resolveBrewPath();
    if (!brewPath) {
      return {
        ok: false,
        installed: false,
        path: null,
        output: "",
        error:
          "未检测到 Homebrew，无法自动安装 cloudflared。请先安装 Homebrew，或手动安装 cloudflared。",
      };
    }
    const result = await runCommand(brewPath, ["install", "cloudflared"]);
    const nextPath = resolveCloudflaredPath();
    if (result.ok && nextPath) {
      process.env.DIGA_AGENT_CLOUDFLARED_PATH = nextPath;
    }
    return {
      ok: Boolean(result.ok && nextPath),
      installed: Boolean(nextPath),
      path: nextPath,
      output: result.output,
      error:
        result.ok && !nextPath
          ? "安装命令已完成，但仍未找到 cloudflared。"
          : result.error,
    };
  });

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
  ipcMain.handle("settings:save", (_e, partial) => {
    const next = settingsModule.saveSettings(app, partial);
    if (
      partial &&
      Object.prototype.hasOwnProperty.call(partial, "keepAwake")
    ) {
      applyPowerSaveFromSettings();
    }
    return next;
  });
  ipcMain.handle("settings:getProviderEnvMap", () =>
    settingsModule.PROVIDER_ENV_MAP
  );
  ipcMain.handle("power:getKeepAwakeStatus", () =>
    powerSave.getKeepAwakeStatus()
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
  if (DEV) {
    win.webContents.on("before-input-event", (event, input) => {
      const key = String(input.key || "").toLowerCase();
      if ((input.meta || input.control) && key === "r") {
        event.preventDefault();
        void reloadMainWindow(win, DEV_URL).catch((e) => {
          console.warn("[electron] controlled dev reload failed:", e.message);
        });
      }
    });
    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.show();
      if (typeof win.webContents.invalidate === "function") {
        win.webContents.invalidate();
      }
    });
  }

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
 * 设置页在主窗口内打开，避免客户端内操作弹出第二个 BrowserWindow。
 */
let settingsWin = null;
async function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.close();
    settingsWin = null;
  }
  const win = await openMainWindow();
  const base = apiBase || DEV_URL;
  const settingsUrl = `${base}/settings`;
  if (!win.webContents.getURL().startsWith(settingsUrl)) {
    await win.loadURL(settingsUrl);
  }
  focusWindow(win);
  return win;
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
          label: "导出诊断信息…",
          click: () => void exportDiagnosticsInteractive(),
        },
        { type: "separator" },
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

/**
 * 导出诊断包：弹保存对话框 → collectDiagnostics → 写 JSON → 在 Finder 里选中。
 * 使用“随时可调”的全局函数（这里定义）× menu 菜单 + IPC + 设置页。
 */
// sanitizeRendererSnapshot 抽到 diag-collector，这里重导以便复用。
const sanitizeRendererSnapshot = diagCollector.sanitizeRendererSnapshot;

async function exportDiagnosticsInteractive(rendererSnapshot) {
  try {
    const data = await diagCollector.collectDiagnostics({
      app,
      apiBase,
      localSecret: localSessionSecret,
      renderer: rendererSnapshot || null,
    });
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const defaultName = `diga-agent-diagnostics-${ts}.json`;
    const owner = getPrimaryMainWindow();
    const result = await dialog.showSaveDialog(owner || undefined, {
      title: "导出诊断信息",
      defaultPath: path.join(app.getPath("downloads"), defaultName),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return;
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), "utf8");
    // 在 Finder 里选中该文件。
    shell.showItemInFolder(result.filePath);
  } catch (e) {
    console.error("[diag] exportDiagnosticsInteractive failed:", e);
    try {
      await dialog.showMessageBox({
        type: "error",
        message: "导出诊断失败",
        detail: (e && e.message) || String(e),
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Sx-1：启动失败时弹窗，避免“双击闪退”静默失败。
 *
 * 可能原因：
 *  - standalone server 起不来（port 被占 / asar 文件损坏 / native module 不兼容）
 *  - keytar 被系统拒权
 *  - 首次启动名下目录不可写
 *
 * 提供三个出口：导出诊断信息 / 打开日志目录 / 退出。
 */
async function showStartupFailureDialog(error) {
  try {
    const message = (error && error.message) || String(error);
    const logPath = diagLogger.getLogFilePath() || "(unknown)";
    const userData = (() => {
      try {
        return app.getPath("userData");
      } catch {
        return "(unknown)";
      }
    })();
    const result = await dialog.showMessageBox({
      type: "error",
      title: "Diga Agent 启动失败",
      message: "Diga Agent 无法启动。",
      detail:
        `错误：${message}\n\n` +
        `日志路径：${logPath}\n` +
        `配置目录：${userData}\n\n` +
        "可以导出诊断信息发给我们定位问题。",
      buttons: ["导出诊断信息…", "打开日志文件夹", "退出"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) {
      // 诊断信息导出。注意：apiBase 可能为 null，diag-collector 会跳过 HTTP probe。
      try {
        const data = await diagCollector.collectDiagnostics({
          app,
          apiBase,
          localSecret: localSessionSecret,
        });
        const ts = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .slice(0, 19);
        const target = path.join(
          app.getPath("downloads"),
          `diga-agent-startup-failure-${ts}.json`
        );
        fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
        shell.showItemInFolder(target);
      } catch (e) {
        console.error("[diag] save startup-failure JSON failed:", e);
      }
    } else if (result.response === 1) {
      try {
        if (logPath && logPath !== "(unknown)") {
          shell.showItemInFolder(logPath);
        } else if (userData !== "(unknown)") {
          shell.openPath(userData);
        }
      } catch (e) {
        console.error("[diag] open log folder failed:", e);
      }
    }
  } catch (e) {
    console.error("[diag] showStartupFailureDialog itself failed:", e);
  }
}

/**
 * Electron 全局 web-contents 安全守守（fix-S2.b）。
 *
 * webPreferences.webviewTag 在主窗口被打开，以受控方式使用 webview 容器。
 * 默认 attach 行为会从 <webview> 标签读任意 attribute（包括 nodeIntegration
 * / preload）。这里接管 will-attach-webview，强制设为最严隔离、创除一切
 * 能提权的 webPreferences，并且拒绝任意 preload。
 *
 * 另外拦 setWindowOpenHandler / will-navigate / setPermissionRequestHandler，
 * 避免页内脚本诱导主进程跳出受信 origin 或伸请传感器权限。
 */
function installWebviewSecurityGuards() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      // 默认 sandbox + contextIsolation + nodeIntegration off + 删 preload
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInWorker = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.experimentalFeatures = false;
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      // params 是 <webview> 标签上用户设的 attributes，同样要狭化。
      params.nodeintegration = false;
      params.allowpopups = false;
      params.disablewebsecurity = false;

      // A4-3：src 协议白名单。限 http/https + about:blank；拒绝 file://、chrome://、
      // javascript:、data: 等能读本地资源或执行脚本的协议。
      const verdict = securityPolicy.isAllowedWebviewSrc(params.src);
      if (!verdict.ok) {
        console.warn(
          `[security] webview attach denied (${verdict.reason}): src=${params.src}`
        );
        event.preventDefault();
      }
    });

    // A4-3：webview 运行期内部跳转也走同一套协议白名单，避免页内脚本
    // 在被 attach 之后用 location.href = "file://..." 跳出。
    contents.on("did-attach-webview", (_e, wc) => {
      wc.on("will-navigate", (navEvent, url) => {
        const v = securityPolicy.isAllowedWebviewSrc(url);
        if (!v.ok) {
          console.warn(
            `[security] webview navigation denied (${v.reason}): url=${url}`
          );
          navEvent.preventDefault();
        }
      });
    });

    // 遵循 shell.openExternal 路线处理外链；webview/iframe 不允许主窗口
    // 被诱导跳走。
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const protocol = new URL(url).protocol;
        if (protocol === "http:" || protocol === "https:") {
          shell.openExternal(url);
        }
      } catch {
        // ignore malformed URL
      }
      return { action: "deny" };
    });

    // 限制主窗口 will-navigate 只能留在已知 origin（apiBase / DEV_URL）以内。
    // webview 本身会走自己的导航事件，不受此限制。
    contents.on("will-navigate", (event, url) => {
      if (contents.getType() !== "window") return;
      try {
        const target = new URL(url);
        const allowed = [apiBase, DEV_URL].filter(Boolean).map((b) => new URL(b));
        const ok = allowed.some(
          (base) =>
            target.protocol === base.protocol &&
            target.hostname === base.hostname &&
            target.port === base.port
        );
        if (!ok) {
          event.preventDefault();
          shell.openExternal(url);
        }
      } catch {
        event.preventDefault();
      }
    });

    // 默认拒绝高风险权限请求（地理位置 / 摄像头 / 麦克风等）。
    contents.session?.setPermissionRequestHandler?.((_wc, permission, callback) => {
      const allowList = new Set(["clipboard-read", "clipboard-sanitized-write"]);
      callback(allowList.has(permission));
    });
  });
}

app.whenReady().then(async () => {
  // 优先初始化诊断日志：越早 hook console、越早可以“启动阶段诊断”
  // （后续任何 console.log 会一起入环形缓冲）。
  try {
    diagLogger.initDiagLogger({
      userDataDir: app.getPath("userData"),
    });
  } catch (e) {
    // 不阻塞启动
    process.stderr.write(`[diag] init failed: ${e && e.message}\n`);
  }
  installWebviewSecurityGuards();
  registerIpc();
  installLocalSecretHeaderHook();
  buildAppMenu();
  createTray();
  applyPowerSaveFromSettings();

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
    await showStartupFailureDialog(e);
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
  powerSave.setKeepAwakeEnabled(false);
  killServerChild("before-quit");
});

app.on("will-quit", () => {
  powerSave.setKeepAwakeEnabled(false);
  killServerChild("will-quit");
});

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
