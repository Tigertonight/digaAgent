# Diga 桌面宠物浮动挂件 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Diga Electron 桌面端新增一个可拖拽的浮动宠物挂件，实时反映 Agent 状态，支持 hover 气泡查看进度、点击展开卡片进行快速交互（abort / 快速回复 / 跳回主窗口）。

**Architecture:** 新增一个独立的 Electron `BrowserWindow`（透明 + always-on-top + frameless），加载 `/pet` 路由页面；主窗口通过 IPC 推送 `pet-state` 给宠物窗口；宠物窗口通过现有 `/api/agent/[id]` REST 接口执行 abort / prompt 操作。宠物状态机（idle / thinking / running / attention / done）驱动 Diga 品牌帧动画切换。

**Tech Stack:** Electron 42, Next.js 16 (App Router), React 19, Tailwind CSS, TypeScript, 现有 `/api/agent` REST API

---

## 背景知识

### 现有资产
- **品牌帧图**：`public/brand/diga-logo-frames/diga-logo-01.webp` ~ `diga-logo-16.webp`（16 帧）
- **主 logo**：`public/brand/diga-logo-main.webp`
- **Electron 设置窗口参考**：`electron/main.js` 里的 `openSettingsWindow()` 函数——宠物窗口照此模式建
- **IPC bridge**：`electron/preload.js` 暴露 `window.miniPi`，`lib/electron-bridge.ts` 是 TS 类型定义
- **Runner 状态**：`lib/session-runner.ts` 里的 `RunnerState`，`AgentPhase` 类型
- **主窗口状态推送点**：`app/ChatApp.tsx` 里的 `activeSnapshot` 和 `runnersRef`

### 宠物状态机
```
idle       → 无活跃 streaming session，宠物缓慢呼吸（帧 1-4 循环）
thinking   → agentPhase.kind === "thinking" | "waiting_model"（帧 5-8 快速循环）
running    → agentPhase.kind === "running_tools"（帧 9-12 快速循环）
attention  → streaming 结束，等待用户输入（帧 13-14 跳动）
done       → agent_end 刚触发（帧 15-16 短暂播放后回 idle）
```

### IPC 数据流
```
ChatApp.tsx (渲染进程)
  → window.miniPi.sendPetState(state)   [新增 IPC channel]
  → ipcMain 接收 → petWindow.webContents.send("pet:state", state)

宠物窗口 (/pet/page.tsx)
  → window.miniPi.onPetState(cb)        [新增 IPC listener]
  → 更新宠物动画状态

宠物窗口操作
  → fetch("/api/agent/[id]", { abort | prompt })   [直接走 REST，不走 IPC]
  → window.miniPi.focusMainWindow()                [新增 IPC，聚焦主窗口]
```

### PetState 结构
```typescript
interface PetSessionInfo {
  id: string            // session.id
  agentId: string | null
  name: string          // session 显示名
  streaming: boolean
  agentPhase: AgentPhase  // null | {kind: "waiting_model"} | {kind:"thinking"} | {kind:"running_tools", tools:[]}
  lastMessage: string   // 最近 assistant 消息前 80 字，无则空串
  currentTool: string | null  // 当前运行的 tool 名，无则 null
}

interface PetState {
  sessions: PetSessionInfo[]     // 所有有 agentId 的 runner（不含 draft 空 runner）
  focusedSessionId: string | null // 宠物当前展示哪个 session（默认最近活跃）
  petVisible: boolean            // 配置：是否显示宠物
  petAlwaysShow: boolean         // 配置：true=始终显示, false=主窗口隐藏才显示
}
```

---

## Task 1: IPC 扩展 —— preload + electron-bridge

**目标**：为宠物窗口添加 4 个新 IPC channel 的 TS 类型 + preload 暴露

**Files:**
- Modify: `electron/preload.js`
- Modify: `lib/electron-bridge.ts`

### Step 1: 在 electron-bridge.ts 新增宠物相关类型和接口

在 `ElectronApi` interface 追加以下字段（在 `settings` 字段之后）：

```typescript
// lib/electron-bridge.ts

// 在文件顶部新增 PetState 相关类型
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

// 在 ElectronApi interface 里新增（settings 字段后面）：
pet: {
  /** 主窗口推送宠物状态（单向，fire-and-forget） */
  sendState(state: PetState): void;
  /** 宠物窗口订阅状态更新 */
  onState(cb: (state: PetState) => void): () => void;
  /** 宠物窗口请求聚焦主窗口，并切到指定 session */
  focusMain(sessionId?: string): void;
  /** 切换宠物显示/隐藏（给主窗口调用） */
  setPetVisible(visible: boolean): void;
};
```

### Step 2: 在 preload.js 暴露宠物 IPC

在 `contextBridge.exposeInMainWorld("miniPi", { ... })` 的对象末尾追加：

```javascript
// electron/preload.js —— 在 settings 对象后面追加

pet: {
  /** 主窗口渲染进程 → ipcMain → 宠物窗口 */
  sendState: (state) => ipcRenderer.send("pet:state-from-main", state),
  /** 宠物窗口订阅推送；返回取消函数 */
  onState: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on("pet:state", handler);
    return () => ipcRenderer.removeListener("pet:state", handler);
  },
  /** 宠物窗口请求主窗口获得焦点 */
  focusMain: (sessionId) =>
    ipcRenderer.send("pet:focus-main", sessionId ?? null),
  /** 主窗口控制宠物显隐 */
  setPetVisible: (visible) =>
    ipcRenderer.send("pet:set-visible", visible),
},
```

### Step 3: 验证类型完整性（无需运行，目视检查）

确认 `ElectronApi.pet` 的方法签名与 preload.js 里暴露的字段一一对应。

### Step 4: Commit

```bash
git add electron/preload.js lib/electron-bridge.ts
git commit -m "feat(pet): IPC bridge —— preload + electron-bridge 类型扩展"
```

---

## Task 2: Electron 主进程 —— 宠物窗口创建 + IPC 路由

**目标**：在 `electron/main.js` 里创建宠物 `BrowserWindow`，并把 IPC 事件路由到正确的窗口。

**Files:**
- Modify: `electron/main.js`

### Step 1: 在 main.js 新增 createPetWindow 函数

在 `openSettingsWindow` 函数之后、`buildAppMenu` 函数之前插入：

```javascript
// electron/main.js

let petWin = null;

async function createPetWindow(baseUrl) {
  if (petWin && !petWin.isDestroyed()) return petWin;

  petWin = new BrowserWindow({
    width: 120,
    height: 160,
    // 初始位置：屏幕右下角留边距
    x: require("electron").screen.getPrimaryDisplay().workAreaSize.width - 140,
    y: require("electron").screen.getPrimaryDisplay().workAreaSize.height - 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,           // 不在 Dock/任务栏显示
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

  // 宠物窗口不拦截鼠标事件时可穿透（hover 时才响应）
  // 初始设为非穿透，宠物展开卡片时动态调整
  petWin.setIgnoreMouseEvents(false);

  petWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  petWin.on("closed", () => {
    petWin = null;
  });

  await petWin.loadURL(`${baseUrl}/pet`);
  return petWin;
}
```

### Step 2: 在 registerIpc 函数里追加宠物 IPC handler

在现有 `ipcMain.handle("settings:reloadServer", ...)` 之后追加：

```javascript
// 主窗口推送状态 → 转发给宠物窗口
ipcMain.on("pet:state-from-main", (_event, state) => {
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send("pet:state", state);
  }
});

// 宠物窗口请求聚焦主窗口
ipcMain.on("pet:focus-main", (_event, sessionId) => {
  const mainWin = BrowserWindow.getAllWindows().find(
    (w) => w !== petWin && w !== settingsWin && !w.isDestroyed()
  );
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    // 把 sessionId 转发给主窗口渲染进程，让它切到对应 session
    if (sessionId) {
      mainWin.webContents.send("pet:switch-session", sessionId);
    }
  }
});

// 控制宠物窗口显示/隐藏
ipcMain.on("pet:set-visible", (_event, visible) => {
  if (!petWin || petWin.isDestroyed()) return;
  if (visible) petWin.show();
  else petWin.hide();
});

// 宠物窗口拖拽：更新窗口位置（宠物页面算出坐标后通知主进程移动窗口）
ipcMain.on("pet:move", (_event, { x, y }) => {
  if (petWin && !petWin.isDestroyed()) petWin.setPosition(Math.round(x), Math.round(y));
});
```

### Step 3: 在 app.whenReady 里启动宠物窗口

在 `await createWindow()` 之后追加：

```javascript
// app.whenReady 里，createWindow 成功后
const base = apiBase || DEV_URL;
try {
  await createPetWindow(base);
} catch (e) {
  console.warn("[electron] pet window failed to start:", e.message);
}
```

**注意**：dev 模式下 `apiBase` 为 null，用 `DEV_URL`（localhost:3000）。standalone 模式下 `apiBase` 在 `startStandaloneServer` 里被赋值，需要确保 `createPetWindow` 在 server 起来之后调用。

检查现有代码：`startStandaloneServer()` 在 `createWindow()` 里被 `await`——所以 `apiBase` 在 `createWindow()` 返回后已就绪。

### Step 4: 主窗口监听 pet:switch-session（preload 追加 listener）

在 `preload.js` 的 `pet` 对象里补充：

```javascript
// 主窗口监听宠物发来的"切 session"请求
onSwitchSession: (cb) => {
  const handler = (_event, sessionId) => cb(sessionId);
  ipcRenderer.on("pet:switch-session", handler);
  return () => ipcRenderer.removeListener("pet:switch-session", handler);
},
```

同步在 `electron-bridge.ts` 的 `pet` 接口追加：
```typescript
onSwitchSession(cb: (sessionId: string) => void): () => void;
```

### Step 5: Commit

```bash
git add electron/main.js electron/preload.js lib/electron-bridge.ts
git commit -m "feat(pet): Electron 主进程宠物窗口创建 + IPC 路由"
```

---

## Task 3: Next.js 路由 —— /pet 页面骨架

**目标**：创建 `/pet` 路由，宠物窗口加载此页面；页面作为独立 React root，不依赖主窗口的任何 context。

**Files:**
- Create: `app/pet/layout.tsx`
- Create: `app/pet/page.tsx`

### Step 1: 创建 app/pet/layout.tsx

```tsx
// app/pet/layout.tsx
// 宠物窗口专属 layout：最小化 HTML，transparent 背景，不加载主应用 globals 以外的样式
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Diga Pet",
};

export default function PetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // 透明背景，overflow 隐藏，整个窗口作为宠物容器
    <div
      style={{
        width: "120px",
        height: "160px",
        overflow: "visible",
        background: "transparent",
        userSelect: "none",
        WebkitAppRegion: "no-drag", // 默认不可拖，拖拽由宠物主体自己处理
      }}
    >
      {children}
    </div>
  );
}
```

### Step 2: 创建 app/pet/page.tsx 骨架

```tsx
// app/pet/page.tsx
"use client";

export default function PetPage() {
  return (
    <div
      style={{
        width: 120,
        height: 160,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        color: "white",
        fontSize: 12,
      }}
    >
      🐾 Diga Pet
    </div>
  );
}
```

### Step 3: 验证路由可访问

运行 `npm run dev`，浏览器打开 `http://localhost:3000/pet`，确认页面渲染出"🐾 Diga Pet"文字。

### Step 4: Commit

```bash
git add app/pet/layout.tsx app/pet/page.tsx
git commit -m "feat(pet): /pet 路由骨架"
```

---

## Task 4: 宠物状态机 Hook —— usePetState

**目标**：在宠物页面里封装一个 Hook，订阅 IPC 推送的 `PetState`，对外暴露当前状态和操作方法。

**Files:**
- Create: `app/pet/use-pet-state.ts`

### Step 1: 创建 use-pet-state.ts

```typescript
// app/pet/use-pet-state.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";

/** 宠物动画状态，由 PetSessionInfo 派生 */
export type PetAnimState =
  | "idle"
  | "thinking"
  | "running"
  | "attention"
  | "done";

/** 从 PetSessionInfo 派生宠物动画状态 */
export function derivePetAnimState(session: PetSessionInfo | null): PetAnimState {
  if (!session || !session.agentId) return "idle";
  if (!session.streaming && session.agentId) {
    // agent 存在但不在流式 → 等待输入（attention）或空闲
    // 用 lastMessage 非空来判断是否曾经对话过
    return session.lastMessage ? "attention" : "idle";
  }
  const phase = session.agentPhase;
  if (!phase) return "idle";
  if (phase.kind === "thinking" || phase.kind === "waiting_model") return "thinking";
  if (phase.kind === "running_tools") return "running";
  return "idle";
}

/** done 状态短暂持续时长（ms） */
const DONE_LINGER_MS = 2000;

export function usePetState() {
  const [petState, setPetState] = useState<PetState | null>(null);
  // done 状态需要短暂保持后切回 idle/attention，用 ref 追踪计时器
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [animState, setAnimState] = useState<PetAnimState>("idle");
  const prevStreamingRef = useRef<boolean>(false);

  // 订阅 IPC 推送
  useEffect(() => {
    const api = (window as unknown as { miniPi?: { pet?: { onState?: (cb: (s: PetState) => void) => () => void } } }).miniPi;
    if (!api?.pet?.onState) return;
    const unsub = api.pet.onState((state) => {
      setPetState(state);
    });
    return unsub;
  }, []);

  // 从 petState 派生 animState，处理 done 短暂闪现
  useEffect(() => {
    if (!petState) return;
    const focused = petState.sessions.find(
      (s) => s.id === petState.focusedSessionId
    ) ?? petState.sessions[0] ?? null;

    const wasStreaming = prevStreamingRef.current;
    const isStreaming = focused?.streaming ?? false;
    prevStreamingRef.current = isStreaming;

    // streaming 刚结束 → done 闪现
    if (wasStreaming && !isStreaming && focused) {
      setAnimState("done");
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
      doneTimerRef.current = setTimeout(() => {
        setAnimState(derivePetAnimState(focused));
      }, DONE_LINGER_MS);
      return;
    }

    if (doneTimerRef.current) return; // done 计时期间不打断
    setAnimState(derivePetAnimState(focused));
  }, [petState]);

  // 清理计时器
  useEffect(() => () => {
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
  }, []);

  /** 当前宠物展示的 session */
  const focusedSession = petState
    ? (petState.sessions.find((s) => s.id === petState.focusedSessionId) ??
        petState.sessions[0] ??
        null)
    : null;

  /** 切换宠物展示的 session（仅本地，不推送回主窗口） */
  const [localFocusId, setLocalFocusId] = useState<string | null>(null);
  const displaySession: PetSessionInfo | null =
    petState?.sessions.find((s) => s.id === (localFocusId ?? petState.focusedSessionId)) ??
    focusedSession;

  /** 聚焦主窗口并切到对应 session */
  const focusMain = useCallback((sessionId?: string) => {
    const api = (window as unknown as { miniPi?: { pet?: { focusMain?: (id?: string) => void } } }).miniPi;
    api?.pet?.focusMain?.(sessionId ?? displaySession?.id);
  }, [displaySession]);

  return {
    petState,
    animState,
    displaySession,
    allSessions: petState?.sessions ?? [],
    setLocalFocusId,
    focusMain,
  };
}
```

### Step 2: Commit

```bash
git add app/pet/use-pet-state.ts
git commit -m "feat(pet): usePetState hook —— IPC 订阅 + 状态机派生"
```

---

## Task 5: 宠物动画组件 —— PetSprite

**目标**：用 16 帧 webp 图实现宠物动画，按 animState 选帧范围和速度。

**Files:**
- Create: `app/pet/PetSprite.tsx`

### Step 1: 创建 PetSprite.tsx

帧分配策略（16 帧均分 5 状态）：
- `idle`：帧 1-4，500ms/帧（慢呼吸）
- `thinking`：帧 5-8，150ms/帧（快速）
- `running`：帧 9-12，100ms/帧（更快）
- `attention`：帧 13-14，300ms/帧（跳动）
- `done`：帧 15-16，200ms/帧（庆祝）

```tsx
// app/pet/PetSprite.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { PetAnimState } from "./use-pet-state";

interface FrameConfig {
  frames: number[];   // 帧索引（1-based）
  interval: number;   // ms
}

const ANIM_CONFIG: Record<PetAnimState, FrameConfig> = {
  idle:      { frames: [1, 2, 3, 4],   interval: 500 },
  thinking:  { frames: [5, 6, 7, 8],   interval: 150 },
  running:   { frames: [9, 10, 11, 12], interval: 100 },
  attention: { frames: [13, 14],        interval: 300 },
  done:      { frames: [15, 16],        interval: 200 },
};

function frameSrc(n: number): string {
  return `/brand/diga-logo-frames/diga-logo-${String(n).padStart(2, "0")}.webp`;
}

interface Props {
  animState: PetAnimState;
  size?: number;
}

export default function PetSprite({ animState, size = 80 }: Props) {
  const config = ANIM_CONFIG[animState];
  const [frameIdx, setFrameIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // animState 切换时重置到第 0 帧，重启计时器
  useEffect(() => {
    setFrameIdx(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setFrameIdx((i) => (i + 1) % config.frames.length);
    }, config.interval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [animState, config.frames.length, config.interval]);

  const currentFrame = config.frames[frameIdx];

  return (
    <img
      src={frameSrc(currentFrame)}
      alt={`Diga ${animState}`}
      width={size}
      height={size}
      style={{
        imageRendering: "pixelated",
        userSelect: "none",
        pointerEvents: "none",
        filter: animState === "done" ? "drop-shadow(0 0 6px #7ee787)" : "none",
        transition: "filter 0.3s ease",
      }}
      draggable={false}
    />
  );
}
```

### Step 2: Commit

```bash
git add app/pet/PetSprite.tsx
git commit -m "feat(pet): PetSprite 动画组件，16 帧按状态机切换"
```

---

## Task 6: hover 气泡组件 —— PetBubble

**目标**：鼠标 hover 宠物时，向上弹出气泡，展示当前 session 状态摘要 + 多 session 切换 pill。

**Files:**
- Create: `app/pet/PetBubble.tsx`

### Step 1: 创建 PetBubble.tsx

```tsx
// app/pet/PetBubble.tsx
"use client";

import type { PetSessionInfo } from "@/lib/electron-bridge";
import type { PetAnimState } from "./use-pet-state";

const STATE_LABELS: Record<PetAnimState, string> = {
  idle:      "空闲",
  thinking:  "思考中…",
  running:   "执行工具…",
  attention: "等待回复",
  done:      "完成 ✓",
};

interface Props {
  animState: PetAnimState;
  session: PetSessionInfo | null;
  allSessions: PetSessionInfo[];
  focusedId: string | null;
  onSwitchSession: (id: string) => void;
}

export default function PetBubble({
  animState,
  session,
  allSessions,
  focusedId,
  onSwitchSession,
}: Props) {
  const activeSessions = allSessions.filter((s) => s.agentId);

  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: 220,
        background: "rgba(20,20,20,0.95)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "10px 12px",
        backdropFilter: "blur(12px)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        fontSize: 11,
        color: "#e0e0e0",
        zIndex: 9999,
        pointerEvents: "auto",
      }}
    >
      {/* 当前状态标签 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span
          style={{
            width: 6, height: 6, borderRadius: "50%",
            background:
              animState === "idle" ? "#555" :
              animState === "thinking" ? "#60a5fa" :
              animState === "running" ? "#f59e0b" :
              animState === "attention" ? "#f87171" :
              "#7ee787",
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, color: "#fff" }}>
          {STATE_LABELS[animState]}
        </span>
      </div>

      {/* 当前工具 or 消息摘要 */}
      {session?.currentTool && (
        <div style={{ color: "#f59e0b", marginBottom: 4, fontSize: 10 }}>
          🔧 {session.currentTool}
        </div>
      )}
      {session?.lastMessage && (
        <div
          style={{
            color: "#a0a0a0",
            fontSize: 10,
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {session.lastMessage}
        </div>
      )}
      {!session?.currentTool && !session?.lastMessage && (
        <div style={{ color: "#555", fontSize: 10 }}>暂无活跃会话</div>
      )}

      {/* 多 session 切换 pill */}
      {activeSessions.length > 1 && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
          }}
        >
          {activeSessions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSwitchSession(s.id)}
              style={{
                fontSize: 9,
                padding: "2px 6px",
                borderRadius: 4,
                border: "1px solid",
                borderColor: s.id === focusedId ? "#7ee787" : "rgba(255,255,255,0.15)",
                background: s.id === focusedId ? "rgba(126,231,135,0.15)" : "transparent",
                color: s.id === focusedId ? "#7ee787" : "#888",
                cursor: "pointer",
                maxWidth: 80,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={s.name}
            >
              {s.name || s.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      {/* 气泡尾巴 */}
      <div
        style={{
          position: "absolute",
          bottom: -6,
          left: "50%",
          transform: "translateX(-50%)",
          width: 10,
          height: 6,
          background: "rgba(20,20,20,0.95)",
          clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        }}
      />
    </div>
  );
}
```

### Step 2: Commit

```bash
git add app/pet/PetBubble.tsx
git commit -m "feat(pet): PetBubble hover 气泡组件"
```

---

## Task 7: 操作卡片组件 —— PetCard

**目标**：点击宠物后展开操作卡片，支持 abort / 快速回复 / 跳回主窗口。

**Files:**
- Create: `app/pet/PetCard.tsx`

### Step 1: 创建 PetCard.tsx

```tsx
// app/pet/PetCard.tsx
"use client";

import { useCallback, useState } from "react";
import type { PetSessionInfo } from "@/lib/electron-bridge";

interface Props {
  session: PetSessionInfo | null;
  onClose: () => void;
  onFocusMain: () => void;
}

export default function PetCard({ session, onClose, onFocusMain }: Props) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAbort = useCallback(async () => {
    if (!session?.agentId) return;
    setAborting(true);
    setError(null);
    try {
      const r = await fetch(`/api/agent/${session.agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setAborting(false);
    }
  }, [session, onClose]);

  const handleSend = useCallback(async () => {
    if (!session?.agentId || !input.trim()) return;
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/agent/${session.agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", text: input.trim() }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else {
        setInput("");
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }, [session, input, onClose]);

  return (
    // 点击卡片外部关闭
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: "absolute",
          bottom: "calc(100% + 8px)",
          left: "50%",
          transform: "translateX(-50%)",
          width: 280,
          background: "rgba(18,18,18,0.98)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 14,
          padding: 14,
          backdropFilter: "blur(16px)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          fontSize: 12,
          color: "#e0e0e0",
          zIndex: 9999,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：session 名 + 关闭 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: "#fff", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session?.name || "Diga Agent"}
          </span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* 消息摘要 */}
        {session?.lastMessage && (
          <div
            style={{
              background: "rgba(255,255,255,0.05)",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 10,
              fontSize: 11,
              color: "#a0a0a0",
              lineHeight: 1.5,
              maxHeight: 72,
              overflow: "hidden",
            }}
          >
            {session.lastMessage}
          </div>
        )}

        {/* 当前工具 */}
        {session?.currentTool && (
          <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 8 }}>
            🔧 正在执行：{session.currentTool}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div style={{ fontSize: 10, color: "#f87171", marginBottom: 8 }}>
            {error}
          </div>
        )}

        {/* 快速回复输入框 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="快速回复…"
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#fff",
              fontSize: 11,
              outline: "none",
            }}
            disabled={sending}
            autoFocus
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
            style={{
              background: input.trim() ? "#7ee787" : "rgba(255,255,255,0.08)",
              border: "none",
              borderRadius: 8,
              padding: "6px 10px",
              color: input.trim() ? "#000" : "#555",
              fontSize: 11,
              cursor: input.trim() ? "pointer" : "default",
              fontWeight: 600,
              transition: "all 0.15s",
            }}
          >
            {sending ? "…" : "发送"}
          </button>
        </div>

        {/* 操作按钮行 */}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onFocusMain}
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "6px 0",
              color: "#ccc",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            跳回主窗口
          </button>
          {session?.streaming && (
            <button
              onClick={() => void handleAbort()}
              disabled={aborting}
              style={{
                background: "rgba(248,113,113,0.12)",
                border: "1px solid rgba(248,113,113,0.3)",
                borderRadius: 8,
                padding: "6px 12px",
                color: "#f87171",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {aborting ? "…" : "中止"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

### Step 2: Commit

```bash
git add app/pet/PetCard.tsx
git commit -m "feat(pet): PetCard 操作卡片 —— abort / 快速回复 / 跳回主窗口"
```

---

## Task 8: 宠物拖拽 Hook —— usePetDrag

**目标**：实现宠物可拖拽，通过 IPC 通知主进程移动宠物窗口位置。

**Files:**
- Create: `app/pet/use-pet-drag.ts`

### Step 1: 创建 use-pet-drag.ts

```typescript
// app/pet/use-pet-drag.ts
"use client";

import { useCallback, useRef } from "react";

/**
 * 宠物拖拽 hook。
 *
 * 思路：mousedown 记录起始鼠标位置（屏幕坐标），mousemove 时计算 delta，
 * 通过 IPC pet:move 通知主进程移动 BrowserWindow。
 * 因为宠物窗口是 frameless，window.screenX/screenY 给出窗口在屏幕上的位置。
 */
export function usePetDrag() {
  const dragRef = useRef<{ startMouseX: number; startMouseY: number; startWinX: number; startWinY: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 只响应左键
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      startMouseX: e.screenX,
      startMouseY: e.screenY,
      startWinX: window.screenX,
      startWinY: window.screenY,
    };

    const onMove = (ev: MouseEvent) => {
      const ref = dragRef.current;
      if (!ref) return;
      const dx = ev.screenX - ref.startMouseX;
      const dy = ev.screenY - ref.startMouseY;
      const newX = ref.startWinX + dx;
      const newY = ref.startWinY + dy;
      const api = (window as unknown as { miniPi?: { pet?: { move?: (pos: {x: number; y: number}) => void } } }).miniPi;
      // 通过自定义 IPC 移动窗口（需要在 preload + ipcMain 里注册）
      api?.pet?.move?.({ x: newX, y: newY });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return { onMouseDown };
}
```

### Step 2: 在 preload.js 的 pet 对象里追加 move 方法

```javascript
move: (pos) => ipcRenderer.send("pet:move", pos),
```

在 `electron-bridge.ts` 的 `pet` 接口追加：
```typescript
move(pos: { x: number; y: number }): void;
```

### Step 3: Commit

```bash
git add app/pet/use-pet-drag.ts electron/preload.js lib/electron-bridge.ts
git commit -m "feat(pet): usePetDrag 拖拽 hook + IPC pet:move"
```

---

## Task 9: 宠物主组件 —— PetApp + 页面组装

**目标**：组合所有子组件，完成宠物页面的完整交互逻辑。

**Files:**
- Create: `app/pet/PetApp.tsx`
- Modify: `app/pet/page.tsx`

### Step 1: 创建 PetApp.tsx

```tsx
// app/pet/PetApp.tsx
"use client";

import { useState } from "react";
import { usePetState } from "./use-pet-state";
import { usePetDrag } from "./use-pet-drag";
import PetSprite from "./PetSprite";
import PetBubble from "./PetBubble";
import PetCard from "./PetCard";

export default function PetApp() {
  const {
    animState,
    displaySession,
    allSessions,
    setLocalFocusId,
    focusMain,
  } = usePetState();

  const { onMouseDown } = usePetDrag();

  const [hovered, setHovered] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);

  const focusedId = displaySession?.id ?? null;

  return (
    // 宠物整体容器：透明背景，相对定位（子组件气泡/卡片用 absolute 弹出）
    <div
      style={{
        position: "relative",
        width: 120,
        height: 160,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 16,
        background: "transparent",
        overflow: "visible",
      }}
    >
      {/* hover 气泡 */}
      {hovered && !cardOpen && (
        <PetBubble
          animState={animState}
          session={displaySession}
          allSessions={allSessions}
          focusedId={focusedId}
          onSwitchSession={(id) => setLocalFocusId(id)}
        />
      )}

      {/* 操作卡片 */}
      {cardOpen && (
        <PetCard
          session={displaySession}
          onClose={() => setCardOpen(false)}
          onFocusMain={() => {
            focusMain(displaySession?.id);
            setCardOpen(false);
          }}
        />
      )}

      {/* 宠物主体：可拖拽 + hover + 点击 */}
      <div
        onMouseDown={onMouseDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (!cardOpen) setCardOpen(true);
        }}
        style={{
          cursor: "grab",
          userSelect: "none",
          position: "relative",
        }}
        title="Diga Agent"
      >
        <PetSprite animState={animState} size={80} />

        {/* 状态指示点 */}
        {animState !== "idle" && (
          <div
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background:
                animState === "thinking" ? "#60a5fa" :
                animState === "running" ? "#f59e0b" :
                animState === "attention" ? "#f87171" :
                "#7ee787",
              boxShadow: `0 0 6px ${
                animState === "thinking" ? "#60a5fa" :
                animState === "running" ? "#f59e0b" :
                animState === "attention" ? "#f87171" :
                "#7ee787"
              }`,
              animation: animState === "attention" ? "pulse 1s infinite" : "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
```

### Step 2: 更新 app/pet/page.tsx

```tsx
// app/pet/page.tsx
"use client";

import PetApp from "./PetApp";

export default function PetPage() {
  return <PetApp />;
}
```

### Step 3: Commit

```bash
git add app/pet/PetApp.tsx app/pet/page.tsx
git commit -m "feat(pet): PetApp 主组件组装，宠物窗口 UI 完整"
```

---

## Task 10: 主窗口状态推送 —— ChatApp 集成

**目标**：在 `ChatApp.tsx` 里监听 `activeSnapshot` + `runnersRef` 变化，组装 `PetState` 推送给宠物窗口；同时处理宠物发来的"切 session"请求。

**Files:**
- Modify: `app/ChatApp.tsx`

### Step 1: 在 ChatApp.tsx 顶部导入新类型

```typescript
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";
```

### Step 2: 在 ChatApp 组件内（runnersRef 解构之后）添加 pet 状态推送 effect

找到 `// compactError 3 秒自动消失` 注释所在区域的前面插入：

```typescript
// ===== 宠物状态推送 =====
// 每次 activeSnapshot / sessions 列表变化时，把所有有 agentId 的 runner 状态推给宠物窗口
useEffect(() => {
  const api = getElectronApi();
  if (!api?.pet?.sendState) return;

  const petSessions: PetSessionInfo[] = [];
  for (const [key, runner] of runnersRef.current) {
    if (!runner.agentId) continue; // 跳过空 draft
    // 找到对应的 session 显示名
    const sess = sessions.find((s) => s.path === key);
    const lastMsg = runner.chatState.messages
      .filter((m) => m.role === "assistant")
      .slice(-1)[0];
    const lastText =
      lastMsg?.parts?.find((p) => p.kind === "text")?.text?.slice(0, 80) ?? "";
    const currentTool =
      runner.agentPhase?.kind === "running_tools"
        ? runner.agentPhase.tools?.[0]?.name ?? null
        : null;

    petSessions.push({
      id: sess?.id ?? key,
      agentId: runner.agentId,
      name: sess?.name ?? sess?.firstMessage?.slice(0, 20) ?? "新会话",
      streaming: runner.streaming,
      agentPhase: runner.agentPhase,
      lastMessage: lastText,
      currentTool,
    });
  }

  const petState: PetState = {
    sessions: petSessions,
    focusedSessionId: selectedId,
    petVisible: true,
    petAlwaysShow: true,
  };

  api.pet.sendState(petState);
}, [activeSnapshot, sessions, selectedId]); // activeSnapshot 变化涵盖了 runner 的流式更新
```

### Step 3: 在 ChatApp 里处理宠物的"切 session"请求

在 `useEffect(() => { reloadProviders(true) }, ...)` 附近的全局 effect 区域追加：

```typescript
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
```

### Step 4: Commit

```bash
git add app/ChatApp.tsx
git commit -m "feat(pet): ChatApp 推送 PetState 给宠物窗口 + 处理切 session 请求"
```

---

## Task 11: 全局 CSS —— 宠物页面动画 + 透明背景

**目标**：确保宠物页面透明背景正确渲染，补充 pulse keyframe。

**Files:**
- Modify: `app/globals.css`

### Step 1: 在 globals.css 末尾追加

```css
/* ====== 宠物挂件 ====== */
/* 宠物窗口 body 透明 */
body.pet-window {
  background: transparent !important;
  overflow: hidden;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.85); }
}
```

### Step 2: 在 app/pet/layout.tsx 的 body 上加 className（通过 metadata 无法直接加，改用 useEffect 动态加）

在 `app/pet/page.tsx` 顶部追加：

```typescript
// 宠物窗口：给 body 加透明背景 class
useEffect(() => {
  document.body.classList.add("pet-window");
  return () => document.body.classList.remove("pet-window");
}, []);
```

### Step 3: Commit

```bash
git add app/globals.css app/pet/page.tsx
git commit -m "feat(pet): 透明背景 CSS + pulse 动画 keyframe"
```

---

## Task 12: 端到端验证

**目标**：在 Electron dev 模式下验证完整宠物流程。

### Step 1: 启动 dev 服务

```bash
# 终端 1：启动 Next.js dev server
npm run dev

# 终端 2：启动 Electron（等 dev server 就绪后）
npm run electron:dev
```

### Step 2: 验证检查清单

- [ ] 宠物窗口出现在屏幕右下角，透明背景，无边框
- [ ] 宠物显示默认 idle 帧动画
- [ ] 拖拽宠物，窗口跟随移动
- [ ] hover 宠物，气泡向上弹出（无 session 时显示"暂无活跃会话"）
- [ ] 点击宠物，操作卡片展开
- [ ] 点击卡片外部，卡片收起
- [ ] 点击"跳回主窗口"，主窗口获得焦点
- [ ] 在主窗口新建 session 并发送消息，宠物切换到 thinking → running → done → attention 状态
- [ ] done 状态 2 秒后自动切回 attention/idle
- [ ] hover 气泡显示当前工具调用名和消息摘要
- [ ] 多 session 时，气泡显示切换 pill，点击切换宠物跟踪的 session

### Step 3: Commit（如有修复）

```bash
git add -A
git commit -m "fix(pet): 端到端验证修复"
```

---

## 完成后的文件变更汇总

```
新增：
  app/pet/layout.tsx
  app/pet/page.tsx
  app/pet/PetApp.tsx
  app/pet/PetSprite.tsx
  app/pet/PetBubble.tsx
  app/pet/PetCard.tsx
  app/pet/use-pet-state.ts
  app/pet/use-pet-drag.ts
  docs/plans/2026-06-01-pet-widget.md

修改：
  electron/main.js          — createPetWindow + IPC handler
  electron/preload.js       — pet IPC 暴露
  lib/electron-bridge.ts    — PetState 类型 + ElectronApi.pet 接口
  app/ChatApp.tsx           — PetState 推送 + onSwitchSession
  app/globals.css           — pet-window class + pulse keyframe
```
