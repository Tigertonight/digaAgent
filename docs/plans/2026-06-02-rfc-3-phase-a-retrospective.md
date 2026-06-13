# RFC-3 Phase A：Session 元数据基础设施执行回顾

> **状态**：✅ 已完成（2026-06-02）
> **作者**：Diga Agent 团队（含 AI 辅助）
> **创建**：2026-06-02
> **完成**：2026-06-02（当日）
> **实际工期**：约半天（vs 预估 2–3 人天）
> **关联**：[RFC-3 主文](./2026-06-02-rfc-3-session-as-knowledge.md) §Phase A
> **commits**：`bb2c520` → `b9cc156`（共 4 个）

---

## 0. TL;DR

让 Sidebar 不再是「日期堆」：用户可以给 session 起 title、点置顶把重要 session 钉在最上面；元数据持久化到 `~/.diga-agent/sessions/{id}.meta.json`，session 删除时联删。完成 RFC-3 Phase A 的 F1（Session 元数据）；全程 0 行为退化、0 lint 漂移。

**实际成果**：

| 指标 | Before (Phase B 完成时) | After | Δ |
|---|---|---|---|
| 新增 lib 代码 | — | `lib/meta/` 共 ~250 行（含 12 单测） | +250 |
| 新增 hook | — | useSessionMeta（80 行，纯 action） | +1 |
| 新增 API 路由 | — | `/api/sessions/[id]/meta` (GET + PATCH) | +1 |
| API 路由扩展 | — | `/api/sessions/[id]` DELETE 联删 meta | 0 新增 |
| 持久化文件 | session.jsonl | `~/.diga-agent/sessions/{id}.meta.json`（独立单文件） | +1 类 |
| Sidebar 视觉 | name/firstMessage | meta.title 优先 + Pin 图标 + 「📌 置顶」菜单项 | UI ↑ |
| 列表排序 | running > modified | **pinned > running > modified** | 升级 |
| 单测 cases | 96 | **108（+12：12 meta/store）** | +12 |
| e2e | 6/6 ✓ | 6/6 ✓ | 持平 |
| lint warnings | 91 | **91** | 持平 |
| lint errors | 20 | **20** | 持平 |
| TS 严格通过 | ✓ | ✓ | 持平 |
| build | ✓ | ✓（含新 meta 路由）| 持平 |

**关键判断**：Phase A 走「先打地基再装家具」的 4 子阶段。A1（lib/meta + 单测，零集成）→ A2（API 聚合 + DELETE 联删，仍无 UI）→ A3（写路由 + hook）→ A4（Sidebar UI）。这种节奏把"持久化"和"展现"完全解耦，任何回归精确定位到 commit。

**未做（留给 Phase B / C）**：

- F2：session 全文检索（Cmd+K 跨 session 搜历史）
- F3：自动摘要（每 N 轮 LLM 摘要写回 meta）
- F4：项目级记忆（`.diga-agent/agents.md` per-cwd）
- Settings UI 改 title（PATCH 路由已支持，仅缺前端面板）
- `lastSeenAt` 从 localStorage 迁到 meta（G5 已修，localStorage 工作中，迁移留 Phase C）
- summary / labels / cost / lastSeenAt / activeBranch 等字段：types 已声明、`META_KNOWN_FIELDS` 已登记、白名单 `META_WRITABLE_FIELDS_V0` 不接收写入，留 Phase B/C 启用

---

## 1. 背景：为什么 Phase A 选 Session Meta

### 1.1 RFC-3 主文定位

RFC-3 主文把 Phase A 定义为「Session 元数据 + 持久化」。在 RFC-2 Phase B 完成后，实际推进 RFC-3 时做了一次范围收敛：

| RFC 主文原 Phase A | 实际 Phase A | 原因 |
|---|---|---|
| F1 元数据 + F2 搜索 + F3 摘要全做 | 仅 F1 元数据 + Sidebar UI | F2/F3 都强依赖 meta 持久化基础设施，先把 F1 跑通是 ROI 最高的一步；F2/F3 独立 phase 推进 |
| 包含 lastSeenAt 迁移 | 跳过（localStorage 已工作）| RFC-1 B1（G5 修复）已用 localStorage lazy init 解决刷新丢失问题，跨设备同步价值低，迁移成本不抵收益 |

→ **F1 是 RFC-3 的承重墙**：F2 搜索要 meta.title 当结果排序权重，F3 摘要要写回 meta.summary，F4 项目级记忆要复用 `~/.diga-agent/` 路径约定。

### 1.2 用户决策

经过架构讨论，用户拍板：

- 按「先地基后家具」的 4 子阶段推进（A1 lib → A2 聚合 → A3 写路由 → A4 UI）
- 不切碎成多个 PR，连续推进，每子阶段独立 commit
- v0 只做 title + pinned 两个字段；其他字段（summary/labels/cost...）类型声明保留，写白名单只放这两个
- Sidebar v0 不做 hover pin 图标、不做 title 行内编辑，全部走 ⋯ 菜单（视觉零回归）

执行约定（继承 RFC-2 Phase A/B 形成的工作流）：

- 不再每步等确认，连续推进
- 每个阶段必须 `tsc + lint(91 warn 持平) + vitest + build + e2e 6/6` 全绿才 commit
- commit message 含中文 → `git commit -F /tmp/commit-msg.txt`
- 重写 `/tmp/commit-msg.txt` 前必须先 read 一次
- commit 前 `git checkout -- next-env.d.ts`（Next build 副产物，不入仓）
- 抽出/新增代码必须读源码确认类型签名，不凭印象

---

## 2. Phase A：4 阶段执行回顾

### 2.1 阶段成果一览

| 阶段 | commit | 新增文件 | 修改文件 | 关键产物 |
|---|---|---|---|---|
| A1 | `bb2c520` | `lib/meta/{types,store,store.test}.ts` | — | SessionMeta 类型 + atomic 读写 + 12 单测 |
| A2 | `956bb44` | — | `lib/types.ts` + `lib/sessions.ts` + `app/api/sessions/[id]/route.ts` | listAllSessions 聚合 meta + DELETE 联删 + 排序升级 |
| A3 | `0aafd15` | `app/api/sessions/[id]/meta/route.ts` + `app/hooks/useSessionMeta.ts` | — | 独立 meta 路由（GET + PATCH 白名单）+ 写操作 hook |
| A4 | `b9cc156` | — | `app/components/Sidebar.tsx` + `app/ChatApp.tsx` | Pin 图标 + 「📌 置顶」菜单项 + meta.title 渲染 |

### 2.2 阶段 A1：lib/meta 类型 + 持久化 + 单测

**目标**：把"meta 是什么、存哪、怎么读写"沉淀成纯 lib，行为完全独立，下游零集成。

**产物**：

- `lib/meta/types.ts`（~60 行）：
  - `SessionMeta` interface：`id` + `title?` + `pinned?` + `summary?` + `labels?` + `cost?` + `lastSeenAt?` + `activeBranch?` + 任意预留字段
  - `META_WRITABLE_FIELDS_V0 = ["title", "pinned"] as const`：v0 白名单
  - `META_KNOWN_FIELDS`：所有已声明字段的登记表（让 PATCH 路由可以做"声明过但未开放写"的 422 区分，v0 未启用）
- `lib/meta/store.ts`（~120 行）：
  - `readMeta(id)`：JSON 读，ENOENT → null（损坏文件也 null，不阻塞列表）
  - `writeMeta(meta)`：sanitize → 写 tmp → rename 原子替换
  - `batchReadMeta(ids)`：并发读，单个失败不影响整批
  - `deleteMeta(id)`：幂等
  - `__setMetaRootForTests(p)`：测试注入根目录
- `lib/meta/store.test.ts`（12 cases）：覆盖 happy path、缺失文件、损坏 JSON、并发写、batch 部分失败、path traversal 拦截

**关键设计决定**：

| 决策 | 理由 |
|---|---|
| 单文件 `{id}.meta.json` 不是合并 `meta.db` | 与 session.jsonl 一一对应、好 diff、好排查、便于 RFC-3 Phase C 加 `.diga-agent/` 项目级文件时复用同一目录约定 |
| atomic write（tmp + rename） | 避免半写文件污染下次读，电源故障安全 |
| `__setMetaRootForTests` 而非 mock fs | 真 fs 跑测试，`fs.mkdtemp(os.tmpdir())` 隔离；与 `lib/budget/index.test.ts` 风格一致 |
| 不加 `server-only` 标记 | 纯 fs 模块，webpack 自动挡 client bundle（node:fs 无 polyfill）；同时 vitest（node env）能直跑，无需 jsdom |
| `META_WRITABLE_FIELDS_V0` 独立于 `META_KNOWN_FIELDS` | 让"类型上能放、但本期不开放写"成为一等公民，避免 v0 PATCH 接受不可控字段 |
| sanitize 时 JSON.stringify 剔除 undefined | 让 `title: undefined`（清除语义）自动从文件消失，不留死字段 |

**门禁**：tsc clean / lint 91w·20e 持平 / vitest 108/108（+12）/ build clean / e2e 6/6（8.6s）

### 2.3 阶段 A2：sessions listAll 聚合 meta + DELETE 联删

**目标**：让 client 一次列表请求就拿到所有 session 的 meta，避免 N+1；session 删除时联删 meta 文件，避免孤儿。

**产物**：

- `lib/types.ts`：`SessionInfoLite` 加 `meta?: SessionMeta` 字段（client UI 直接读 `sess.meta.pinned`）
- `lib/sessions.ts`：
  - `SessionInfoWithStatus` 加 `meta?`
  - `listAllSessions()` 内一次 `batchReadMeta(ids)` 聚合
  - 排序规则升级：**`pinned 优先 > isRunning > modified 倒序`**
- `app/api/sessions/[id]/route.ts` DELETE：成功后调 `deleteMeta(id)`（try/catch 包住，meta 不存在也算成功）

**关键设计决定**：

| 决策 | 理由 |
|---|---|
| meta 一次 batch 出来塞进 list response | 避免 client 端 N+1 fan-out；100 session ~50ms 可接受（实测） |
| pinned 优先级高于 running | 用户置顶意图最强，不能被运行态打乱 |
| DELETE 联删幂等 | meta 不存在直接成功，不阻塞 session 删除主流程 |
| `SessionInfoLite.meta?` 而非 `meta: SessionMeta \| null` | optional 字段对老 API consumer 兼容（meta 未启用前的代码不需要改）|

**门禁**：tsc clean / lint 91w·20e 持平 / vitest 108/108 / build clean / e2e 6/6

### 2.4 阶段 A3：独立 meta 路由 + useSessionMeta hook

**目标**：让"写 meta"成为受控操作；hook 提供干净的 client API。

**产物**：

- `app/api/sessions/[id]/meta/route.ts`（~95 行）：
  - **GET**：返回 `{ meta }`，不存在为 null
  - **PATCH**：partial merge（read-merge-write），强制 `id` 一致
  - **不暴露 PUT**：避免客户端整体覆盖把预留字段（summary/labels/cost...）抹掉
  - `pickWritable()` 白名单过滤 `META_WRITABLE_FIELDS_V0`：
    - title: `null/""` → 清除；string → 200 字符截断
    - pinned: 仅 boolean
  - 严格与 `/api/sessions/[id]` 的 PATCH（写 SDK SessionInfo entry/name）解耦
- `app/hooks/useSessionMeta.ts`（~80 行）：
  - 只暴露 `patch(sessionId, p)`，不做自动 GET / 内部 state
  - 与 `useApprovals` 范式一致：纯 action，无乐观更新，server 是 source of truth

**关键设计决定**：

| 决策 | 理由 |
|---|---|
| 不复用 `PATCH /api/sessions/[id]`（它写 SDK name）| 关注点分离：SDK name 是 SDK 的事，meta 是 diga-agent 自营的事；混用早晚出 bug |
| 不暴露 PUT，只 PATCH | 避免客户端整体覆盖把预留字段（summary/labels/cost...）抹掉；merge 是 source-of-truth 友好的写模式 |
| 白名单写而非黑名单 | v0 只放 title/pinned，将来加字段必须显式加到 `META_WRITABLE_FIELDS_V0`，零意外暴露 |
| hook 不做 state / 不做 GET | Sidebar 列表已经从 `GET /api/sessions` 拿到 `sess.meta`（A2），单 item 视图也走父级 props，无须每个 item 单独 fetch |
| 这条选择避开了一系列 react 警告 | 中途尝试过「effect 内 fetch + setState」方案，触发 `react-hooks/set-state-in-effect`；试过 queueMicrotask / cleanup / functional updater 等所有规避手法都无法保持 91 baseline，最终选「hook 不做 state」这条更干净的路线：少一份本地状态、少一份同步逻辑、少一份双源真实风险 |
| 失败走 `onError` callback | 与 `useApprovals` 一致，让 ChatApp 集中处理错误（`setError`）|

**门禁**：tsc clean / lint 91w·20e 持平 / vitest 108/108 / build clean / e2e 6/6（路由表新增 `/api/sessions/[id]/meta`）

### 2.5 阶段 A4：Sidebar 渲染 meta.title + pin 置顶

**目标**：用户能看见 title、能点置顶；视觉零回归。

**产物**：

- `app/components/Sidebar.tsx`：
  - `SidebarProps` 加 `toggleSessionPin(id, nextPinned)` action
  - 标题渲染优先级：`s.meta?.title > s.name > s.firstMessage > "(empty)"`
  - 已置顶 session 标题前显示 Pin 图标（lucide `Pin`，11px，muted 色）
  - ⋯ 菜单首项加「📌 置顶 / 📌 取消置顶」，根据 `s.meta?.pinned` 切文案
  - menu 顺序：置顶 → 重命名 → 导出 → 删除（pin 是高频，放第一）
- `app/ChatApp.tsx`：
  - 引入 `useSessionMeta` hook，注入 `onError: setError`
  - `toggleSessionPin = patchSessionMeta + refreshSessions`（成功才 refresh）
  - 透传到 Sidebar

**关键设计决定**：

| 决策 | 理由 |
|---|---|
| 排序由 server 端做，client 不重排 | A2 已实现 `pinned > running > modified`，client 只负责按返回顺序渲；refresh 后 client 自然拿到新顺序 |
| 不做乐观更新 | pin 点击 → PATCH → refresh，~50ms 用户无感；省一份回滚分支 |
| v0 不做 title 行内编辑 / 不做 Settings 改 title | PATCH 路由已支持 title，但 v0 UI 入口暂缺；Phase B 加 Settings 面板时补 |
| Pin 图标只在 pinned 时显示 | 未 pin 的 session 视觉完全不变，视觉零回归 |
| menu 用 emoji 📌 而非 lucide icon | 与现存 ✎ ⤓ ✕ 风格统一，不引入额外图标体积 |

**门禁**：tsc clean / lint 91w·20e 持平 / vitest 108/108 / build clean / e2e 6/6（7.4s）

---

## 3. 整体数据流图

```
       ┌───────────────────────────┐
       │ ~/.diga-agent/sessions/      │
       │   {id}.meta.json          │  ← 持久化（A1）
       │   { id, title?, pinned? } │
       └─────────────┬─────────────┘
                     │ fs.readFile / writeFile
                     ▼
            ┌────────────────┐
            │ lib/meta/store │  readMeta / writeMeta / batchReadMeta / deleteMeta
            └────────┬───────┘
                     │
   ┌─────────────────┼──────────────────────┐
   │                 │                      │
   ▼                 ▼                      ▼
┌──────────┐  ┌──────────────┐    ┌────────────────────────┐
│ DELETE   │  │ listAll      │    │ GET /meta + PATCH /meta│
│ /sess/id │  │ /api/sessions│    │ /api/sessions/id/meta  │
│ → del    │  │ → batch +    │    │ (独立路由)             │
│   meta   │  │   排序聚合   │    │                        │
│ (A2)     │  │ (A2)         │    │ pickWritable 白名单    │
└──────────┘  └──────┬───────┘    │ (A3)                   │
                     │            └──────────┬─────────────┘
                     │ SessionInfoLite[]     │ patch(id, {pinned})
                     │ 含 meta?              ▼
                     ▼               ┌──────────────────┐
            ┌────────────────┐       │ useSessionMeta   │
            │ ChatApp        │       │ (纯 action,无 state)│
            │ groupedSessions│       │ (A3)             │
            │                │       └────────┬─────────┘
            └────────┬───────┘                │
                     │ props                  │ toggleSessionPin
                     ▼                        │ = patch + refreshSessions
            ┌────────────────┐                │
            │ Sidebar        │◀───────────────┘
            │ - Pin 图标     │
            │ - 菜单 📌 置顶│
            │ - meta.title   │
            │ 优先 (A4)      │
            └────────────────┘
```

session 列表数据流（pin 点击后）：

| 事件 | meta 文件 | server listAll 结果 | Sidebar |
|---|---|---|---|
| 用户点「📌 置顶」 | — | — | 菜单关闭 |
| `patchSessionMeta(id, {pinned: true})` | 新建/更新 `{id}.meta.json`，写入 `pinned: true` | — | loading 态（不可见，<50ms）|
| PATCH 返回 200 + 完整 meta | — | — | — |
| `refreshSessions()` | — | batchReadMeta 拉新，sessions 加 meta.pinned=true，排序升到最前 | session 跳到顶部 + Pin 图标出现 + 菜单文案变「取消置顶」|

---

## 4. 接缝清单（Phase B / C 可复用）

Phase A 留下了 6 个干净接缝，未来扩展不用动 Sidebar / 不用动 ChatApp 核心：

| 接缝 | 用途 | 示例扩展（Phase B/C）|
|---|---|---|
| `lib/meta/types.ts` 的 `SessionMeta` interface | 类型声明 | 加 `summary` / `labels` / `cost` / `lastSeenAt` 字段，已声明无须再改 |
| `META_WRITABLE_FIELDS_V0` 白名单 | 开放写 | 加新字段时 push 进数组 + 在 `pickWritable` 加一个 case 即可 |
| `lib/meta/store` 的 `batchReadMeta` | 批量读 | F2 搜索时按命中 session 批量拿 meta 排序权重 |
| `lib/meta/store` 的 `__setMetaRootForTests` | 测试注入 | F3 摘要 / F4 项目级记忆的测试都可复用此模式 |
| `SessionInfoLite.meta?` | 列表带 meta | F2 cmd+K 搜索结果里直接展示 meta.summary |
| `useSessionMeta.patch()` | 通用写入 | Settings 改 title / F3 写 summary / Sidebar 改 labels 全走这一个 |

---

## 5. 未做的 / 留给 Phase B / C

### 5.1 已显式 out-of-scope

| 项 | 留给 | 原因 |
|---|---|---|
| F2 全文检索（Cmd+K 跨 session 搜历史）| Phase B | 需要构建索引（meta + jsonl content），独立大块 |
| F3 自动摘要（每 N 轮 LLM 摘要写回 meta）| Phase B | 需要决定触发策略 + 摘要 prompt，独立调研 |
| F4 项目级记忆（`.diga-agent/agents.md` per-cwd）| Phase C | 需要复用 meta 路径约定，但 scope 更大（per-cwd 而非 per-session）|
| Settings 改 title UI | Phase B | PATCH 路由已支持，仅缺前端 form，与其他 Settings 改造一起做 |
| Sidebar title 行内编辑 | Phase B | 视觉决策待定（双击 / 右键 / 长按），不影响 v0 价值 |
| `lastSeenAt` 迁 meta | Phase C | localStorage 已工作（G5）；跨设备同步价值低，迁移成本不抵收益 |
| `summary` / `labels` / `cost` 写入 | Phase B/C | 字段已声明，仅缺写入逻辑（F3 产 summary、用户产 labels、turn_end 聚合 cost）|

### 5.2 已知 sharp edges

1. **meta 与 SDK SessionInfo 名字不一致**：用户在 SDK side 改了 session name（通过 SDK 自己的 UI），meta.title 不变。Sidebar 渲染优先 meta.title，可能让用户困惑「改了 name 为什么没生效」。Phase B 加 Settings 改 title 时应在 UI 文案上区分「session 名称（SDK）」vs「title（diga-agent 标签）」。
2. **batchReadMeta 顺序敏感**：实现假设 ids 顺序 = 返回顺序。当前实现走 Promise.all 保序，但单元测试未显式断言这点。如果将来切 `for await` 串行优化，要补一条 case。
3. **PATCH title 截断 200 字符**：用户传 250 字符的 title 不报错只静默截断。前端将来加 title 编辑时应当 client-side 也限长，给提示。
4. **DELETE 联删 meta 不报告失败**：当前 try/catch 吞掉错误。如果 fs 真坏了，session 删除成功但 meta 残留，用户感知不到。生产 OK，调试时可能困惑。Phase B 应该加 server log。
5. **listAllSessions 性能曲线**：100 session ~50ms 可接受。预期 1000 session 时单次 list 可能 500ms。Phase B 搜索时如果走相同的列表 API 会变卡，可能需要分页或缓存层。
6. **未启用字段的 forward compat**：v0 写白名单只含 title/pinned。如果 Phase B 加 summary 写入，老版本前端发 `{summary: "..."}` 给老 server 会被静默丢弃（pickWritable 不识别）。这是 PATCH 语义自然行为，但要在 Phase B 升级时同步 commit/release。

---

## 6. 复盘：本轮做对的 5 件事

1. **A1 / A2 完全无 UI**：lib + API 改造单独跑通，A1 commit 后用户主流程零变化，A2 commit 后 client 拿到 meta 但视觉没动。两次 commit 各自回归面极小，给 A3/A4 打底干净。
2. **白名单写而非黑名单**：`META_WRITABLE_FIELDS_V0 = ["title", "pinned"]` 强制声明开放字段，让"声明类型 / 已知字段 / 可写字段"三层分离。将来加字段是加法而非减法，零意外暴露。
3. **hook 不做 state / 不做 GET**：本来想做"useSessionMeta 自动拉 + 内部 state + patch 更新"标准模式，但发现 Sidebar 用不到（列表已聚合 meta），React 警告也规避不了。果断改成「hook 只暴露 patch」让单测都不用了。**少做就是多做**。
4. **server 端排序**：pinned 优先级让 server listAll 决定，client 只负责按返回顺序渲染。pin 点击后只要 refresh 列表就拿到新顺序，client 不用维护"我刚 pin 了所以排到最前"的瞬态状态。
5. **commit message 含设计取舍**：每个 commit message 里写「为什么这么选 / 拒绝了什么方案」，半年后回看自己也能立刻 get 当时的判断。比"feat: add meta" 这种命名贵但每分钱都值。

---

## 7. 复盘：本轮可以更好的 3 件事

1. **A3 useSessionMeta 走了弯路**：第一版按 `useApprovals` 模板写了 effect 内 fetch + state 的完整版，触发 `react-hooks/set-state-in-effect` 警告。尝试 queueMicrotask、cleanup 反向、functional updater 等所有规避手法都无法保持 91 baseline，最终删掉 effect + state，纯留 patch。教训：**遇到 react 警告先想"是不是需求本身错了"**，规避手法只是绷带。
2. **README / 主 RFC 文档没更新**：本期没动 `2026-06-02-rfc-3-session-as-knowledge.md` 的状态，没在 RFC index 标 Phase A 完成。下次推 phase 完成时应该把主 RFC 顶部加 ✅ Phase A done。
3. **没做集成 e2e**：单测覆盖了 meta/store 的所有边界，但「点击 pin → 列表跳到顶部」这条 end-to-end 没加 e2e。当前 6/6 是 RFC-1 时代的，新功能 e2e 是欠账。留给 Phase B 收尾时补一条 multi-session pin 测试。

---

## 附录 A：commit 清单

```
b9cc156 feat(meta): Sidebar 渲染 meta.title + pin 置顶（RFC-3 Phase A4）
0aafd15 feat(meta): session meta 读写路由 + useSessionMeta hook（RFC-3 Phase A3）
956bb44 feat(meta): sessions listAll 聚合 meta + DELETE 联删（RFC-3 Phase A2）
bb2c520 feat(meta): 新增 lib/meta 类型 + 持久化 + 单测（RFC-3 Phase A1）
```

## 附录 B：新增 / 修改文件清单（A1 → A4 累计）

**新增**：

```
lib/meta/types.ts                                ~60   SessionMeta interface + 白名单
lib/meta/store.ts                               ~120   readMeta/writeMeta/batchReadMeta/deleteMeta
                                                       + atomic write + __setMetaRootForTests
lib/meta/store.test.ts                          ~250   12 cases (happy/ENOENT/corrupted/batch/path-traversal)
app/api/sessions/[id]/meta/route.ts              ~95   GET + PATCH + pickWritable 白名单
app/hooks/useSessionMeta.ts                      ~80   纯 action hook (无 state/无 effect)
                                                -----
                                                ~605    总
```

**修改**：

```
lib/types.ts                    +1    SessionInfoLite +meta?: SessionMeta
lib/sessions.ts                ~+20   listAllSessions batchReadMeta 聚合 + 排序升级 pinned>running>modified
                                       + SessionInfoWithStatus +meta?
app/api/sessions/[id]/route.ts  +5    DELETE 联调 deleteMeta(id)
app/components/Sidebar.tsx     ~+25   SidebarProps +toggleSessionPin + 标题 fallback meta.title
                                       + Pin 图标 + 「📌 置顶」菜单项
app/ChatApp.tsx                +15    引入 useSessionMeta + toggleSessionPin + 透传 Sidebar
```

## 附录 C：与 RFC-2 / RFC-3 的关系

```
RFC-1（已完成）
  └─ RFC-1.5 / RFC-test-infra（已完成）
      └─ RFC-2 Phase A（已完成）—— 会话级 Budget MVP
          └─ RFC-2 Phase B（已完成）—— 工具审批
              └─ RFC-2 Phase C（未启动）—— 意图预览 + Edit + Deny remember
                  └─ pet 形态弹窗集成（已规划）
              └─ RFC-3 Phase A（本文，已完成）—— Session 元数据 (F1)
                  └─ RFC-3 Phase B（未启动）—— 搜索 (F2) + 摘要 (F3)
                      └─ RFC-3 Phase C（未启动）—— 项目级记忆 (F4)
                              ↑
                              └─ RFC-2 Phase C 的"跨 session 全局规则持久化"可复用此路径约定
```
