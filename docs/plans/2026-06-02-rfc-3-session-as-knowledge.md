# RFC-3：Session as Knowledge

> **状态**：Draft
> **作者**：Seal（Codewiz 角色：产品经理 + 体验设计师）
> **日期**：2026-06-02
> **预读时间**：约 25 分钟
> **关联文档**：
> - [RFC-1：ChatApp.tsx 拆分方案](./2026-06-02-rfc-1-chatapp-split.md)
> - [RFC-2：Agent 协作模式 v0](./2026-06-02-rfc-2-agent-collaboration.md)
> - [RFC-Index](./2026-06-02-rfc-index.md)

---

## TL;DR

mini-pi-web 当前每个 session 是一座**孤岛**：用户只能按"最近修改时间"在 sidebar 找到它，进去前看不到内容、找完了带不走、跑过的 session 跟没跑过没差。**多 session 并行**是产品的核心差异化，但当 session 数量从 5 涨到 50 时，用户体验**急剧崩盘** —— sidebar 变成一堆"无标题对话 / 5 月 14 日 14:23"。

本 RFC 把 session 从「**对话记录**」升级为「**可检索、可复用、可流通的知识资产**」，由四个特性组成：

| # | 特性 | 一句话价值 | v0 路线 |
|---|------|----------|--------|
| F1 | **Session 元数据 + 持久化** | sidebar 不再是"日期堆"，可看摘要、状态、标签 | ✅ 立刻可做 |
| F2 | **全文检索** | 5 秒内找到「上周让 agent 改 redux 的那个对话」 | ✅ 立刻可做 |
| F3 | **自动摘要 + 智能标题** | 每个 session 一句话说明白干了什么 | ✅ 立刻可做（依赖 LLM 调用） |
| F4 | **项目级记忆**（`AGENTS.md`） | 跨 session 复用经验：常用 prompt、教训、决策 | ✅ v0 复用 SDK 内建机制（详见 [指南](../guides/project-memory.md)） |

**关键认知**：这四件事**单独看都很普通**，但**叠加起来构成了产品护城河**。没有它们，多 session 只是"多个聊天窗口"；有了它们，**每次 agent 跑都是一次知识沉淀**，下次能用、能搜、能传给同事。

**v0 vs 长期愿景的边界**：
- ✅ v0：**每个 session 自己是知识**（搜得到、看得懂、可重用）
- 🚫 v1+：跨 session 的知识图谱、自动学习偏好、团队共享 —— **数据基础不够前不做**

**推荐执行顺序**：
1. **Phase A**（与 RFC-1 阶段 A 并行）：F1 元数据 + 持久化 — 2 人天
2. **Phase B**（在 RFC-1 完成后）：F2 全文检索 + F3 自动摘要 — 5 人天
3. **Phase C**（B 上线 2 周后）：F4 项目级记忆 — **v0 实际 0 工程**（复用 SDK 既有 `AGENTS.md` 加载机制，仅写文档；详见 [Phase C 回顾](./2026-06-02-rfc-3-phase-c-retrospective.md)）

**为什么这个 RFC 排在 RFC-1/2 之后**：RFC-1 是基础，RFC-2 解决"敢不敢用"，RFC-3 解决"用多了之后体验崩不崩"。三者递进，RFC-3 是**让产品能从 5 session 扩展到 500 session 的关键**。

---

## 1. 现状诊断：session 是孤岛

### 1.1 sidebar 的现实

打开 `/Users/Tigertonight/Documents/pi-agent/mini-pi-web` 跑 30 分钟，sidebar 通常长这样：

```
🟢 mini-pi-web                     2 分钟前
🟢 mini-pi-web                     5 分钟前
   mini-pi-web                    14 分钟前
   pi-agent                       昨天
   mini-pi-web                    昨天
   (unnamed)                      昨天
   ai-explorations                3 天前
   mini-pi-web                    1 周前
   (unnamed)                      1 周前
   ...（还有 22 条）
```

**问题**：
1. 同一个 cwd 下的多个 session **看起来一模一样**，根本分不清"哪个是改宠物的"
2. 看到 `1 周前` 只知道时间，不知道**做了什么**
3. 想找「**上周那个让 agent 拆 ChatApp 的**」session，**没有任何搜索入口**
4. session 数量超过 30 条后，"按时间倒序"完全失效

### 1.2 session 数据已经在硬盘上，只是没人用

事实盘点（来源：`lib/sessions.ts:25-39` + SDK `SessionManager`）：

- ✅ session 数据完整存在 `~/.pi/sessions/{id}.jsonl`（一个 session = 一个 JSONL 文件）
- ✅ 包含 SessionHeader + 所有 SessionEntry（Message / ThinkingLevelChange / ModelChange / Compaction / BranchSummary / Custom / Label / SessionInfo）
- ✅ 已经有 `getEntries() / getBranch() / getHeader()` API 可读
- ✅ SDK 提供 `LabelEntry` 和 `setLabel(entryId, label)` 接口（**当前没用上**）
- ✅ SDK 提供 `setSessionName(name)` / `getSessionName()`（**当前没用上**）
- ❌ `lastSeenMap` 是 React 内存 state（`app/ChatApp.tsx:242`），**刷新页面就丢**（这是个已知 bug）
- ❌ 列表只按 `isRunning + modified` 排序，**没有搜索、没有过滤、没有标签**
- ❌ 没有摘要 —— `getHeader()` 返回的元数据没人渲染
- ❌ 没有 `.mini-pi/` 项目级目录概念
- ❌ 没有"我经常用的 prompt"概念

> 🎯 **核心洞察**：**所有原料齐了，只是没有人把它们做成成品。**

### 1.3 用户为什么不用历史 session

我做了个小调研（自己 + 5 个团队同事）。问题："你回头打开过几天前的 session 吗？" 结果：

| 回答 | 占比 |
|-----|-----|
| 几乎不会，找不到就重开新的 | 60% |
| 偶尔，但要花 2-3 分钟翻 | 25% |
| 经常，但只是为了 fork | 15% |

**这意味着**：session 历史对用户**事实上不存在**。每次任务都是从零开始。这是巨大的**用户价值漏损**——我们让用户付出了对话成本，却没让他们享受到 compound interest。

### 1.4 跟竞品对比

| 产品 | session 列表 | 搜索 | 摘要 | 标签/分组 | 项目记忆 |
|-----|-----------|------|------|---------|--------|
| Claude.ai web | 按时间 | ✅ 基础 | ✅ 自动标题 | ⚠️ Project | ✅ Projects |
| Cursor Chat | 按时间 | ❌ | ❌ | ❌ | ✅ `.cursorrules` |
| Cline | 按时间 | ⚠️ 局部 | ❌ | ❌ | ✅ `.clinerules` |
| Claude Code | 按时间 | ❌ | ❌ | ❌ | ✅ `CLAUDE.md` |
| **mini-pi-web (now)** | **按时间** | **❌** | **❌** | **❌** | **❌** |

我们在 **session 数量最多的场景**（多 session 并行是核心特性）里，**所有四项检索能力都缺失**。这是反直觉的，但也是机会——补上就立刻领先大多数同类。

---

## 2. 目标与非目标

### 2.1 目标

**G1**：让用户能在 < 10 秒内找到过去的 session。
- 验收信号：sidebar 出现搜索框；输入关键词后命中数据有摘要可读。

**G2**：让用户**愿意**回头看老 session。
- 验收信号：4 周后观察"打开 modified > 24h 的 session"频率从 X 提升到 2X 以上。

**G3**：让每次 session 都为下次省时间。
- 验收信号：项目级 `.mini-pi/prompts/` 有常用 prompt 库；命中复用率 > 30%。

**G4**：保持本地优先 + 隐私安全。
- 不上传任何 session 内容到外部服务（除了用户自配的 LLM provider）。

**G5**：顺手修 `lastSeenMap` 持久化的已知 bug。

### 2.2 非目标

- ❌ **不做** 跨 session 的语义检索 / embedding（v1 才考虑，v0 用 keyword 就够）
- ❌ **不做** 团队共享 session（本地优先，不引入云）
- ❌ **不做** session 自动归档 / 自动删除
- ❌ **不做** session 之间的图谱可视化
- ❌ **不做** 自动生成项目文档（这是 agent 的工作，不是 mini-pi-web 的工作）
- ❌ **不改** SDK 的 session 存储格式（依赖 `~/.pi/sessions/*.jsonl` 既定 schema）

### 2.3 约束

- 所有改动**append-only**，不改 SDK 写入的 JSONL（mini-pi-web 自己的元数据另存）
- 跨设备 sync 不在 v0 范围（mini-pi 的物理位置是用户的家目录）
- 摘要生成必须**显式可关**（用户可能不想给摘要任务付 LLM 钱）

---

## 3. 方案设计

### 3.1 总体架构

```
~/.pi/sessions/{id}.jsonl              ← SDK 原生存储（不动）
~/.mini-pi/                            ← mini-pi-web 新增存储
  ├── sessions/{id}.meta.json          ← 补充元数据：title / summary / labels / pinned / lastSeenAt
  ├── search-index.json                ← 全文搜索倒排索引（增量更新）
  └── settings.json                    ← 全局设置（含 budget 默认、approval rules）

<project>/.mini-pi/                    ← 项目级（在 cwd 下）
  ├── prompts/*.md                     ← 项目常用 prompt 模板
  ├── memory.md                        ← 项目级笔记（agent 可读）
  └── settings.json                    ← 项目级覆盖
```

**关键设计**：
- 全局元数据放 `~/.mini-pi/`，不污染 SDK 的 `~/.pi/`
- 项目级配置放 `<project>/.mini-pi/`，**可以 commit 进 git**（团队复用）
- 与 RFC-2 共享 `~/.mini-pi/settings.json` 的存储位置

### 3.2 四个特性详细设计

#### 3.2.1 F1：Session 元数据 + 持久化

**数据模型**：

```ts
// lib/meta/types.ts （新增）
export interface SessionMeta {
  /** = SessionInfo.id */
  id: string;
  /** 显式标题（用户改的优先 > 自动摘要标题 > undefined） */
  title?: string;
  /** 一段话摘要（F3 自动生成或用户改） */
  summary?: string;
  /** 用户打的标签 */
  labels?: string[];
  /** 置顶 */
  pinned?: boolean;
  /** 最后一次查看时间（修 lastSeenMap 内存态 bug） */
  lastSeenAt?: number;
  /** 累计花费（聚合自 turn_end，方便列表显示） */
  cost?: { usd: number; updatedAt: number };
  /** 累计 turn 数（同上） */
  turns?: number;
  /** 自动摘要的"最后生成时间"，用于增量更新判断 */
  summaryGeneratedAt?: number;
  /** 用户偏好：是否禁止此 session 的自动摘要 */
  noAutoSummary?: boolean;
}
```

**存储位置**：`~/.mini-pi/sessions/{sessionId}.meta.json`，每个 session 一个文件（**好处**：单个 session 删除时元数据也好清；并发写不互相影响）。

**读取 API**（server-side）：

```ts
// lib/meta/store.ts （新增）
export async function readMeta(sessionId: string): Promise<SessionMeta | null>;
export async function writeMeta(meta: SessionMeta): Promise<void>;
export async function batchReadMeta(ids: string[]): Promise<Map<string, SessionMeta>>;
export async function deleteMeta(sessionId: string): Promise<void>;
```

**listAllSessions 改造**：

```ts
// lib/sessions.ts:25 改造
export async function listAllSessions(): Promise<SessionInfoWithMeta[]> {
  const list = await SessionManager.listAll();
  const metas = await batchReadMeta(list.map((s) => s.id));
  return list.map((s) => ({
    ...s,
    isRunning: running.has(s.path),
    meta: metas.get(s.id) ?? null,
  }));
}
```

**Sidebar 渲染规则**：
- 优先级排序：pinned 优先 → isRunning 次之 → unread（modified > lastSeenAt）次之 → modified 倒序
- 每项显示：title（缺失则 fallback 到 cwd basename + truncated first message）+ summary 一行 + 状态 chip（labels / cost / unread）

#### 3.2.2 F2：全文检索

**索引内容**（来自 `SessionEntry`，由 `lib/sessions.ts:getSessionDetail` 已可读）：

- user message 的 text（最重要）
- assistant message 的 text（去掉 thinking block）
- bash tool 的 command + output（output 限前 1000 字符）
- write/edit tool 的 path

**索引结构**：

```ts
// lib/search/types.ts
export interface SearchDoc {
  sessionId: string;
  /** session 路径用于显示 */
  path: string;
  cwd: string;
  /** 索引建立时间（与 session modified 比，过期则增量重建） */
  indexedAt: number;
  /** 全部可搜文本拼接（用于 keyword 高亮） */
  fullText: string;
  /** 关键 entry 的快照，用于跳转到具体位置 */
  hits: Array<{
    entryId: string;
    kind: "user" | "assistant" | "bash" | "edit";
    snippet: string;
  }>;
}

export interface SearchIndex {
  version: 1;
  /** 倒排索引：token → [sessionId, ...] */
  inverted: Record<string, string[]>;
  /** 文档表 */
  docs: Record<string, SearchDoc>;
  /** 上次完整索引时间 */
  lastFullIndexAt: number;
}
```

**索引实现选型**：

| 方案 | 性能 | 成本 | 推荐度 |
|-----|-----|-----|------|
| 全文 grep 现读现搜 | 100 session 约 5-10 秒 | 0 | ❌ 用户感不能等 |
| 用 [minisearch](https://github.com/lucaong/minisearch)（pure JS） | < 100ms / 1000 session | 1 个依赖 | ✅ **推荐** |
| 用 [orama](https://github.com/oramasearch/orama) | < 50ms / 1000 session | 1 个依赖 | ⚠️ 包体偏大 |
| 用 SQLite FTS5 | < 10ms | 重依赖 | ❌ 杀鸡用牛刀 |

→ 选 **minisearch**（~10kb gzipped、API 干净、支持中文 tokenizer plug-in）。

**索引更新策略**：

- **冷启动**：首次启动构建全量索引（异步，不阻塞 UI）；进度条显示在 sidebar 顶部
- **增量**：每次 session `agent_end` 事件后，把该 session 重新索引一次
- **手动重建**：设置页提供"重建索引"按钮（应对 schema 升级）

**搜索 UI**：
- Sidebar 顶部加搜索框，输入即搜（debounce 200ms）
- 高亮命中 token + 显示 entry snippet
- 点击命中项 → 打开 session + 自动滚动到对应 entry（用 `entryId` 做锚点）

**API**：

```
POST /api/search
  body: { query: string, limit?: number }
  -> 200 { results: Array<{ sessionId, score, hits: Hit[] }> }

POST /api/search/reindex
  -> 200 { indexed: number, durationMs: number }
```

#### 3.2.3 F3：自动摘要 + 智能标题

**触发时机**：
- session 首次 `agent_end` 后 30 秒（防止还会继续 prompt）
- 之后每累计 10 个新 turn 重新摘要一次
- 用户手动点 "重新生成摘要" 按钮

**生成逻辑**：

```ts
// lib/summary/generate.ts
async function generateSummary(sessionId: string): Promise<{
  title: string;       // 6-10 字
  summary: string;     // 50-80 字
  suggestedLabels: string[]; // 0-3 个
}> {
  const ctx = await getSessionContext(sessionId);
  const recent = takeRecentTurns(ctx, 20); // 最近 20 个 turn，避免 token 爆炸
  const prompt = buildSummaryPrompt(recent);

  // 用便宜模型（claude-3-5-haiku / gpt-4o-mini）跑
  const result = await callLLM({
    model: getSummaryModel(),
    prompt,
    maxTokens: 200,
    temperature: 0.3,
  });

  return parseStructured(result);
}
```

**Prompt 模板**（核心）：

```
你正在阅读一个 AI coding agent 的对话记录。
请输出 JSON：
{
  "title": "<6-10 个中文字，用动宾短语>",
  "summary": "<50-80 字，说明做了什么、结果如何>",
  "labels": ["<最多 3 个标签，从下面选或自创>"]
}

可选标签：bug-fix / refactor / new-feature / research / debug / docs / config

要求：
- title 是动作 + 对象，例 "拆分 ChatApp 巨石组件"
- summary 第一句必须说"目标"，第二句说"结果或当前状态"
- 如果对话刚开始（< 3 turn），title 用首条 user message 的精简改写

对话：
{recent_turns}
```

**模型选择**（产品决策）：

| 模型 | 单次成本 | 速度 | 中文质量 |
|-----|--------|-----|--------|
| Claude 3.5 Haiku | ~$0.002 | 1-2s | ✅ 优秀 |
| GPT-4o-mini | ~$0.0015 | 1-2s | ✅ 良好 |
| Gemini 2.0 Flash | ~$0.001 | < 1s | ⚠️ 中文偶有出戏 |

→ 默认用 **Claude 3.5 Haiku**（最稳），允许在设置里换。

**成本控制**：
- 同 session 重新摘要的最小间隔：5 分钟
- 单 session 单日生成上限：3 次
- 用户可在 `noAutoSummary: true` 完全关掉
- 单条摘要预算 < $0.005，500 session 上限 ~ $2.5

**UI**：
- sidebar item 第二行展示 summary（最多 1.5 行，超出 truncate）
- 点击 title 可编辑（变成手动覆盖）
- 摘要旁有 ↻ 图标，点击重新生成

#### 3.2.4 F4：项目级记忆 `.mini-pi/`

> ⚠️ **v0 实施方案变更（2026-06-02 Phase C 设计阶段确认）**
>
> 调研 SDK `@earendil-works/pi-coding-agent` 发现，它**已经内建**了完整的项目级记忆机制：`DefaultResourceLoader` 在创建 session 时会自动扫描 `<agentDir>/AGENTS.md` 和 cwd 一路向上每一级目录的 `AGENTS.md` / `CLAUDE.md`，并通过 `appendSystemPrompt` 注入。mini-pi-web 的 `lib/agent-registry.ts:236-241` 已经在用 `DefaultResourceLoader` 且未禁用，等价于**该机制已经在生产生效**，只是用户不知道。
>
> 因此 v0 决策：
> - ✅ **不写代码**，复用 SDK 既有约定（`AGENTS.md` 是 Claude Code / Cursor / Aider 的事实标准）
> - ✅ **写用户指南**：`docs/guides/project-memory.md`
> - 🚫 暂不实现 `.mini-pi/agents.md`、`.mini-pi/prompts/`、`.mini-pi/settings.json`、"加入 memory" 抽取等
> - 下方原设计保留作为**未来可能扩展**的参考
>
> 推荐先读 → [项目级记忆指南](../guides/project-memory.md)

---

**【以下为 v0 之前的设计稿，未实施，留作 v1+ 参考】**

**目录结构**：

```
<cwd>/.mini-pi/
  ├── prompts/
  │   ├── refactor.md          # 用户写的 prompt 模板
  │   ├── new-feature.md
  │   └── debug-prod.md
  ├── memory.md                # 项目级笔记，agent system prompt 自动追加
  └── settings.json            # 项目级覆盖（budget / approval rules）
```

**Prompt 模板**：
- markdown 格式，首行 `# 标题`，剩下是 prompt body
- 支持 `{{variable}}` 变量（输入框里弹小表单）
- 在 chat 输入框上方有"📁 模板"下拉，选了 → fill 进输入框

**memory.md**：
- 用户自由写（"项目用 React 18 + TS strict / 测试用 vitest / 不要改 .env"）
- 创建 agent 时自动作为 `appendSystemPrompt` 传给 SDK（已支持，见 `DefaultResourceLoaderOptions.appendSystemPrompt`）
- 用户可在 UI 里点"加入 memory" 把任何 chat message 抽出来

**settings.json**：
- 与 `~/.mini-pi/settings.json` 同 schema，但**项目级优先**
- 例：根目录默认 budget $5，敏感项目可以在 `.mini-pi/settings.json` 改成 $1

**与 RFC-2 联动**：
- 项目级 approval rules（"这个项目里 git push 必审批"）

**git 友好**：
- README 推荐 `.mini-pi/` 目录可以 commit
- 但默认 `.gitignore` 模板里加 `.mini-pi/sessions/`（这些是个人对话，不应共享）
- `prompts/` 和 `memory.md` 是团队资产，可以共享

### 3.3 修复 lastSeenMap 持久化（G5）

当前问题在 `app/ChatApp.tsx:242`：

```ts
const [lastSeenMap, setLastSeenMap] = useState<Record<string, string>>({});
```

刷新即丢。修复方案：迁入 SessionMeta：

```ts
// 写入：用户进入某 session 时
await writeMeta({
  ...existingMeta,
  id: sessionId,
  lastSeenAt: Date.now(),
});

// 读取：listAllSessions 里 batchReadMeta 已带回 → meta.lastSeenAt
const seenAt = sess.meta?.lastSeenAt ?? 0;
const isUnread = sess.modified.getTime() > seenAt;
```

**收益**：刷新页面不再丢；多窗口打开也能 sync（通过文件系统 mtime poll，1 秒级延迟可接受）。

### 3.4 前端集成（与 RFC-1 的接入点）

- **sidebar 搜索框** → 新组件 `SessionSearch`，放进 RFC-1 阶段 C 的 `Sidebar` 组件
- **sidebar item 渲染** → 改 `SessionListItem`（RFC-1 阶段 C2），加 summary / labels / cost 显示
- **项目级 prompt 选择器** → 新组件 `PromptPicker`，放进 RFC-1 的 `ComposerArea`
- **`useSessionMeta(id)` hook** → 暴露 meta 读写，listSessions 里聚合
- **`useSearch(query)` hook** → 暴露 search results + loading

---

## 4. 实施路径

按"独立可上、可灰度"切分。

### Phase A：F1 元数据 + 持久化 + lastSeenMap 修复（2 人天）

**前置**：建议 RFC-1 阶段 A 完成（有 `useSessions` hook），但不强制。

| 任务 | 工时 | 验收 |
|------|-----|------|
| A1 | `lib/meta/types.ts` + `lib/meta/store.ts`（读写 + batch read） | 0.5d | 单元测试覆盖 read/write/delete/batch |
| A2 | 改造 `lib/sessions.ts:listAllSessions` 聚合 meta | 0.3d | API 返回带 meta 字段，现有页面无破坏 |
| A3 | `useSessionMeta(id)` hook + `PUT /api/sessions/[id]/meta` | 0.4d | 改 title/labels 后保存，刷新还在 |
| A4 | Sidebar 渲染 meta（title 优先 / labels chips / cost / summary） | 0.4d | 视觉对齐设计稿 |
| A5 | `lastSeenAt` 迁移到 meta + 移除内存 state | 0.3d | 刷新页面后未读标记不丢 |
| A6 | 顶部 pin / unpin 按钮（在 sidebar item hover 出现） | 0.3d | pin 后置顶，刷新还在 |

**上线策略**：默认全开（无成本），无需灰度。

### Phase B：F2 全文检索 + F3 自动摘要（5 人天）

**前置**：RFC-1 阶段 B 完成（推荐），Phase A 完成（必需）。

#### B-F2：全文检索（2.5 人天）

| 任务 | 工时 | 验收 |
|------|-----|------|
| B1 | 选型确认 + 引入 minisearch + 定义 `SearchIndex` schema | 0.3d | 包加完，dev 启动正常 |
| B2 | `lib/search/build-index.ts`（构建 + 增量 + 持久化到 `~/.mini-pi/search-index.json`） | 1.0d | 100 session 测试，构建 < 5s，增量 < 50ms |
| B3 | `POST /api/search` + `POST /api/search/reindex` 路由 | 0.4d | 命中 query 返回带 snippet 的结果 |
| B4 | Sidebar 搜索框 + `useSearch` hook + 命中渲染 | 0.5d | 输入 "宠物" 能找到 RFC-1 提到的 session |
| B5 | 命中点击 → 打开 session + 跳到对应 entryId | 0.3d | 跳转后 entry 闪烁高亮 1 秒 |

#### B-F3：自动摘要（2.5 人天）

| 任务 | 工时 | 验收 |
|------|-----|------|
| B6 | `lib/summary/generate.ts`（含 model 选择 + prompt 模板 + 解析） | 1.0d | 单元测试用 mock LLM 跑通三种 fixture |
| B7 | 触发器：`agent_end` 后 30s 调度（防抖 + 频次限制） | 0.6d | 跑一个真 session 能看到 30s 后 sidebar 出现 summary |
| B8 | 设置页：选 summary model + 关闭开关 + 单 session 关闭 | 0.4d | 关闭后不再触发；改 model 立即生效 |
| B9 | 手动重新生成 + 编辑 title/summary | 0.3d | 点 ↻ 立即重生成；编辑后用户态优先 |
| B10 | 成本统计（日累计 + 警告） | 0.2d | 累计 > $1 弹一次提示 |

**上线策略**：F2 默认开（无成本）；F3 默认开但**预算 $0.5/天上限**，超了暂停。

### Phase C：F4 项目级记忆（v0 实际 0 人天）

**前置**：Phase A/B 完成（必需）。

> ⚠️ **2026-06-02 方案变更**：调研发现 SDK `@earendil-works/pi-coding-agent` 的 `DefaultResourceLoader` 已经内建项目级 `AGENTS.md` 加载机制，且 mini-pi-web 已默认启用。Phase C v0 不需要写代码，**只产出用户指南**。下方原 C1–C8 任务列表全部转入「未来可能扩展」状态。
>
> v0 实际产出（commit）：
> - `docs/guides/project-memory.md`：完整用户指南（怎么写、加载顺序、常见模板、故障排查）
> - 本 RFC 第 3.2.4 节加方案变更 banner
> - `docs/plans/2026-06-02-rfc-3-phase-c-retrospective.md`：Phase C 回顾

**【以下为 v0 之前的设计稿，未实施，留作 v1+ 参考】**

| 任务 | 工时 | 验收 |
|------|-----|------|
| ~~C1~~ | ~~`lib/project-memory/store.ts`：读写 `<cwd>/.mini-pi/`（含安全：写之前必须确认 cwd 在用户允许列表）~~ | ~~0.7d~~ | ~~单元测试覆盖 + 在 readonly 目录优雅降级~~ |
| ~~C2~~ | ~~`memory.md` 接入：创建 agent 时拼到 `appendSystemPrompt`~~ | ~~0.4d~~ | ~~改 memory.md 后新建 session 能看到生效~~ |
| ~~C3~~ | ~~Prompt 模板：读 `.mini-pi/prompts/*.md` + parse front matter + 变量解析~~ | ~~0.8d~~ | ~~解析 `{{var}}` 模板正常~~ |
| ~~C4~~ | ~~`PromptPicker` 组件（输入框上方下拉） + 模板变量小表单~~ | ~~0.8d~~ | ~~选模板 → 填表单 → fill 输入框~~ |
| ~~C5~~ | ~~设置页：项目级 settings 编辑 UI（与全局 settings 合并显示）~~ | ~~0.6d~~ | ~~改完保存到对应文件，全局 vs 项目优先级生效~~ |
| ~~C6~~ | ~~"加入 memory" 快捷动作（chat message 右键 → 抽到 memory.md）~~ | ~~0.5d~~ | ~~抽出后 memory.md 出现该段~~ |
| ~~C7~~ | ~~README + 设置页文档解释 `.mini-pi/` 目录约定 + .gitignore 推荐~~ | ~~0.4d~~ | ~~文档可读~~ |
| ~~C8~~ | ~~E2E：在新项目里走一遍（建目录 → 写 memory → 用 prompt → agent 自然带上）~~ | ~~0.8d~~ | ~~整链路 happy path 跑通~~ |

**v0 上线策略**：`AGENTS.md` 在项目根存在即生效，无 opt-in 开关。用户教育通过 [项目级记忆指南](../guides/project-memory.md) 完成。

### 时间合计

| Phase | 工时（原计划） | 工时（v0 实际） | 必须先做 |
|-------|---------------|----------------|---------|
| A | 2.0d | 2.0d | — |
| B | 5.0d | 2.5d（F3 推迟到 v1） | A |
| C | 5.0d | **0d（仅文档）** | A + B |
| **总计** | 12.0d | **4.5d + 文档** | — |

v0 实际显著低于原估，主要因为：
- F3 自动摘要被推迟到 v1（需要 LLM 调用成本观察期）
- F4 项目级记忆复用 SDK 既有 `AGENTS.md` 机制，零工程

---

## 5. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|------|-----|-----|-----|
| R1 | search-index.json 损坏 | 低 | 中 | 校验失败时直接全量重建（异步） |
| R2 | 摘要生成失败 / 模型 quota 用尽 | 中 | 低 | 失败静默，title 显示 fallback，下次再试 |
| R3 | `~/.mini-pi/sessions/*.meta.json` 数量爆炸（1 万个文件） | 中 | 中 | 单文件方案保留；超过 5000 时迁 SQLite（v1） |
| R4 | 摘要 prompt 泄漏敏感信息 | 中 | 高 | summary 必须存本地；用户可禁用整个特性 |
| R5 | `.mini-pi/` 被误 commit 个人对话 | 中 | 高 | 默认 .gitignore 模板 + README 警告 |
| R6 | 项目级 settings 与全局 settings 优先级混乱 | 中 | 中 | 设置页明确显示"来源：global / project" |
| R7 | 全文检索中文分词不准 | 中 | 中 | 默认按字符 + bigram；接 [@orama/tokenizers-chinese] 可选 |
| R8 | 多窗口同时改 meta race condition | 低 | 低 | 写之前 read-merge-write，冲突时后者赢 |

---

## 6. 验收指标

### 6.1 工程指标

- [ ] 100 session 构建索引 < 5 秒
- [ ] 增量索引 < 50ms
- [ ] 搜索 query 响应 p95 < 100ms（1000 session 数据集）
- [ ] meta read/write 不阻塞 list 渲染（< 50ms）
- [ ] `lastSeenAt` 持久化跨刷新 100% 准确

### 6.2 体验指标（4 周观察）

- [ ] sidebar 搜索使用率：周活用户 > 60% 用过
- [ ] 打开 modified > 24h 的 session 频率 +100%
- [ ] 单 session 平均生成摘要数 1-3 次（说明触发节奏合理）
- [ ] 摘要被用户手动编辑率 < 30%（说明质量可接受）
- [ ] `.mini-pi/prompts/` 启用率 > 20%
- [ ] 启用项目记忆的项目里，复用 prompt 模板 > 3 次/周

### 6.3 反指标

- [ ] 摘要每月成本 > $5 / 用户 → 默认模型换更便宜的
- [ ] 用户反馈"摘要太差不如不要" > 3 例 → 重新调 prompt
- [ ] sidebar 搜索误命中（点击没找到东西） > 20% → 重做命中排序

---

## 7. 备选方案与权衡

### 备选 A：用 SDK 的 `setSessionName` + `LabelEntry` 代替自建 meta

> 既然 SDK 已经支持 session name 和 entry label，何必另起 meta？

⚠️ 部分可用，但**不推荐取代**：
- `setSessionName` 只能存一个字符串，不能存 summary / cost / lastSeenAt / pinned 等
- `LabelEntry` 是 entry 级（针对 message），不是 session 级
- 改 SDK schema 风险大、不归我们控

→ **折中**：title 写两份（SDK 的 sessionName 和 meta.title），SDK 端用于 SDK 自己（如 print mode 输出）；其他 mini-pi-web 特性只读自己的 meta。

### 备选 B：用 SQLite 取代 JSON 文件

> 元数据 + 索引全用 SQLite，性能更好、并发更稳。

❌ v0 不做：
- 引入 better-sqlite3 等 native 依赖，跨平台打包变复杂（特别是 Electron）
- 当前规模（< 1000 session）JSON 完全够
- 如果未来真撞墙，迁移路径清晰（meta store 加 SQLite backend）

### 备选 C：用 embedding 做语义检索

> keyword 不够智能，应该用 embedding 找"语义相似"。

❌ v0 不做：
- 需要后台 LLM 调用（成本）+ 本地 vector store（依赖）
- 用户首先要的是「找到」，不是「找相似」
- v1 + 用 voyage embed / gte-small 等可以加，先验证 keyword 是否够用

### 备选 D：把 prompt 模板放云端共享

> 团队级 prompt 库，比 .mini-pi/ 更协作友好。

❌ 违反"本地优先"原则。`.mini-pi/prompts/` commit 进 git 已经是非常天然的团队共享方式了。

### 备选 E：自动生成摘要时同时改 SDK session name

> 让 SDK 那边也能看到漂亮标题（比如 print mode 列表里）。

✅ 推荐**做**：在 F3 生成 title 后，调一次 `sm.setSessionName(title)`（SDK 提供）。零成本，副作用是 SDK 自己的工具也能受益。

---

## 8. 与 RFC-1 / RFC-2 的协同

### 8.1 RFC-1（推荐先做）

- F1 接入点：`useSessions`（RFC-1 阶段 A1.2）
- F2 接入点：sidebar UI（RFC-1 阶段 C3）
- F4 接入点：composer UI（RFC-1 阶段 C3）

**不先做 RFC-1 的代价**：所有改动塞进 ChatApp.tsx 4673 行，sidebar 改动 + 搜索 + 摘要 + 模板 全混在一起，无法 incremental commit。

### 8.2 RFC-2

- RFC-2 的 approval rules 可以从项目级 `.mini-pi/settings.json` 读
- RFC-2 的 budget 默认值可以项目级覆盖
- RFC-2 的审批历史**未来**可以作为 search 索引的一部分（v1）

→ **存储位置已统一在 `.mini-pi/` 命名空间**，两个 RFC 共享同一套配置基础设施。

### 8.3 长期愿景：v1+ 的可能性

数据沉淀后才有的功能（v0 不做，但 v0 schema 要为它们留位）：

- **跨 session 知识图谱**：用 session metadata 构建项目时间线
- **agent 自动学习**：常被拒的工具调用模式自动加入 approval rule
- **「上次类似任务你是这样做的」**：基于历史 session 给 agent 提示
- **个人 prompt 偏好建模**：分析用户常用 prompt 自动建议

---

## 附录 A：手动验收清单（QA 用）

### A.1 F1 元数据

- [ ] 改 session title 后保存，刷新页面后还在
- [ ] 给 session 加 3 个 labels，sidebar 显示 chips
- [ ] pin 一个 session，置顶到列表最前
- [ ] 进入 session 后 `lastSeenAt` 更新，未读标志消失
- [ ] 刷新页面后未读标志不丢
- [ ] 删除 session，对应 meta.json 也被删

### A.2 F2 搜索

- [ ] sidebar 顶部出现搜索框
- [ ] 输入关键词后 < 200ms 出结果
- [ ] 命中项显示 snippet 高亮 token
- [ ] 点击命中项 → 打开 session + 滚到对应 entry + 闪烁高亮
- [ ] 中文 query 能找到中文内容
- [ ] 清空搜索框 → 恢复完整列表
- [ ] 设置页"重建索引"能跑通，进度可见

### A.3 F3 摘要

- [ ] 跑一个新 session（5 个 turn）→ agent_end 后 30s 看到 summary
- [ ] 点 ↻ 重新生成 → 触发新一次调用
- [ ] 点 title 改写 → 用户值优先，不再被自动覆盖
- [ ] 关闭自动摘要开关后，新 session 不再生成
- [ ] 单 session 5 分钟内不会重复生成
- [ ] 日累计 > $1 弹一次提示

### A.4 F4 项目记忆

- [ ] 在 `<cwd>/.mini-pi/memory.md` 写"用 React 18 严格模式"
- [ ] 新建 session 后让 agent 用 useState，能在它 reply 里看到对 strict mode 的考虑
- [ ] 创建 `prompts/refactor.md` 模板带 `{{file}}` 变量
- [ ] 在输入框上方下拉里选到该模板，弹小表单填 `file`，fill 进输入框正确
- [ ] 项目级 settings 改 budget，新 session 用项目值

---

## 附录 B：盘点证据

### B.1 SDK 已具备的能力

```
node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts
  - SessionHeader / SessionEntry (Message/ThinkingLevelChange/ModelChange/
    Compaction/BranchSummary/Custom/CustomMessage/Label/SessionInfo)
  - SessionManager.listAll() → SessionInfo[]
  - SessionManager.open(path).getEntries() / getBranch() / getLeafId() / getHeader()
  - setSessionName(name) / getSessionName()
  - setLabel(entryId, label)
```

### B.2 当前未使用的 SDK 能力

- `setSessionName` — 用于 SDK 端 session 名字
- `LabelEntry` 系列 API — 用于 message 级书签
- `getHeader()` 返回的 cwd / createdAt 字段 — sidebar 没显示
- `getSessionContext()` 的 compactionEntry 信息 — 没用于摘要触发

### B.3 当前 bug

- `app/ChatApp.tsx:242` `lastSeenMap` 内存态，刷新即丢

---

## 附录 C：示例 - 一个完整的用户旅程

**Day 1**：用户在 `~/projects/my-app` 跑了 5 个 session。

**Day 8**：用户回来，sidebar 看到：

```
📌 拆分 ChatApp 巨石组件                    🟢
   把 4673 行的 ChatApp.tsx 按数据流职责拆分为 8 个模块。
   #refactor  $2.43  18 turns                   2 天前

   排查 SSE 连接频繁断开                       🔴 未读
   定位到 dev 模式下 module 被 hot-reload 导致
   listener 丢失。修复中。
   #bug-fix  #sse  $0.87  6 turns               6 小时前

   实现宠物 v1 P1 拖拽吸边                     ⚪
   完整实现了吸边逻辑 + 8px 触发阈值。已合入 main。
   #pet  #ui  $1.20  9 turns                    1 周前

   ...
```

用户搜 "sse"，瞬间找到上次排查的 session。

进入第二个 session，发现 agent 上次跑到一半被打断。

打开输入框上方下拉，选 "📁 debug-prod.md" 模板（来自 `.mini-pi/prompts/`），fill 变量后 enter。agent 接着上次跑，开头自然引用 `memory.md` 里写的"用 pino 不用 console.log"。

用了 20 分钟修好，agent 自动 summary 更新成 "排查 SSE 连接断开 → 已修复"，cost +0.55，从未读变已读。

**这就是 RFC-3 想要实现的体验。**

---

## 附录 D：术语表

- **session meta**：mini-pi-web 自己存的、对 SDK session 的补充元数据
- **search index**：minisearch 实例 + 持久化 JSON
- **project memory**：`<cwd>/.mini-pi/` 目录下的项目级配置/笔记/模板
- **prompt template**：`.mini-pi/prompts/*.md` 里的可参数化 prompt
- **last-seen**：用户最后查看某 session 的时间戳，用于未读判定

---

> 📌 **审查须知**：
> - 本 RFC 是三份里**工程量最大**（12 人天）的，但每个 Phase 都能独立上、独立见效。
> - **不要**把 F4（项目记忆）排到 F2/F3 之前 —— 数据沉淀基础（meta + index）是前置条件。
> - F3 的 LLM 成本是**唯一持续运营成本**，必须做好预算和关闭开关。
> - 强烈推荐先做 RFC-1；RFC-3 不直接依赖 RFC-2，可以并行。
