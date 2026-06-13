# diga-agent Electron 性能优化规划

> 本文目标:把 diga-agent 打包成 Electron 本地应用后,在长会话/流式场景下保持 60fps 体验。审计基于现状代码(2026-05-31),所有结论给出文件:行号定位。

## 一、基线现状

打开一个 100+ 消息的会话,流式接收 50 token/s 时,**单帧成本可达 100ms+,明显掉帧**。原因不是单个组件慢,而是事件粒度 × 重渲染链路 × Markdown 全量重 parse 三者乘起来。

关键数字:

- `ChatApp.tsx`:3520 行,48 个 `useState`,**0 个 `React.memo`**,111 处 inline `style={{...}}`
- 每个 `text_delta` 触发:`setChatState` → 全树 reconcile → N 条 `MessageView` 重建 props → 当前 assistant 的 `<Markdown>` 重建 → ReactMarkdown 全文 re-parse → Prism 全代码块 re-tokenize
- SSE ring buffer 5000 上限,满后每事件 `splice(0, ...)` 是 O(n)
- Electron prod 走 `fork(.next/standalone/server.js)` + HTTP loopback + SSE,冷启动需 1-3s
- dmg 体积 177 MB,主要是 `pi-coding-agent` SDK asarUnpack

## 二、性能框架(优化方向 = 五条主轴)

按"投入产出比"排序,优先做前三轴:

| 主轴 | 解决的问题 | 预期收益 |
|---|---|---|
| 1. **隔离重渲染域** | ChatApp 单文件 = 全局重渲染源 | 流式期间帧时间 -60% |
| 2. **Markdown 流式增量化** | 每 token 全文 re-parse + re-Prism | 长消息流式 -80% CPU |
| 3. **事件批合并** | SSE token 级粒度太细 | 减少 React commit 次数 |
| 4. **Electron 架构裁剪** | HTTP loopback + waitForHttp 探测 | 冷启动 -500ms,流式延迟 -30% |
| 5. **打包瘦身** | Prism 全语言 + SDK 全量 | dmg 缩到 ~80MB |

下面分别落地。

## 三、主轴 1:隔离重渲染域

### 病灶

`ChatApp.tsx` 把 48 个 state 全挂在同一个根组件:

```ts
// ChatApp.tsx:135-527 一锅 state
const [chatState, setChatState] = useState(...)   // 流式高频写
const [agentPhase, setAgentPhase] = useState(...) // 流式高频写
const [stats, setStats] = useState(...)           // 1s 轮询
const [sessions, setSessions] = useState(...)     // 5s 轮询
// ... 还有 44 个
```

任何一个 state 变 → ChatApp 函数体重跑 → 所有 children 一起 reconcile。流式 token 来时 chatState 和 agentPhase 同时变,直接全树扫一遍。

### 改造方案

**Step 1:把消息列表抽成独立 memo 组件**

```ts
// app/components/MessageList.tsx (新建)
export const MessageList = React.memo(function MessageList({
  messages, streaming, agentPhase, ...
}: Props) {
  return (
    <>{messages.map((m, i) => (
      <MessageView key={messageKey(m, i)} message={m} ... />
    ))}</>
  );
}, (prev, next) => prev.messages === next.messages && ...);
```

**Step 2:`MessageView` 加 `React.memo`,加严格的 prop 等值判断**

`ChatApp.tsx:2898` 当前 `function MessageView(...)` 没 memo。流式时**只有最后一条 assistant 在变**,其他 N-1 条应当跳过 reconcile。配合 `key` 用稳定 id(timestamp 或 entryId),不用数组 index。

**Step 3:全局可共享、低频更新的 state 用 Context;高频 state 用 store**

- 低频(theme, providers, cwd, rightPanel)→ 一个 ConfigContext,memo 只读 hook
- 高频(chatState, agentPhase, stats)→ 用 [zustand](https://github.com/pmndrs/zustand) 之类的外部 store,组件 selectively subscribe;或最简方案 `useSyncExternalStore` 自己写 ~30 行
- 流式期间 sidebar 不该重渲染,用 store 隔离后自然实现

**Step 4:消息 key 稳定化 + 虚拟化(50+ 消息时)**

`messages.map((m, i) => ..., key={i})`(`ChatApp.tsx:2287`)→ 用 `m.timestamp ?? m.entryId ?? i`。消息超过 50 条时上 [`@tanstack/react-virtual`](https://tanstack.com/virtual),sidebar 同理(虽然现在只有一条会话,但日后会涨)。

### 验收

打开 chrome devtools Performance 录制 5s 流式 → "Scripting" 时间应从 ~3s 降到 <1s;单帧 commit 时间从 80ms+ 降到 <16ms。

## 四、主轴 2:Markdown 流式增量化

### 病灶

`Markdown.tsx`(180 行)每次拿到新 text 就把整段重 parse,流式 50 token/s 意味着每秒 50 次全文 re-parse + re-tokenize。具体:

1. `inlineLocalImages(text)` 三次全文正则 replace(`Markdown.tsx:53-72`),每 token 一次
2. `<ReactMarkdown>{processedText}</ReactMarkdown>` 重建 mdast,每 token 一次
3. 长代码块在 `<SyntaxHighlighter>`(`Markdown.tsx:306`)里整块 Prism re-tokenize
4. `useIsLight`(`Markdown.tsx:17-34`)每个实例创建独立 MutationObserver,一屏 50 个 markdown = 50 个 observer

### 改造方案

**A. 流式期 vs 完结期分两套渲染**

在 `MessagePart` 加 `kind: "text"` 的 `streaming?: boolean`(reducer 里 `message_end` 时翻成 false)。`Markdown` 组件:

```tsx
// 流式期:用纯文本 + 简化样式,不走 ReactMarkdown
if (streaming) return <pre className="whitespace-pre-wrap">{text}</pre>;
// 完结期:才上 ReactMarkdown + Prism
return <ReactMarkdown>{processedText}</ReactMarkdown>;
```

这是最便宜也最有效的优化。代价:流式时看不到 markdown 渲染——但通常用户只会看着字往外冒,完结后再看格式化结果。

**如果需要流式也保留 markdown**,用方案 B:

**B. 增量 parse(切段)**

把消息按 `\n\n` 切成段(paragraph),每段独立 `<Markdown>`,React 用稳定 key(段索引)。增量 token 只重渲染最后一段:

```tsx
const paragraphs = useMemo(() => splitOnBlankLine(text), [text]);
return paragraphs.map((p, i) => <Paragraph key={i} text={p} />);
```

`Paragraph` 内 memo 浅比较 text。新 token 进来,前 N-1 段引用不变直接复用,只有最后一段重 parse。长会话尤其受益。

**C. Prism 按需加载**

当前 `react-syntax-highlighter` 默认带全部语言,bundle +1.5MB gzipped。改用 `prism-light` + 显式注册:

```ts
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import ts from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
SyntaxHighlighter.registerLanguage("typescript", ts);
// 只注册 ts/js/python/bash/json/html/css/sql 等常用语言
```

bundle 立省 ~1MB。冷启动渲染进程 parse JS 也快。

**D. `useIsLight` 单例化**

把 MutationObserver 抽到模块级,组件订阅一个 React store(`useSyncExternalStore`),50 个 markdown 实例共享 1 个 observer。

### 验收

长 markdown 流式过程中 Profiler 录制:`Markdown` commit time 应从 30-50ms 降到 <5ms。

## 五、主轴 3:事件批合并

### 病灶

`text_delta` 是 token 级粒度,理论 50-100 events/s。每个事件都触发 `setChatState` → 一次 React commit。即使主轴 1+2 优化到位,commit 次数本身也会撑爆。

### 改造方案

**SSE 服务端 batching(`app/api/agent/[id]/events/route.ts`)**

```ts
// 把 16ms 内的 text_delta 合成一个事件再 flush
let batch: AgentSessionEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;
function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushBatch(batch);
    batch = [];
    flushTimer = null;
  }, 16);
}
```

把同一帧内的 token 合并发出,前端 reducer 只跑一次。**这是最简单的 60fps 保证**——每帧最多一次 commit,单帧 budget 16.6ms。

**修复 ring buffer O(n) splice(`lib/agent-registry.ts:155-157`)**

改成环形索引,push 时 `events[head++ % MAX]`,getEventsSince 用 head 指针二分。或直接换成 [`mnemonist/circular-buffer`](https://yomguithereal.github.io/mnemonist/circular-buffer)。

### 验收

devtools Performance 在流式期间统计 React commit 次数:从 ~50/s 降到 60/s 上限(实际更少,因为 batch 后 16ms 内常无新事件就立刻 flush)。

## 六、主轴 4:Electron 架构裁剪

### 现状

```
┌─────────────────────┐       HTTP loopback       ┌──────────────────────────┐
│ Electron renderer   │ <───────────────────────> │ fork: Next standalone    │
│ (Chrome)            │  fetch / SSE / 静态资源    │ + pi-coding-agent SDK    │
└─────────────────────┘                            └──────────────────────────┘
```

冷启动:`waitForHttp /api/health` 200ms 步进探测(`electron/main.js:67-85`),一般要 1-3 秒。流式 SSE 走 HTTP chunked encoding,每条消息有 `data: {...}\n\n` 文本编解码开销。

### 改造方案(分阶段)

**Phase 1(低成本 / 即得):优化现有架构**

1. `BrowserWindow` 配置(`electron/main.js:277-292`)补齐:
   ```ts
   webPreferences: {
     ...,
     spellcheck: false,            // 中文输入卡顿元凶
     backgroundThrottling: false,  // 流式时窗口被遮挡也不限速
   }
   ```
2. `waitForHttp` 探测改成"server fork ready 后由 server-wrapper 直接 IPC 通知主进程"(`server-wrapper.js` 已经在跑,在那里 `process.send({ type: "ready" })` 即可),省 200-400ms 探测开销
3. `migrateFromEnvIfNeeded`(`main.js:433`)和 `buildEnvFromKeytar`(`main.js:109`)的 keytar 读改成并发(当前应该是串行)
4. 流式过程中 sidebar 5s 轮询 `/api/sessions`(`ChatApp.tsx:583`)替换成 **agent-registry 通过 SSE 主动推变更**——`agent_end` 时广播一条 `sessions_updated` 给所有连接的客户端,前端收到再 fetch。完全去掉 polling

**Phase 2(中成本):SSE 走 IPC 而非 HTTP**

只把 streaming 这一类高频路径改造,普通 fetch 维持 HTTP 不动,减小改动面:

```ts
// electron/main.js  (主进程订阅 standalone server 内部事件转发)
// 但因为 standalone server 是 fork 出来的,可以直接通过 process IPC 发事件
child.on("message", (msg) => {
  if (msg?.type === "sse_event") {
    win.webContents.send("agent-event", msg.payload);
  }
});

// renderer 改用 ipcRenderer.on("agent-event", ...) 替代 EventSource
```

这要求 Next.js server route 能把事件回流给 fork 的父进程——可以在 agent-registry 增加一个"主进程订阅"的钩子。**预期省 30-50% 流式延迟**(去掉 HTTP parser + chunked encoding)。

**Phase 3(高成本 / 可选):换成 `app://` 协议 + ipcMain**

把整个 server 拆出 Electron 主进程外,渲染进程不跑 Next runtime,只载入 build 好的 React bundle。所有数据接口用 `ipcMain.handle("api:xxx", ...)` 注册。

收益:启动快 1-2 秒;弊端:网页版和 Electron 版代码分叉,维护成本翻倍。**不推荐做,除非启动时间是硬指标。**

### SDK 重活隔离

`pi-coding-agent` 的 LLM 调用 + tool execution 当前在 Next standalone 同进程跑(`lib/agent-registry.ts:127-159`)。LLM 流式 IO 不阻塞,但**大 fs 操作(JSON.stringify session 上下文、`fs.readdir` sessions 目录)**会卡住同进程的 SSE 推送。

解法:把 fs 重活搬到 `worker_threads`:

```ts
// lib/heavy-worker.ts
// session list / session export / context build 这些放 worker
```

低优先级,等 Phase 1+2 做完再看。

### 验收

冷启动从 cmd-click 到看到第一帧 UI ≤ 1.5s;流式 token-to-render 延迟 < 50ms(目前估计 100-200ms)。

## 七、主轴 5:打包瘦身

### 现状

- dmg 177 MB
- `react-syntax-highlighter` 全语言 +1.5MB gzipped
- `pi-coding-agent` SDK 通过 `asarUnpack` 整包解出,体积大头

### 改造方案

1. Prism 按需注册(主轴 2 已说)
2. `react-markdown` 的 `remark-*` plugin tree-shake check
3. `pi-coding-agent` 看是否能裁剪未用 provider/tool 模块(SDK 维护方协调)
4. `electron-builder` 配置 `compression: maximum`,`asar.unpackDir` 只放真正需要 spawn 的二进制
5. `node_modules` 检查 nested duplicates,用 `pnpm dedupe` 或 `npm dedupe`

### 验收

dmg 目标 ~80-100 MB。

## 八、监控与回归

加两个轻量埋点,长期防止性能回退:

1. **渲染进程 fps 监控**:`requestAnimationFrame` 算 1s 窗口 fps,< 50 写控制台 + window title 红点
2. **SSE token-to-paint 延迟**:每 100 个 token 采样一次,从 SSE event 到 Markdown commit 时间,p95 > 100ms 告警
3. **构建 size 红线**:CI 跑 `next build` 后 assert `.next/static` 总大小,主 chunk 超 800KB 失败

## 九、落地路线图(建议顺序)

### Sprint 1(1-2 天 · 收益最大)
- [ ] 主轴 2.A:流式期不走 ReactMarkdown,纯 `<pre>` (`Markdown.tsx`)
- [ ] 主轴 2.C:Prism 改 PrismLight + 按需注册语言
- [ ] 主轴 2.D:`useIsLight` 单例化
- [ ] 主轴 3:SSE 服务端 16ms batching
- [ ] 主轴 4 Phase 1.1:Electron `spellcheck: false` + `backgroundThrottling: false`

### Sprint 2(2-3 天)
- [ ] 主轴 1.1+1.2:抽 `MessageList`,`MessageView` 加 React.memo,key 稳定化
- [ ] 主轴 1.3:zustand / `useSyncExternalStore` 拆分 state
- [ ] 主轴 4 Phase 1.2:server-wrapper IPC ready 信号替代 waitForHttp
- [ ] 主轴 4 Phase 1.4:sessions 用 SSE 推变更,去掉 5s polling

### Sprint 3(可选,2 天)
- [ ] 主轴 1.4:`@tanstack/react-virtual` 虚拟化(消息超 50 条触发)
- [ ] 主轴 2.B:Markdown 切段增量 parse(如果 Sprint 1.A 不够好)
- [ ] 主轴 4 Phase 2:streaming SSE 走 ipcMain
- [ ] 主轴 5:打包瘦身(Prism、dedupe、asar 配置)

### 持续
- [ ] 主轴 1.4 虚拟化(消息超 50 条触发)
- [ ] 监控埋点(fps + token-to-paint)
- [ ] CI 加 bundle size 红线

---

**总原则**:不要尝试一次做完。Sprint 1 全做完就能解决 80% 的问题,继续做的边际收益依次递减。每个 Sprint 结束都用 Performance 录制 baseline 对比,数据说话。
