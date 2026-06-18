# Agent Profiles Design

> **状态**：Draft
> **创建**：2026-06-18
> **目标**：把“代码模式 / 日常工作模式”从单一枚举升级为可组合的 agent profile 体系
> **依据**：`docs/research/codex-modes-2026-06-18.md`
> **范围**：Profile 配置模型、内置预设、UI 展示、运行时执行、迁移方案、验收标准

---

## 0. TL;DR

Codex 官方没有“简单模式 / 复杂模式”这两个概念。用户口语里的简单和复杂，本质上是几条独立轴的组合：

1. **审批策略**：要不要每次问用户。
2. **权限边界**：agent 能不能写文件、联网、执行高风险命令。
3. **推理强度**：模型要不要花更多预算做复杂规划。
4. **工具集**：当前任务暴露哪些能力。
5. **展示密度**：过程是全量展示、分组折叠，还是极简摘要。
6. **沟通身份**：agent 是偏工程协作，还是偏日常工作助手。

因此 diga-agent 不应该把“代码模式 vs 日常工作模式”做成一个二选一枚举。正确设计是：**底层正交轴，顶层 profile 打包**。

用户看到的是 `Quick Chat`、`Daily Research`、`Code Review`、`Code Edit`、`Yolo Refactor` 这样的 profile；系统内部保存的是多条轴的组合配置。这样既能一句话切换，也不会把“推理深度”“权限大小”“工具展示”混成一个隐含语义。

---

## 0.1 代码基建核实（2026-06-18，落地前对齐）

本节记录设计稿与当前 diga-agent 代码现实的差异，**以现实为准**。下文设计已据此修订。

| 维度 | 现状（已核实） | 对设计的影响 |
|---|---|---|
| 全局设置存储 | `~/.diga-agent/settings.json` 已是通用 envelope（`SettingsEnvelope` 带 `[key]: unknown`），`communication` 是其中一个字段 | `agentProfiles` 直接加进同一文件，**无需新建存储** |
| Session 元数据 | `SessionMeta`（`lib/meta/types.ts`）是可扩展接口，已有“给后续 Phase 留位”的字段先例 | 加 `profile?` 字段顺理成章 |
| communication | `WorkMode = "coding" \| "daily"`，全局存储，**默认 `coding`**；注入点 `withCommunicationInstructions`（agent route + goal continuation）；**无 session 级** | profile 的 `communication` 轴直接映射；默认必须保持 `coding`（见下） |
| reasoning | **已有 `ThinkingLevel = off\|minimal\|low\|medium\|high\|xhigh`**（`lib/types.ts`），per-provider（`availableThinkingLevels`），默认 `medium` | `reasoning` 轴**复用 `ThinkingLevel`**，不新造枚举 |
| 工具注册 | 自定义工具（delegate/workflow）可加 metadata；但 read/write/edit/bash 是 **SDK 内置**，经 `tools`/`excludeTools` 传入 `createAgentSession`，**无法在注册处加字段** | `toolsets` 过滤用**集中 capability map + excludeTools**，不能依赖统一 metadata |
| sandbox | 当前**无系统级沙盒**，写文件/bash 直接执行 | `sandbox` 轴在 Phase E 前是**软边界**（靠 toolset 过滤 + approval 模拟），UI 需如实说明 |
| 项目级设置 | **当前没有项目级存储层** | Phase A/B 只做「全局默认 + session override」两级，项目级延后 |

### 默认行为不变（硬约束）

现状 communication 默认 `coding`。Phase A 引入 profile 后，**默认 profile 的 communication 轴必须等于现状（coding）**，不能静默把用户切到 daily。因此本文档原先“新用户默认 `daily-research`”的建议**作废**，改为：默认 profile 的协作风格保持 coding，详见 §5.1 修订。

---

## 1. 目标

- 让用户能用一句话切换常见工作形态，例如“日常研究”“代码审查”“自动重构”。
- 让每个 profile 的权限、工具、推理强度可解释、可审计、可覆盖。
- 保留当前 `Communication mode: Daily work` 的方向，但把它降级为 profile 的一条轴，而不是总开关。
- 让展示密度跟工具集和风险等级走，避免“切到日常模式后过程被静默隐藏”。
- 支持将来扩展到项目级默认 profile、会话级 override、单轮临时 override。

## 2. 非目标

- 不在第一阶段重写所有工具审批和沙盒实现。
- 不把 profile 做成模型 provider 绑定关系；同一个 profile 应该能运行在不同模型上。
- 不引入新的全局状态管理库，除非现有 settings/session 状态无法承载。
- 不让“日常模式”默认获得自动执行权限。
- 不把内部 thinking 原文暴露给用户；这里只讨论 reasoning effort 和过程摘要展示。

---

## 3. 设计原则

### 3.1 底层正交，上层打包

Profile 只是命名预设，不是单一模式。每个 profile 都由多条独立轴组成：

```text
profile = communication + approval + sandbox + reasoning + toolsets + display
```

任何一条轴都可以单独修改。比如用户可以使用 `Daily Research` 的沟通风格，但把审批改成 `Ask before writes`。

### 3.2 权限必须显式

权限变化不能藏在“代码模式”“日常模式”这种语义里。只要 profile 会增加写文件、联网、自动执行能力，UI 必须直接显示。

### 3.3 展示可以折叠，但不能静默隐藏

日常工作可以默认折叠工具过程，但必须保留可展开入口，并显示“已折叠 N 步”。代码工作默认展示命令、diff、测试结果。两者都不能让用户失去 debug 入口。

### 3.4 Prompt 负责风格，运行时负责边界

System prompt 可以告诉 agent 当前身份和协作方式，但权限、审批、工具可用性必须由运行时强制执行，不能只靠 prompt 自律。

### 3.5 默认安全，风险递进

默认 profile 应该低风险。高风险 profile 必须有明确命名、状态提示和切换确认，例如 `Yolo Refactor`。

---

## 4. 配置模型

### 4.1 核心类型

```ts
type CommunicationMode = "daily" | "coding";

type ApprovalMode =
  | "always-ask"
  | "on-request"
  | "on-failure"
  | "never";

type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

// 复用现有 lib/types.ts 的 ThinkingLevel，不新造枚举（避免双轨）。
// ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
type ReasoningLevel = ThinkingLevel;

type DisplayDensity =
  | "full"
  | "grouped"
  | "compact";

type ToolsetProfile =
  | "chat"
  | "research"
  | "code-read"
  | "code-write"
  | "workflow"
  | "browser";

interface AgentProfile {
  id: string;
  label: string;
  description: string;
  defaults: {
    communication: CommunicationMode;
    approval: ApprovalMode;
    sandbox: SandboxMode;
    reasoning: ReasoningLevel;
    display: DisplayDensity;
    toolsets: ToolsetProfile[];
  };
  risk: "low" | "medium" | "high";
  builtIn: boolean;
}
```

### 4.2 轴含义

| 轴 | 作用 | 运行时责任 |
|---|---|---|
| `communication` | 决定 agent 的表达方式和协作身份 | prompt aside / system prompt |
| `approval` | 决定工具调用前是否需要用户确认 | tool executor / approval gate |
| `sandbox` | 决定文件系统和命令权限边界 | shell/runtime sandbox |
| `reasoning` | 决定模型请求的推理预算 | model request config |
| `display` | 决定工具过程如何展示 | message/process renderer |
| `toolsets` | 决定可用工具族 | tool registry / tool filter |

### 4.3 配置优先级

从低到高：

1. App 默认 profile。
2. 项目级默认 profile。
3. 会话级 profile。
4. 单轮 composer 临时 override。
5. 运行时安全策略强制降级。

安全策略只能降级，不能静默升权。例如项目策略是 `read-only`，用户选择 `Code Edit` 时应显示“该项目限制写入，已降级为只读”。

---

## 5. 内置 Profiles

| Profile | 用户承诺 | communication | approval | sandbox | reasoning | display | toolsets | risk |
|---|---|---|---|---|---|---|---|---|
| `quick-chat` | 快速问答，不主动改环境 | daily | always-ask | read-only | low | compact | chat | low |
| `daily-research` | 检索、整理、归纳，过程可展开 | daily | on-request | read-only | medium | grouped | chat, research, browser | low |
| `code-review` | 读代码、找风险、给建议 | coding | always-ask | read-only | high | full | code-read, research | low |
| `code-edit` | 可修改工作区并验证 | coding | on-request | workspace-write | high | full | code-read, code-write, workflow | medium |
| `workflow-planner` | 拆任务、生成计划、少执行 | daily | always-ask | read-only | high | grouped | chat, research, workflow | low |
| `yolo-refactor` | 在可回滚环境中自动推进 | coding | never | workspace-write | high | full | code-read, code-write, workflow, browser | high |

### 5.1 默认推荐（已据现状修订）

**默认 profile 的协作风格必须保持现状 `coding`**，不能在引入 profile 时静默把存量用户切到 daily（见 §0.1 硬约束）。

因此默认 profile 取 `code-review`（communication=coding、read-only、不默认写文件）作为安全且零行为变更的起点：

- communication 与现状一致（coding），存量用户体感不变。
- read-only，不会默认写文件。
- 仍可一键切到 `daily-research` 获得日常风格 + 分组折叠。

> 备注：是否将来把新用户首启默认改为 `daily-research`，作为**独立的产品决策**，不在 Phase A 内做——Phase A 只保证“引入 profile 抽象但默认行为不变”。

开发者项目可以把项目默认 profile 设置为 `code-edit`，但第一次启用时需要解释写入范围和审批策略（项目级存储在 Phase A/B 不实现，延后）。

### 5.2 高风险 Profile 规则

`yolo-refactor` 必须满足：

- 只在高级设置或命令面板中出现，不放在新手首屏。
- 启用前显示确认文案。
- 顶部状态栏持续显示 `Auto approval` 和 `Workspace write`。
- 所有命令、diff、测试结果必须全量保留在会话历史中。

---

## 6. UI 设计

### 6.1 Composer Profile Chip

Composer 附近新增 profile chip，显示当前会话 profile：

```text
[Daily Research v]  [Model]  [Reasoning]
```

点击后打开 profile menu：

- 上半区：内置 profiles。
- 下半区：当前 profile 的轴摘要。
- 高级入口：`Customize axes...`。

切换 profile 默认影响下一轮消息。若当前有运行中的任务，切换只更新“下一轮使用”，避免中途改变工具权限。

### 6.2 Settings 页面

Settings 增加 `Agent Profiles` 区域：

- `Default profile`：全局默认。
- `Project default`：当前项目默认。
- `Profiles`：展示内置和用户自定义 profiles。
- `Advanced axes`：允许用户单独调 approval、sandbox、reasoning、display、toolsets。

内置 profile 不允许直接编辑，只允许复制为自定义 profile。

### 6.3 状态提示

顶部或 composer 附近必须可见三类状态：

| 状态 | 显示条件 | 示例 |
|---|---|---|
| 权限 | `sandbox !== read-only` | `Workspace write` |
| 审批 | `approval === never` | `Auto approval` |
| 展示 | `display !== full` 且有工具折叠 | `3 steps folded` |

这些状态不是装饰信息，而是用户判断风险的入口。点击状态应能打开详细配置或过程面板。

### 6.4 过程展示

| display | 行为 |
|---|---|
| `full` | 命令、搜索、diff、测试、工具输出按时间线展示，可折叠长输出 |
| `grouped` | 同类工具调用聚合为进度组，显示“已处理 N 步”，可展开 |
| `compact` | 默认只显示摘要和关键结果，但保留“查看 N 步过程” |

失败事件不能被 compact 完全隐藏。失败至少显示工具名、失败原因、可恢复动作。

---

## 7. 运行时落地

### 7.1 Prompt Assembly

Prompt 只接收 profile 的协作语义：

- `communication = daily`：强调先给结论、少术语、技术细节按需展开。
- `communication = coding`：强调先读代码、保持小步修改、验证、说明 diff。
- `reasoning = high`：鼓励先列计划、处理不确定性、分阶段验证。

Prompt 不负责授权。例如不能只靠 prompt 写“不要写文件”。写入权限必须在工具层拦截。

### 7.2 Tool Registry

工具注册时带 metadata：

```ts
interface ToolCapability {
  id: string;
  toolset: ToolsetProfile;
  risk: "read" | "write" | "network" | "execute" | "destructive";
  requiresApproval?: boolean;
}
```

每次构建可用工具列表时：

1. 根据 profile 的 `toolsets` 过滤工具族。
2. 根据 `sandbox` 过滤写入、执行、网络能力。
3. 根据 `approval` 决定工具调用前是否暂停。
4. 根据运行时安全策略做最终强制降级。

### 7.3 Approval Gate

审批策略建议映射：

| approval | 行为 |
|---|---|
| `always-ask` | 所有写入、执行、联网工具都问 |
| `on-request` | 低风险读取不问；模型请求高风险工具时问 |
| `on-failure` | 先在安全边界内尝试；失败后再请求提升 |
| `never` | 不弹审批，但仍受 sandbox 限制 |

`never` 不等于 `danger-full-access`。它只代表不打断用户，不代表突破沙盒。

### 7.4 Sandbox Enforcement

Sandbox 是运行时边界：

- `read-only`：只允许读取工作区和安全元数据。
- `workspace-write`：允许写工作区，禁止默认写工作区外路径。
- `danger-full-access`：仅用于本地可信环境，必须强提示。

如果底层平台无法提供完整沙盒，也要在 UI 中明确说明“未启用系统级沙盒，仅使用工具级限制”。

### 7.5 Display Renderer

Renderer 根据 `display` 决定 process/event 的归并方式，但事件流本身必须完整保留：

```text
event log: full fidelity
renderer: full/grouped/compact projection
```

这样 UI 可以清爽，审计和 debug 仍然完整。

---

## 8. 数据结构与持久化

### 8.1 Settings

加进现有 `~/.diga-agent/settings.json` 这个通用 envelope（与 `communication` 字段同级），不新建文件：

```json
{
  "communication": { "workMode": "coding" },
  "agentProfiles": {
    "defaultProfileId": "code-review",
    "customProfiles": []
  }
}
```

`defaultProfileId` 默认取 communication=coding 的 profile（见 §5.1），保证默认行为不变。

### 8.2 Session Metadata

```json
{
  "profile": {
    "id": "code-edit",
    "axes": {
      "communication": "coding",
      "approval": "on-request",
      "sandbox": "workspace-write",
      "reasoning": "high",
      "display": "full",
      "toolsets": ["code-read", "code-write", "workflow"]
    }
  }
}
```

每条 assistant turn 应记录当时生效的 profile snapshot，避免后续用户切 profile 后历史解释不清。

### 8.3 Fork / edit-from-here 的 profile 归属

fork（含 edit-from-here）从某条历史 turn 截断后继续时，**新分支继承被 fork 的那条 turn 的 profile snapshot**，而不是当前会话 profile。

理由：fork 的语义是“从那个点重来”，应保持那一刻的协作风格 / 权限 / 推理强度一致。否则会出现“用 code-edit 跑出来的历史，fork 后却用 daily 重跑”的语义错乱。用户若想换 profile，可在 fork 后显式切换（影响其后的下一轮，符合 §6.1 “切换只影响下一轮”）。

实现要点：fork 时读取目标 turn 的 snapshot 写入新分支的 session profile；目标 turn 无 snapshot（历史旧数据）时回退到会话当前 profile。

---

## 9. 迁移方案

### Phase A: 文档和配置模型

**目标**：先落类型和文档，不改变用户行为。

**工作**

- 新增本方案文档。
- 新增 profile/axes 类型定义。
- 将当前 `Communication mode: Daily work` 映射为 `communication = daily`。

**验收**

- 默认行为不变。
- 历史 session 能正常打开。

### Phase B: Profile 只读展示

**目标**：让用户知道当前 profile 背后的轴。

**工作**

- Composer 显示当前 profile chip。
- Settings 展示只读 profile 列表。
- 状态栏显示 approval/sandbox/reasoning 摘要。

**验收**

- 用户能看到“当前为什么能/不能写文件”。
- 切换 UI 还不真正改变权限，避免一次性引入太多行为变化。

### Phase C: Profile 驱动 Prompt 与 Display

**目标**：先落低风险轴。

**工作**

- `communication` 驱动 prompt aside。
- `reasoning` 驱动模型请求参数。
- `display` 驱动过程分组和折叠。

**验收**

- `Daily Research` 的工具过程会分组折叠并显示数量。
- `Code Review` 会保留全量过程展示。

### Phase D: Profile 驱动 Toolset 与 Approval

**目标**：让 profile 真正影响工具可用性和审批。

**工作**

- 为工具补 metadata。
- 按 `toolsets` 过滤工具列表。
- 按 `approval` 接入审批 gate。

**验收**

- `code-review` 无法直接调用写文件工具。
- `code-edit` 调写文件工具会按策略触发审批。
- `never` 不弹审批，但仍受 sandbox 限制。

### Phase E: Sandbox 与高级 Profiles

**目标**：支持高风险自动化场景。

**工作**

- 接入系统级或工具级 sandbox enforcement。
- 开放 `yolo-refactor`。
- 增加高风险确认和审计记录。

**验收**

- 启用高风险 profile 前有明确确认。
- 会话历史能追溯每次工具调用时的 profile/axes。

---

## 10. 验收标准

1. 用户能在 UI 中查看当前 profile 对应的所有轴。
2. 切换“日常 / 代码”表达风格不会静默改变写入权限。
3. 所有写入、执行、联网能力都能从 profile axes 推导出来。
4. 折叠工具过程时必须显示折叠数量，并能展开。
5. 失败工具调用在 `compact` 模式下仍可见。
6. 每个 assistant turn 都保存 profile snapshot。
7. 高风险 profile 有持续状态提示和启用确认。
8. 旧 session、旧设置、当前 daily work 逻辑能平滑迁移。

---

## 11. 测试计划

### Unit

- Profile schema 默认值和自定义覆盖。
- Profile 到 axes 的解析。
- Tool metadata 过滤。
- Approval policy 判断。
- Display renderer 的 full/grouped/compact 投影。

### Integration

- 从 `daily-research` 切到 `code-review`，下一轮生效。
- `code-review` 下写文件工具不可见或被拒绝。
- `code-edit` 下写文件工具触发审批。
- `compact` 下失败工具调用仍展示。

### E2E

- 新用户首次打开使用默认 `daily-research`。
- 在 composer 切换 profile 后发送消息，历史中记录 snapshot。
- 开启 `yolo-refactor` 看到确认和持续风险提示。
- 折叠的工具组可展开，展开后能看到完整步骤。

---

## 12. 风险与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| Profile 语义漂移 | 用户不知道切换后到底变了什么 | Profile menu 永远展示 axes 摘要 |
| 权限被 prompt 化 | 模型自觉遵守失败 | 工具层和 runtime 强制执行 |
| 日常模式静默隐藏过程 | 出错无法 debug | 折叠必须显示数量和展开入口 |
| 高风险 profile 误触 | 用户无感知进入自动执行 | 高风险确认 + 持续状态 badge |
| 自定义 profile 过多 | 设置页变复杂 | 先只支持复制内置 profile，再开放编辑 |

---

## 13. 开放问题

已据 §0.1 核实解决的：

1. ~~项目级 settings 存储~~ → **已答**：当前无项目级存储层。Phase A/B 只做全局默认 + session override，项目级延后。
2. ~~reasoning 是否 provider 统一抽象~~ → **已答**：复用现有 `ThinkingLevel`（已是 per-provider 抽象，带 `availableThinkingLevels`），不另造映射。
4. ~~tool metadata 定义位置~~ → **已答**：集中维护一张 capability map（SDK 内置工具无法在注册处加字段），过滤经 `excludeTools` 落地。

仍开放：

3. Electron 和 Web 环境的 sandbox / browser 能力不一致（web 是 iframe、electron 是 webview），`sandbox` / `browser` 相关轴 UI 需显示平台差异——具体展示形态待定。
5. `display = compact` 是否允许用户设为全局默认，还是只给日常 profile 使用？（倾向：仅日常 profile 可用 compact，全局默认不给 compact，避免新用户失去 debug 入口。）
6. sandbox 轴在 Phase E 前是软边界（toolset+approval 模拟），是否需要在该阶段 UI 明确“未启用系统级沙盒”，还是等真沙盒就绪再暴露该轴？

---

## 14. 推荐下一步

先做 Phase A + Phase B：

1. 新增 profile/axes 类型和内置 profile 常量。
2. 把当前 `Communication mode: Daily work` 映射为 profile 的 `communication` 轴。
3. Composer 显示只读 profile chip。
4. Settings 展示 profile 背后的 axes。

这一步能把产品心智先立住，同时不改变工具执行行为，回归风险最低。
