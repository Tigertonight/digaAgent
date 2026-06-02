# RFC-3 F3：自动摘要 + 智能标题 —— 设计小结（mini-RFC）

> **状态**：📐 设计阶段（未开工）
> **作者**：Diga Agent 团队（含 AI 辅助）
> **创建**：2026-06-02
> **关联**：[RFC-3 主文](./2026-06-02-rfc-3-session-as-knowledge.md) §3.2.3 / §5 Phase B-F3
> **决策时机**：等 Phase B 上线 ≥ 2 周积累使用数据后再启动

---

## 0. TL;DR

F3 的目标：**sidebar item 第二行展示一句话摘要，让 30+ session 时一眼分清谁是谁**。

本文不是实施计划，是**开工前必须先回答的 5 个问题**的整理。决策没全部明确之前**不开工**——F3 单条调用成本和"用户感受质量差"的反噬比 F1/F2 都重，先把决策面定死再写代码。

**当前结论**（待用户确认）：

| 问题 | 我的推荐 | 不确定度 |
|------|---------|---------|
| 1. 复用 SDK compaction 还是另起轻量调用？ | **另起轻量调用** | 中（取决于 SDK compact 的 prompt 是否可控） |
| 2. 触发节奏？ | agent_end 后 30s 防抖 + 单 session 单日 ≤ 3 次 | 高（需要灰度观察） |
| 3. 用什么模型？ | 默认 Claude 3.5 Haiku，settings 可换 | 低 |
| 4. 成本上限怎么管？ | 单 session ≤ $0.005 / 单日全局 ≤ $0.5 → 超额暂停 | 低 |
| 5. 用户能否关闭 / 重新生成 / 手动编辑？ | 全部支持 | 低 |

→ 推荐**先做问题 3/4/5 的产品决策**（不依赖代码调研），再做问题 1/2 的工程决策（要做 spike）。

---

## 1. 为什么 F3 比 F1/F2 重要

Phase A + B 完成后：

- F1 给了 sidebar `meta.title`（手动）+ `meta.pinned` + `meta.lastSeenAt`
- F2 给了"找得到" —— 但前提是用户**知道**自己要搜什么

仍然没解决的痛点：

```
🟢 mini-pi-web                     2 分钟前      ← 这是干啥的？
🟢 mini-pi-web                     5 分钟前      ← 这又是干啥的？
   mini-pi-web                    14 分钟前
   pi-agent                       昨天
   mini-pi-web                    昨天
```

用户**扫一眼 sidebar 还是不知道哪个是哪个**。F1 的 `meta.title` 解决"想标的能标"，但 90% 的 session 用户不会手动标。

F3 = **每个 session 自动有一句话说清干了什么**。这是 sidebar 从"日期堆"变成"知识架"的最后一公里。

---

## 2. 为什么 F3 没和 F1/F2 一起做

主要 3 个原因，都是**工程外**的：

### 2.1 涉及 LLM 调用 = 涉及成本

F1/F2 是纯本地，0 成本。F3 是有成本的特性，单次摘要 ~$0.002，500 session 一波就 $1。决策面**完全不同**：

- 默认开 vs 默认关？
- 谁付钱（用户自己的 API key vs mini-pi-web 代付）？
- 超预算后行为？

### 2.2 涉及 LLM 调用 = 涉及 prompt 工程

跑通技术链路只是开始。**摘要质量**才是用户感知的核心：

- 中文 6-10 字标题不容易（容易生成"关于代码修改的对话"这种废话）
- 50-80 字摘要要"动作 + 结果"结构，不要"用户问了... agent 回答了..."这种白描
- 同一对话不同截断点结果差异大（取最近 20 turn vs 全文 → 摘要侧重点不同）

这个调试期需要 **真 session × ≥ 30** 的 fixture 才能看出 prompt 好坏。Phase B 上线后才有真 session 数据。

### 2.3 涉及触发节奏 = 涉及"打扰感"

F1/F2 是"用户主动用才有反应"。F3 是"agent 自动给你做事"——**节奏不对就是骚扰**：

- 每条 message 都重新生成 → 烧钱 + 摘要漂移让用户困惑
- agent 还没说完就生成 → title 像截图截在半句话上
- 跨日重新生成 → 用户以为自己刷新了 sidebar 但摘要变了

需要观察真实 session 节奏后再定参数。

---

## 3. SDK 现状调研（决策必读）

进入 F3 设计前的必修课：SDK 有没有现成能用？

### 3.1 SDK 已有 `compact()` 能力（用于 context 压缩，不直接是我们要的）

`AgentSession.compact(customInstructions?)` (`agent-session.d.ts:456`)：

```ts
compact(customInstructions?: string): Promise<CompactionResult>;
// 返回：{ summary: string, firstKeptEntryId: string, tokensBefore: number, details? }
```

**目的**：context window 满了时把旧对话压成 summary，**保留**最近 N 个 token。

**和 F3 的关系**：
- ✅ 复用：可拿到的 `summary` 是 LLM 生成的对话摘要，**接近** F3 想要的
- ❌ 不直接复用的理由：
  - compact 的 prompt 是 **"上下文压缩用"** 不是 **"sidebar 展示用"** —— 长度、风格、侧重都不一样
  - compact 只在 context 接近爆炸时触发（默认 reserveTokens 16384）—— 早期对话根本不会触发
  - compact 是"破坏性"操作（会改 session 文件），不能为了生成 sidebar title 主动触发
  - compact 单次调用很贵（要处理全部历史 message），不适合每 N turn 跑一次

→ **结论**：可以**借鉴** SDK 的 prompt 模板，但 **F3 必须另起独立的轻量 LLM 调用通道**。

### 3.2 SDK 暴露的 model 调用基建（可复用）

mini-pi-web 已经在用：

- `getModelRegistry()` (`lib/agent-registry.ts:94`)：从 settings 拿 default provider/model
- `mr.find(provider, modelId)`：解析成可调用的 `Model` 对象
- `getAuth()`：API key 链路（含 Electron secure storage）

**关键问题**：SDK 是否暴露"裸 LLM 调用"接口（绕过 `AgentSession`）？

需要 spike 验证：
- 翻 `node_modules/@earendil-works/pi-ai/` (底层 LLM provider 抽象)
- 看是否有直接的 `model.complete({ messages, ... })` 入口
- 如果没有：要么自己 wrap，要么"假装"建一个空 `AgentSession` 跑一轮（重）

**暂定假设**：能找到 `Model.complete()` 之类的直调入口。如果找不到，F3 复杂度 +50%。

### 3.3 SDK 还提供了 `setSessionName(name)` (`agent-session.d.ts:537`)

F3 生成的 title 应该顺便写回 SDK 的 session name —— 让 SDK 自己的 print mode / CLI 也能看到漂亮标题。**零成本副作用**，必做。

### 3.4 已有的 Phase A `meta` 结构能装 F3 输出

```ts
// lib/meta/types.ts 已有
interface SessionMeta {
  id: string;
  title?: string;       // ← F3 写入
  pinned?: boolean;
  lastSeenAt?: number;
  // ... 待加：summary?: string; suggestedLabels?: string[];
}
```

F3 不需要新建持久化层，**扩展 SessionMeta 加 3 个字段即可**：

```ts
+ summary?: string;
+ suggestedLabels?: string[];
+ summaryGeneratedAt?: number;  // 防止重复生成、显示"3 分钟前生成"
+ summaryModel?: string;        // 记录哪个模型生成的，便于追溯质量
+ summaryUserEdited?: boolean;  // 用户编辑过 → 后续触发不再覆盖
```

---

## 4. 待答的 5 个核心问题

### Q1：复用 SDK compaction 还是另起轻量调用？

**选项**：

| 方案 | 优 | 劣 |
|------|----|----|
| A. 复用 `AgentSession.compact()` | 0 新调用基建；复用 SDK 已经调好的 prompt | 风格不符 sidebar；不能"主动"在 context 没满时触发；破坏性强 |
| B. 另起轻量 `summarize()` 函数（直调 model） | prompt 可控；触发节奏可控；非破坏性 | 需要 spike SDK 的 model 直调接口；自己维护 prompt |
| C. 给 SDK 提 PR 加 `generateSummary()` API | 长期最干净；社区受益 | 周期长（review + 发版），v0 不可行 |

**推荐 B**，理由：
- F3 是产品差异化点，prompt 是核心资产，**必须可控**
- 触发节奏是产品决策，不能被 SDK 的 compaction trigger 绑架
- spike 成本可控（最多 0.5d）

**不确定点**：SDK model 直调接口存在 / 易用与否。**必须先 spike 0.5d 再正式估算 F3**。

### Q2：触发节奏？

**主轴**：什么时候**自动**触发，什么时候**用户主动**触发。

**自动触发候选**：

| 触发点 | 估算单 session 次数 / 周 | 风险 |
|--------|------|------|
| 每次 `agent_end` 立即 | 5-15 | 烧钱 + 频繁漂移 |
| `agent_end` 后 30s 防抖 | 3-8 | 防抖窗口太短，用户连续 prompt 时仍多触发 |
| `agent_end` 后 5min 防抖 | 1-3 | session 结束后用户可能马上跳走，5min 内未必有机会再 commit |
| 每累计 N 个 turn 触发一次 | 取决于 N | 简单可控，但首条摘要要等 N turn 后才出 |
| **混合**：首次 turn 5s 后立即跑一次 + 后续每 10 turn 跑一次 | 2-4 | **推荐** |

**手动触发**：必须有 ↻ 重新生成按钮。

**用户偏好优先**：如果用户在 sidebar 手编了 title，自动触发**不再覆盖**（看 `summaryUserEdited` flag）。

**推荐起点**：
- 首次：`agent_end` 5 秒后（不防抖，因为用户最想看的就是新 session 的标题）
- 后续：累计 10 个 user turn 后才再次触发，且距上次生成至少 5 分钟
- 单 session 单日上限 3 次
- 用户手编后停止自动触发

**这部分需要 Phase B 上线 ≥ 2 周后用真实数据微调**。

### Q3：用什么模型？

**默认模型对比**（来自 RFC-3 主文 §3.2.3）：

| 模型 | 单次成本 | 速度 | 中文质量 | 推荐 |
|-----|--------|-----|--------|------|
| Claude 3.5 Haiku | ~$0.002 | 1-2s | ✅ 优秀 | **默认** |
| GPT-4o-mini | ~$0.0015 | 1-2s | ✅ 良好 | 备选 |
| Gemini 2.0 Flash | ~$0.001 | < 1s | ⚠️ 偶有出戏 | 不默认 |

**关键决策**：
- 默认值绑定 `defaultProvider` + `defaultModel` 还是独立配置？
  - 推荐**独立**：用户可能 default 用 Claude Opus 工作，但摘要用 Haiku 省钱
- settings.json 加 `summary?: { provider?: string; modelId?: string }`，落地到全局 / 项目 settings 同样路径

**需要的 settings UI**：
- summary model 下拉（从 `getModelRegistry()` 可用列表选）
- "用默认 model" toggle
- 关闭整个 F3 toggle

### Q4：成本上限怎么管？

**风险**：用户挂着 mini-pi-web 跑 100 个 session/天 → 摘要花 $0.5 → 月度 $15。对个人付费用户**显眼**。

**护栏**：

| 维度 | 上限（推荐） | 超限行为 |
|------|------------|---------|
| 单次摘要 | $0.005（约 1500 tokens × Haiku $0.003/1k） | 截断输入到 200 turn |
| 单 session 单日 | 3 次 | 跳过，记录日志 |
| 全局单日 | $0.5 | 暂停自动触发，sidebar 显示"今日成本上限已达"，手动 ↻ 仍可用 |
| 全局单月 | $5 | 弹一次提醒，问"是否提高上限？" |

**预算管理实现**：复用 RFC-2 Phase A 的 Budget MVP 基建（如果已完成）—— **需要查 RFC-2 进度**。

**Provider 报销**：完全用用户自己 API key（mini-pi-web 不代付，沿用 SDK 现状）。

### Q5：用户能否关闭 / 重新生成 / 手动编辑？

**必须**全部支持：

- **关闭整个 F3**：settings 全局 toggle
- **关闭单 session F3**：session meta 加 `noAutoSummary?: boolean`
- **重新生成**：sidebar item hover 出 ↻ 图标
- **手动编辑 title**：点 sidebar item 标题进入编辑，保存后 `summaryUserEdited = true`，后续不自动覆盖（但 ↻ 仍可手动覆盖）
- **手动编辑 summary**：右键 sidebar item → "编辑摘要" → 进入小弹窗
- **重置为自动**：右键 "恢复自动" → 清除 `summaryUserEdited`，下次自动触发会覆盖

---

## 5. Prompt 模板初稿（待 fixture 测试微调）

```
你正在阅读一个 AI coding agent 的对话记录。
请输出严格符合下方 schema 的 JSON（不要 markdown 包裹，不要解释）：

{
  "title": "<6-10 个中文字，动宾短语>",
  "summary": "<50-80 字。第一句说目标，第二句说结果或当前状态>",
  "labels": ["<最多 3 个，从下表选或自创>"]
}

可选标签（推荐用，自创时也要简短）：
  bug-fix / refactor / new-feature / research / debug / docs / config / explore

要求：
- title 必须是「动作 + 对象」结构，例 "拆分 ChatApp 巨石组件"、"修复 sidebar 未读 bug"
- 禁止"关于 X 的对话"、"讨论 X" 这种废话开头
- summary 不要复述对话过程（"用户问了...assistant 回答了..."），只说**做了什么 + 现在到哪了**
- 如果对话还很初期（< 3 个 user turn），title 用首条 user message 提炼，summary 写 "用户提问 / 探索中"
- 全程中文输出（即使对话里有英文 code）

对话记录（最近 20 turn）：
---
{recent_turns_formatted}
---
```

**fixture 至少要覆盖**：

1. 短对话（< 3 turn）—— 不要硬编故事
2. 长 debug session —— 要识别"修了什么 bug"
3. 多次失败的 session —— summary 要诚实标 "未解决"
4. 纯探索 session —— 要识别 "research" 而不是凭空写 "实现了 X"
5. 已有 user 手动 title 的 session（理论上不再调用，但兜底测试）
6. 包含大量代码块的 session —— 不要把代码当成"做了什么"的描述
7. 中英混杂 session —— 输出要保持中文一致

---

## 6. 实施前置清单

按完成度排序，**绿色项可以现在就做**：

- ✅ Phase A 完成（`SessionMeta` 类型可扩展）
- ✅ Phase B 完成（sidebar 可显示新字段）
- 🟡 **决策清单（用户拍板）**：
  - [ ] Q3 默认模型（推荐 Claude 3.5 Haiku）
  - [ ] Q4 成本上限数字（推荐单日 $0.5 / 单月 $5）
  - [ ] Q5 编辑权限范围（推荐全开）
- 🟡 **Spike 任务（开工前）**：
  - [ ] SDK 是否暴露 model 直调接口？（0.5d，决定 Q1 选 B 还是 A）
  - [ ] 收集 ≥ 30 个真实 session 作为 prompt fixture
- 🟡 **依赖检查**：
  - [ ] RFC-2 Phase A Budget MVP 是否完成？（影响 Q4 实施复杂度）
- 🔴 **数据观察期**（最少 2 周）：
  - [ ] Phase B 上线后跟踪 sidebar 搜索使用率
  - [ ] 跟踪用户手动改 title 的频率（高 → F3 价值大）
  - [ ] 跟踪每个用户的 session/天 分布（决定单日预算合理值）

---

## 7. 估算（参考用，spike 后修正）

假设 Q1 选 B 且 SDK 暴露 model 直调接口：

| 子任务 | 工时 | 验收 |
|------|-----|------|
| F3.1 SDK model 直调 spike + 封装 `lib/summary/llm.ts` | 0.5d | mock + 真 API 跑通短 prompt |
| F3.2 `lib/summary/prompt.ts` + fixture 测试集 | 0.8d | 7 类 fixture 全部生成合理输出 |
| F3.3 `lib/summary/generate.ts`：拼接 + 解析 + 错误兜底 | 0.6d | 单测覆盖 LLM 返回畸形 JSON / timeout / 配额耗尽 |
| F3.4 `SessionMeta` 扩展字段 + 持久化（小改 Phase A） | 0.3d | 类型 + 单测 |
| F3.5 触发器：`agent_end` 后调度 + 防抖 + 频次限制 | 0.6d | 单测覆盖：连发 3 个 agent_end 只触发 1 次 |
| F3.6 成本守卫：单条 + 单日 + 单月（复用 RFC-2 Budget） | 0.4d | 超额时 sidebar 标"暂停" |
| F3.7 Settings：模型选择 + 全局开关 + per-session 开关 | 0.4d | 改完保存，下次启动生效 |
| F3.8 Sidebar：summary 渲染 + ↻ + 编辑入口 + "用户编辑" 守护 | 0.5d | 视觉对齐 |
| F3.9 `setSessionName(title)` 顺手回写 SDK | 0.1d | SDK print mode 列表看到漂亮标题 |
| F3.10 README + 设置页文档 | 0.2d | 文档可读 |
| **小计** | **4.4d** | — |

如果 Q1 选 A（复用 compact）：-1d（但产品体验劣化，需要权衡）。
如果 Spike 发现 SDK 无 model 直调：+1d（自己 wrap @earendil-works/pi-ai）。

---

## 8. 与 RFC-2 / 后续工作的耦合

### 8.1 与 RFC-2 Budget 的强依赖

F3.6 成本守卫**不应**重新发明轮子。如果 RFC-2 Phase A 已经做好 Budget MVP：
- F3 直接调 `budget.canSpend(estimatedCost)` 决定是否触发
- F3 的 LLM 调用走 budget 的 instrumentation 自动记账

如果 RFC-2 Phase A 尚未做：F3.6 工时翻倍（要自己实现轻量预算追踪 + 落到 settings）。

→ **强烈建议 F3 启动前先确认 RFC-2 Phase A 完成**。

### 8.2 后续可能的扩展（非 v0）

- **基于 summary 的 label 自动建议** → 用户点 "采纳" 加入 meta.labels
- **基于 summary 做更准的 search 排序**（搜索时给 summary 高权重）
- **跨 session 摘要聚合**：周报 "本周你跑了 X 个 session，主要做了 A、B、C"
- **可选 embedding 索引**：基于 summary 做语义检索，比 keyword 更智能

---

## 9. 下一步建议

1. **本轮先 freeze 这份小结，不开工** ← 当前节点
2. 用户确认 Q3 / Q4 / Q5 的产品决策
3. 等 RFC-2 Phase A 状态扫一遍（下个 step），如果未完成 → 排在 F3 前
4. 开 F3 时第一件事：跑 Q1 spike（0.5d）+ 收集 30 个真 session 作 fixture
5. 整个 F3 实施按 §7 拆分 phase，每个子任务独立 commit + 验证（沿用 Phase A/B/C 节奏）

---

## 10. 相关参考

- RFC-3 主文 §3.2.3：F3 原设计
- RFC-3 主文 §5 Phase B-F3：原估算（被本文修正）
- SDK 文件：
  - `core/agent-session.d.ts:456`（`compact()` 接口）
  - `core/agent-session.d.ts:537`（`setSessionName()`）
  - `core/compaction/compaction.d.ts`（`CompactionResult`、`shouldCompact` 等纯函数，可借鉴 token 估算逻辑）
- 类型扩展点：`lib/meta/types.ts`（SessionMeta + 5 个新字段）
- 调用基建：`lib/agent-registry.ts:94`（`getModelRegistry`）+ `getAuth`
