# RFC-3 Phase C：项目级记忆（F4）执行回顾

> **状态**：✅ 已完成（2026-06-02）
> **作者**：Diga Agent 团队（含 AI 辅助）
> **创建**：2026-06-02
> **完成**：2026-06-02（当日，与 Phase A/B 同日）
> **实际工期**：< 1 小时（仅文档调研 + 撰写）
> **关联**：[RFC-3 主文](./2026-06-02-rfc-3-session-as-knowledge.md) §F4、[Phase B 回顾](./2026-06-02-rfc-3-phase-b-retrospective.md)
> **commits**：1 个（docs only）
> **代码改动**：**0 行**

---

## 0. TL;DR

调研 SDK `@earendil-works/pi-coding-agent` 时发现，**项目级记忆机制已经内建并默认开启**。diga-agent 的 `lib/agent-registry.ts:236-241` 早就在用 `DefaultResourceLoader`，等价于用户在项目根创建 `AGENTS.md` 即生效——只是没人知道。

因此 Phase C v0 **零工程实施**，产出仅：
- 用户指南 `docs/guides/project-memory.md`
- RFC-3 主文方案变更 banner（§3.2.4、§5 Phase C 表）
- 本回顾

| 指标 | Before (Phase B 完成时) | After | Δ |
|---|---|---|---|
| 代码改动 | — | **0 行** | — |
| 新增 lib | — | — | — |
| 新增 hook / API / UI | — | — | — |
| 单测 cases | 152 | 152 | 持平 |
| e2e | 6/6 ✓ | 6/6 ✓ | 持平 |
| lint warnings / errors | 91 / 20 | 91 / 20 | 持平 |
| TS 严格通过 | ✓ | ✓ | 持平 |
| build | ✓ | ✓ | 持平 |
| 新依赖 | — | 0 | — |
| 新增文档 | — | 2（指南 + 回顾） | +2 |

**关键判断**：Phase C 最大的产出**不是代码，是认知更新**。在开工前花 30 分钟读 SDK 源码，把"自己重新造一遍"的计划改成"教用户用既有能力"，节省了 5 人天估算工时，并避免了与 SDK 机制并存的双重注入风险。

---

## 1. 背景：为什么从「写代码」变成「写文档」

### 1.1 原计划（RFC-3 主文）

RFC-3 主文 §3.2.4 设计了 `.diga-agent/` 命名空间：

```
<cwd>/.diga-agent/
  ├── prompts/*.md       # prompt 模板（含 {{var}} 变量）
  ├── memory.md          # 项目级笔记，注入 system prompt
  └── settings.json      # 项目级 settings 覆盖
```

§5 Phase C 拆成 C1–C8 共 5 人天，覆盖：
- `lib/project-memory/store.ts` 读写
- `memory.md` 接入 `appendSystemPrompt`
- prompt 模板解析 + UI picker
- 项目级 settings 合并
- "加入 memory" 抽取
- README + e2e

### 1.2 Phase C 设计阶段的关键澄清问题

进入 Phase C 时，我向用户提了 3 个开放问题：

- **Q1**：记忆文件位置？（a）`<cwd>/.diga-agent/agents.md` （b）`~/.diga-agent/agents.md` （c）两者都支持
- **Q2**：怎么注入到 agent？（a）prepend system prompt （b）`appendSystemPrompt` （c）走 SDK `instructions` 字段
- **Q3**：v0 是否含 UI 编辑入口？（a）只读 （b）含 UI

用户答 `cca`：c（两者都支持）/ c（SDK instructions）/ a（只读手工编辑）。

### 1.3 决定性发现：SDK 已经做了所有事

为了验证 Q2 的 (c) 是否真有 SDK 口子，我去翻 `node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.{d.ts,js}`，发现：

**`loadProjectContextFiles({ cwd, agentDir })`**（`resource-loader.js:47-75`）：
1. 自动加载 `<agentDir>/AGENTS.md`（或 `CLAUDE.md`）
2. 从 cwd 一路向上扫到 `/`，每一级目录的 `AGENTS.md` / `CLAUDE.md` 都加载（ancestor chain）
3. 去重（路径相同只加载一次）
4. 候选文件名固定 4 个：`["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]`，**单目录单文件**（按顺序取第一个）

**`DefaultResourceLoader`** 进一步暴露：
- `systemPrompt?: string`：整段替换
- `appendSystemPrompt?: string[]`：**追加**到 system prompt ←—— 这正是 Q2 (c) 等价的口子
- `agentsFilesOverride?` / `systemPromptOverride?` / `appendSystemPromptOverride?`：终极改写

**`AgentSession`** 内部拼装（`agent-session.js:635-650`）：
```js
const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
const appendSystemPrompt = loaderAppendSystemPrompt.length > 0
  ? loaderAppendSystemPrompt.join("\n\n") : undefined;
const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
// → buildSystemPrompt({ cwd, skills, contextFiles, customPrompt, appendSystemPrompt, ... })
```

**diga-agent 当前注入点**（`lib/agent-registry.ts:236-241`）：
```ts
const resourceLoader = new DefaultResourceLoader({
  cwd: opts.cwd,
  agentDir: getAgentDir(),
  settingsManager: getSettingsManager(opts.cwd),
  extensionFactories: [collabExtension],
});
```

未传 `noContextFiles`，SDK 默认 `noContextFiles = false`（`resource-loader.js:136`），**即默认开启加载**。

→ 结论：**项目级记忆机制已经在生产生效**，只是 diga-agent 没在任何文档里告诉用户怎么用。

### 1.4 方案重定向

发现后立即停下来向用户做二次澄清，列三个方案：

- **方案 X**：拥抱 SDK 既有约定（用 `AGENTS.md` 在项目根），零工程
- **方案 Y**：坚持 `.diga-agent/agents.md` 自己的命名空间，自己读 + `appendSystemPrompt` 注入
- **方案 X+Y**：都支持

推荐 X，理由：
1. 零工程成本，符合"v0 先跑通"原则
2. `AGENTS.md` 是行业事实标准（Claude Code / Cursor / Aider 都认）
3. SDK 的 ancestor chain 比原计划的 global + project 双层还更强
4. `.diga-agent/agents.md` 后续要加并不被锁死

用户拍板 **X**。

---

## 2. 实际产出

### 2.1 用户指南：`docs/guides/project-memory.md`

约 210 行，覆盖：

| 章节 | 内容 |
|---|---|
| TL;DR | 30 秒上手范例 |
| §1 价值定位 | 不带记忆 vs 带记忆的痛点对比 |
| §2 三个文件位置 | global（`~/.config/diga-agent/AGENTS.md`）/ project root / monorepo 父目录链 |
| §3 加载顺序与去重规则 | 完整描述 SDK 行为（全局优先 → ancestor root → cwd / 路径去重 / 单目录单文件） |
| §4 常见场景模板 | Next.js+TS / Python 数据项目 / 团队共享 + 个人偏好分离 |
| §5 验证方法 | 3 种验证 agent 真的读到了 |
| §6 注意事项 | 敏感信息 / 长度 / 重复 / 命名大小写 / .gitignore |
| §7 工具兼容性 | 与 Claude Code / Cursor / Aider 的标准互通 |
| §8 v0 路线图 | 明示当前不做什么（UI 编辑、抽取、`.diga-agent/` 命名空间） |
| §9 故障排查 | 4 个常见 FAQ |
| §10 相关文档 | 回链 RFC + SDK 源码 |

设计原则：
- 每一条"SDK 行为"描述都贴 SDK 文件路径，可验证
- 不藏"未来可能做" —— §8 直接列出 v0 不做的清单，避免用户误期
- 给具体模板（Next.js / Python）而不只讲抽象规则
- "故障排查"覆盖唯二真实可能踩的坑：文件名大小写 + cwd 走偏

### 2.2 RFC-3 主文更新

- §F4 表格行：补充 "v0 复用 SDK 内建机制" 标注 + 指南链接
- §3.2.4 顶部加方案变更 banner（5 行说明 + "以下为 v0 之前设计稿" 分隔）
- §5 Phase C 表格：原 C1–C8 任务保留但全 strikethrough，v0 实际产出在表格上方独立列出
- §时间合计表：增加"v0 实际"列，标注 Phase C 0d，总计从 12d 降到 4.5d + 文档

### 2.3 RFC index 更新

`docs/plans/2026-06-02-rfc-index.md` 路线图甘特图加注："RFC-3 Phase C：项目记忆（v0 改用 SDK AGENTS.md，0 工程）"。

### 2.4 commit

单个 docs commit，不动任何 `.ts` / `.tsx` / `package.json`。

---

## 3. 这次得到的方法论

### 3.1 「先调研再写代码」的实际收益

如果按原 Phase A/B 节奏直接进入 C1（写 `lib/project-memory/store.ts`），结果会是：

- 5 人天工时
- 与 SDK 的 `loadProjectContextFiles` 机制并存，需要额外设计：
  - 谁注入优先级高？
  - 是否要 dedup？
  - 用户写了 `AGENTS.md` **又**写了 `.diga-agent/agents.md` 怎么办？
- 用户认知负担：两套并行的 "项目记忆" 机制
- 后期维护：SDK 升级影响行为时，自己这一层要持续追

仅花 30 分钟读 SDK 源码（4 个文件 < 200 行），把所有这些问题消灭在设计阶段。

### 3.2 SDK 是 "黑盒" 还是 "可读源码"？

之前 Phase A/B 把 SDK 当黑盒（只看导出类型签名）。这次 Phase C 改成"先翻具体实现"，发现：

- `node_modules/@earendil-works/pi-coding-agent/dist/` 是 JS + d.ts，**完全可读**
- `resource-loader.js` 全文 < 750 行，关键逻辑（`loadProjectContextFiles`）< 50 行
- `agent-session.js:635-650` 这种"组装时"的关键代码靠 grep 一次就能定位

→ 后续 Phase 默认行为：**遇到「这个能力 SDK 是不是已经有」的问题，先翻 d.ts 再问，必要时翻 .js**。

### 3.3 "拥抱事实标准 > 自创命名空间"

原 RFC-3 起草时设计 `.diga-agent/` 命名空间是出于"不污染项目根"的洁癖。但：

- `AGENTS.md` 已经被 Claude Code / Cursor / Aider 接受为事实标准
- 用户的项目里可能**已经**有 `AGENTS.md`（为其他工具准备）
- 用户切换工具时不用重写
- "项目根多一个文件"的污染远小于"用户每个工具都要单独维护一份记忆"的痛

`.diga-agent/` 命名空间未来可以作为**可选扩展**（如果有用户反馈"项目根不希望多文件"），但 v0 没必要先做。

### 3.4 "0 代码 commit" 也是 commit

这次 commit 只有 docs。这件事本身需要被记录、被回顾：

- 价值不在改了多少行
- 价值在把"原本要写 5 人天的代码"消灭在设计阶段
- 把 SDK 既有能力**可被用户发现** = 真实的产品改进

后续类似场景：如果发现某个 feature 其实底层已经支持但用户不知道，docs-only commit 是完全合法的 phase 产出。

---

## 4. 未做（留给未来）

按用户接受度倒序排列，越靠前越可能下一波就做：

### 4.1 短期可能（看用户反馈）

- **`.diga-agent/agents.md` 作为可选位置**：如果有用户反馈"不喜欢项目根多文件"，加 diga-agent 自己读 `.diga-agent/agents.md` 并通过 `appendSystemPrompt` 追加（确保与 SDK 自动加载的 `AGENTS.md` 不重复 dedup）
- **Settings 面板里的 "memory 入口"**：在 settings 加一个 "Project Memory" 区块，显示当前 cwd 下检测到的 `AGENTS.md` 路径 + "在编辑器打开" 按钮（不做内嵌编辑器，避免 race condition）
- **Sidebar 指示器**：某 session 启动时加载了哪些 memory 文件，hover sidebar 项时小图标提示

### 4.2 中期（v1+）

- **`.diga-agent/prompts/` 模板系统**：原 RFC-3 §3.2.4 设计的 prompt 模板 + `{{var}}` 变量解析 + ComposerArea 集成
- **"加入 memory" 抽取**：右键 chat message → "提炼到 AGENTS.md"
- **项目级 settings.json**：与全局 settings 合并显示，优先项目级

### 4.3 长期（v2+）

- **AI 自动学习**：agent 发现"用户反复纠正同一件事" → 提议加入 memory
- **跨 session 知识图谱**：自动从所有 session 抽事实，与 memory 合并

---

## 5. 验收

| 项 | 状态 |
|---|------|
| 用户指南可读、可执行（按指南操作能让 agent 真的读到 AGENTS.md） | ✅（写有 3 种验证方法） |
| 不改任何代码 | ✅（0 行） |
| 不引入新依赖 | ✅ |
| 单测 / lint / e2e / build 全持平 | ✅（无代码变动，自动持平） |
| RFC-3 主文方案变更可追溯 | ✅（§F4 + §3.2.4 + §5 三处变更） |
| 与 SDK 既有机制不冲突 | ✅（直接复用） |

---

## 6. 相关 commits

```
<待 commit 后填入> docs(rfc): RFC-3 Phase C 改用 SDK AGENTS.md 机制 + 用户指南
```

---

## 7. 与下一轮的衔接

RFC-3 全部 v0 范围（F1 + F2 + F4）完成。剩余：

- **F3 自动摘要**：独立小型 RFC，需要先决策 LLM provider / 触发节奏 / 成本预算
- **RFC-3 体验指标观察**：sidebar 搜索使用率、`AGENTS.md` 采用率、跨 session 跳转率（需要先建埋点）

或回头优化 RFC-1 / RFC-2 未完成项。下一步排期由用户拍。
