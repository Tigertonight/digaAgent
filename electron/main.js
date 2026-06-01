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
const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require("electron");
const { fork } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const settingsModule = require("./settings");

const DEV = process.env.ELECTRON_DEV === "1";
const DEV_URL = process.env.ELECTRON_DEV_URL || "http://localhost:3000";

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
 * 注册 IPC handlers。
 * 命名约定：domain:action（例如 "shell:openExternal"）
 */
function registerIpc() {
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
}

async function createWindow() {
  const win = new BrowserWindow({
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
    },
    backgroundColor: "#0a0a0a",
  });

  // 外链用系统浏览器打开，不要在 Electron 内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const url = DEV ? DEV_URL : await startStandaloneServer();
  console.log(`[electron] loading ${url}`);

  // dev 下 next dev 启动可能需要时间，做个简单 retry
  if (DEV) {
    const ok = await waitForHttp(`${url}/api/health`, 30000);
    if (!ok) {
      console.error(`[electron] dev server not reachable at ${url}; 请先 npm run dev`);
    }
  }

  await win.loadURL(url);
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
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  const base = apiBase || DEV_URL;
  await settingsWin.loadURL(`${base}/settings`);
  return settingsWin;
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
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
