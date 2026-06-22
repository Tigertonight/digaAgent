# Agent Team Final Mile

日期：2026-06-22 PM
状态：Ready to implement
关联文档：
- 上一版方案：`docs/plans/2026-06-22-agent-team-delivery-plan.md`（Phase A–F 已完成 4/6）
- 审计基线：`docs/audit/agent-team-maturity-audit-2026-06-21.md`

## 0. TL;DR

Agent Team 已经从 scaffold 走到 candidate：coordination tools / worktree / hydrate /
planner 在源码上接通、73 个 vitest 全绿。

剩下的 **不是"实现"问题，是"证明 + 可见"问题**：

1. coordination 端到端从未在 integration test 真跑过。
2. coordinationAudit 数据已收集，UI 不展示。
3. hydrate / replace_member 数据已收集，Workspace 顶部没有 banner，
   用户重启后看不到"N 位 teammate 需要 Resume / Replace"。

本 plan 把这三件事打成一个轻量交付包，目标 **2 人日内完成**，完成后即可去掉 Beta 标签。

## 1. 当前位置（先校准一下）

### 1.1 代码实测（2026-06-22）

| 能力 | 位置 | 状态 |
|---|---|---|
| 8 个 `team_*` 工具 | `lib/agent-team/coordination-tools.ts` | ✅ 全集 |
| Bridge（identity / rate-limit / audit / role gating） | `lib/agent-team/coordination-bridge.ts` | ✅ 完整 |
| Coordination extension 注入 child agent | `lib/agent-registry.ts:2024` | ✅ 已挂 |
| `before_agent_start` 注入 prompt contract | 同上 | ✅ |
| `coordinationAudit` 数据累积 | `server-store.ts:354`、`types.ts:388` | ✅ 但 UI 未展示 |
| Worktree create / merge / cleanup | `worktree-policy.ts` 402 行 | ✅ |
| Hydrate 四状态 + Resume API | `hydrate.ts` + `route.ts:348` | ✅ 但 UI 无 banner |
| Replace member API + 按钮 | `route.ts:839` + `WorkbenchSidebar.tsx:1320` | ✅ 已串通，但只在 status=blocked 行内 |
| Planner v2（6 tag） | `planner.ts` | ✅ |
| E2E spec | `e2e/10-agent-team.spec.ts` + `10b-...worktree.spec.ts` | ⚠️ mock route，未驱动 child agent |
| Coordination Integration Test | 不存在 | ❌ 需补 |
| Coordination Audit 抽屉 / 面板 | 不存在 | ❌ 需补 |
| Hydrate banner （Workspace 顶部提示） | 不存在 | ❌ 需补 |

测试：`vitest run lib/agent-team/` → 8 files / 73 tests 全绿。

### 1.2 本 plan 不再处理的项

以下在《2026-06-22 delivery plan》中已明确保留为 P2 或后续，本 plan 也不动：

- TaskCreated hook 真实评估 / 用户自定义 hooks。
- LLM-based planner。
- Split panes / 多 teammate transcript 并排。
- Nested teams、跨 session team 共享。
- 重写现有 mock-route E2E（UI 状态机已被 10/10b 覆盖，integration test 补的是 child-agent 闭环，维度不同）。

## 2. Final Mile 三件事

| # | 名称 | 交付品 | 估计 |
|---|---|---|---|
| 1 | Coordination Integration Test | `lib/agent-team/coordination-integration.test.ts` | 0.5 人日 |
| 2 | Coordination Audit Drawer | `WorkbenchSidebar.tsx` 抽屉 + types 补 上报路径 | 0.5 人日 |
| 3 | Hydrate Banner + Replace 串通 | `WorkbenchSidebar.tsx` 顶部 banner + missing 行 Replace | 0.5 人日 |

总计 1.5 人日。按 1 → 2 → 3 顺序推进。Item 1 是交付信仰的唯一 P0，优先补。

## 3. Item 1：Coordination Integration Test

### 3.1 目标

证明 **child agent 调用 `team_*` 工具 → bridge 反查 → server-store mutation → board update** 这条端到端链路在生产路径上是通的。

这是交付信仰的唯一 P0。现有 73 个 vitest 覆盖 server-store 和 bridge 各自的单元逻辑，但「注入到 child agent 的 tool 被调用后访问同一个 server-store」这个接合点未被任何测试验证。

### 3.2 文件位置

`lib/agent-team/coordination-integration.test.ts`

不作为跳出 /api E2E，避免依赖 Next.js dev server。使用 vitest + 真 `createAgent`（现有 `lib/agent-registry.ts`）+ test fixture provider。

### 3.3 测试形态

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent, disposeAgent } from "@/lib/agent-registry";
import {
  putAgentTeamRun,
  getAgentTeamRun,
  setAgentTeamStoreRootForTests,
} from "@/lib/agent-team/server-store";
import { createInitialAgentTeamRun } from "@/lib/agent-team/mock";
import { __clearAgentTeamCoordinationRateLimitsForTest } from "@/lib/agent-team/coordination-bridge";
```

核心流程：

1. mkdtemp 创建隔离 store root，`setAgentTeamStoreRootForTests`。
2. 造一个 `parentRec`（可复用现有 fixture provider 或 mock provider），拿 `parentAgentId`。
3. `putAgentTeamRun(createInitialAgentTeamRun("integ", { coordinationProfile: "basic", allowChallenges: true }))`。手动补 `member.agentId = childRec.id` 让 bridge 能反查。
4. `createAgent({ parentAgentId, hidden: true, ... })` 拿一个 `childRec`，让 coordination extension 被装载。
5. 从 `childRec.session.agent.tools` 的 registry 中拿出 `team_get_board / team_claim_task / team_submit_result / team_create_challenge`。不需要走模型，直接调用 `tool.execute(toolCallId, params)` 验证 bridge 闭环。
6. 验证 board 上出现 finding / challenge / claimed task，以及 `coordinationAudit` 累积。

注：“从 tool registry 拿工具”是该测试的关键点，这能证明 `lib/agent-registry.ts:2024` 实际上装上了这些 tool。现有的 `coordination-tools.test.ts` 只调 `createAgentTeamCoordinationTools()` 手建集合，跳过了注入路径。

### 3.4 断言要点

至少三个 `it`：

1. **Tool 被注入 child agent**：`childRec.session.agent.tools.find(t => t.name === "team_get_board")` 不为空；8 个工具名全在。
2. **claim → submit_result 闭环**：依次调 `team_claim_task` / `team_submit_result`（带一个有效 TEAM_RESULT_JSON），board 上 `task.ownerAgentId` 出现且 `findings.length > 0`；`coordinationAudit` 出现两条 outcome=ok。
3. **身份拒绝**：拿另一个不在 run 里的 child agent，调 `team_get_board`，返回 `ok=false` 且 error 包含 "not found"；board 不变。

可选第四个测例（如果颗颂）：

4. **rate-limit**：同一 child 连发 6 次 `team_get_board`，后一次返 `coordination rate-limited`；`coordinationAudit` 出现 `outcome=rejected`。

### 3.5 验收

- `npx vitest run lib/agent-team/coordination-integration.test.ts` 连跑 5 次不闪败。
- typecheck 绿。
- 现有 73 个 vitest 仍然绿。
- 考虑在 CI 的 `quality` workflow 里不需要额外接入——能被现有 `npm test` 覆盖。

## 4. Item 2：Coordination Audit Drawer

### 4.1 数据来源

`run.coordinationAudit: AgentTeamCoordinationCall[]` 已在 server-store 累积到最多 200 条（`server-store.ts:354`）。每条含：

```ts
{
  id: string;
  at: number;
  memberId: string;
  toolName: string;
  args: Record<string, unknown>;
  outcome: "ok" | "rejected";
  rejectionReason?: string;
}
```

Team SSE 事件在 audit 写入后已推送 `agent_team_run_update`，前端只需从当前 run 读。

### 4.2 UI 位置

`app/components/WorkbenchSidebar.tsx`。在 “File Locks” 和 “Quality Gates” 之间插一个默认折叠的 Section：“Coordination Audit (近 N)”。

折叠状态控制复用附近已有的 `useState<boolean>(false)` 模式。

### 4.3 行为细节

表格列（中英混排，跟随其他 section 风格）：

| 时间 | Member | Tool | 状态 | 信息 |
|---|---|---|---|---|
| `format(at, "HH:mm:ss")` | `member.name`（fallback 到 memberId） | `toolName.replace(/^team_/, "")` | `outcome=ok` → ✅ / `rejected` → ⚠️ | `rejectionReason \|\| (args.taskId \|\| "—")` |

限制：

- 只显最近 50 条（`coordinationAudit.slice(-50).reverse()`）。
- 空状态文案：“还没有 teammate 调用过协作工具。启用后会在这里实时展示。”
- args 只采样 1–2 个关键字段（`taskId` / `targetFindingId` / `body` 前 60 字）。完整原始不展，bridge 已裁剪到 300。
- header 右侧加一个计数徽标：近 5 分钟调用次数，用 `at >= now - 5*60_000` 过滤。

### 4.4 额外信号 Surfacing（可选）

Team run card 可以在 “查看过程” 按钮右边加一个微型计数器：近 5 分钟 Coordination calls，让用户在不打开 Workspace 时也能看到「teammate 真在自主跑」。如果体量超过 0.5 人日则推后。

### 4.5 验收

- 手动：启一个 `coordinationProfile=basic` 的 standard team，prompt teammate 走一轮 claim+submit，抽屉中出现至少 2 条。
- 单测：`WorkbenchSidebar.test.ts` 补一个用例——传入带 5 条 audit 的 run，抽屉展开后出现 5 行。
- E2E：在现有 `e2e/10-agent-team.spec.ts` 里布局加一条断言——mock 里如有 audit 则 drawer toggle 后可见。不单开一个 spec。

## 5. Item 3：Hydrate Banner + Replace 串通

### 5.1 数据来源

```ts
run.hydrate?: {
  lastHydratedAt: number;
  rehydratedMemberIds: string[];
  missingMemberIds: string[];   // missing + replaced 合并
  notes?: string;
};
```

+ 每个 member 上的 `hydrateState ?: "intact" | "rehydrated" | "missing" | "replaced"`（`hydrate.ts` 已写）。

### 5.2 UI 位置

**Workspace 顶部 banner**：`WorkbenchSidebar.tsx` 中 Team Workspace 表头下、Board 之上插入。

**二级 surfacing**：Team run card（`MessageView.tsx`）加一个警示 chip：`⚠️ N 名 teammate 待恢复`，点击走 Open Workspace。

### 5.3 行为细节

#### 5.3.1 Banner 出现条件

```ts
const pending = run.hydrate?.missingMemberIds ?? [];
const hasPending =
  pending.length > 0 ||
  run.members.some((m) => m.hydrateState === "missing" || m.hydrateState === "replaced");
```

#### 5.3.2 Banner 形态

- 颜色：警告色（`var(--color-warning)` 边框）。
- 文案：「重启后还有 N 位 teammate 会话需要恢复或替换。」
- 右边两个按钮：
  - 「一键恢复」 → `onCommand(run.id, { type: "resume" })`。这个 action 在 chat 卡上已存在，需要在 `onCommand` 处理器中接受。
  - 「查看详情」 → 滚动到 Members section 并高亮 missing 行。
- `hydrate.notes` 如有，在二行默认 truncated 到 80 字。

#### 5.3.3 Members section 中的 missing 行

当前 Replace 按钮只在 `member.status === "blocked"` 时出现（`WorkbenchSidebar.tsx:1320`）。需要改为：

```ts
const missingHydrate =
  member.hydrateState === "missing" || member.hydrateState === "replaced";
const showReplace =
  member.status === "blocked" || missingHydrate;
```

missing 状态下额外多一个 `会话丢失` 徽标，随 Replace 按钮同行展示；hover tooltip = `member.latestOutput`（hydrate 已写入原因）。

#### 5.3.4 默认 hydrate 不重建的说明

`route.ts` 中 hydrate 有两个形态：

- 启动时 hydrate（`recreateIdleTeammates=false`）→ 打报告、team 仍 paused。
- 用户点 Resume 后 hydrate（`recreateIdleTeammates=true`）→ 实际建 session。

banner 里的 「一键恢复」走后者。如果重建后仍有 missing（replaced），banner 不隐，文案改为 「还有 N 名 teammate 需你手动替换」。

### 5.4 验收

- 单测：`WorkbenchSidebar.test.ts` 新增 2 个用例：
  1. 传入 `hydrate.missingMemberIds=["m1"]` + member 带 hydrateState=missing → banner 可见，Replace 按钮出现。
  2. 传入 空 hydrate → banner 不可见。
- E2E：`e2e/10-agent-team.spec.ts` 加一个场景——mock 返回带 missing 的 run，验证 banner 文案 + Resume 按钮可点。
- 手动：启一个 team 跑几步 → `kill -9 next dev` 重启 → reload 页面，验证 banner 出现，点 Resume 后 teammate hydrateState=rehydrated、banner 隐藏。

## 6. 总体 Definition of Done

交付处需同时满足：

1. `lib/agent-team/coordination-integration.test.ts` 有 ≥ 3 个 passing it：包含 tool 注入检查、claim+submit 闭环、跨身份拒绝。
2. `vitest run lib/agent-team/` 从 73 tests 涨到 ≥ 76 tests，全绿。
3. Workspace 抽屉可见「Coordination Audit」，折叠后面列 ≤ 50 条。
4. Workspace 顶部 banner 在 missingMemberIds.length>0 时出现；一键恢复 调 resume action。
5. Members section 上 missing/replaced 状态的行都能点 Replace。
6. 实手跑一轮 standard team，抽屉中能看到至少 2 条 audit 记录。
7. typecheck 绿，`npm test` 全绿，`e2e/10-agent-team.spec.ts` 本地连跑 3 次不闪。
8. 审计报告 `docs/audit/agent-team-maturity-audit-2026-06-21.md` 补一段「2026-06-22 后续”小小，记录三项补齐、总评提到 7.5+ / 10，可去掉 Beta 标。

## 7. 实施顺序与时间盒

| 顺序 | 任务 | 时间盒 | 中间检查点 |
|---|---|---|---|
| 1 | Item 1：Integration test 骨架 + tool 注入断言 | 0.25 人日 | 能从 child registry 拿到 8 个 tool |
| 2 | Item 1：claim+submit + identity 拒绝 | 0.25 人日 | board 上 finding 出现，audit 出现两条 |
| 3 | Item 2：audit drawer + 单测 | 0.5 人日 | drawer 手动可见；sidebar test 补一个用例 |
| 4 | Item 3：banner + Replace 串通 + 单测 | 0.5 人日 | reload 场景上 banner 出现，点 Resume 后隐 |
| 5 | E2E spec 微调 + 审计报告补一段 | 0.25 人日 | `e2e/10-agent-team.spec.ts` 提 1 个 banner / drawer 存在性断言 |

合计 ≈ 1.75 人日。中间不需要跨人交接，可一个人走完。

### 7.1 代码中的 anchor 点

- `lib/agent-registry.ts:2024` 是 coordination extension 注入点，Integration test 不需要动。
- `lib/agent-team/coordination-bridge.ts` 导出的 `__clearAgentTeamCoordinationRateLimitsForTest` 要在 beforeEach 调。
- `app/components/WorkbenchSidebar.tsx` Members section 起点在现有 `members.map(...)` 附近；MessageView Team card 在 `MessageView.tsx:2510` 附近。
- `lib/agent-team/server-store.ts:354` 是 audit 追加点，不需要修改。

## 8. 不做的事

这些项不在本 plan，避免 scope creep：

- 写一个跨进程的 fixture provider。现有 `coordination-tools.test.ts` + integration test 足以证明闭环。
- 重构 `route.ts` 拆分 actions / dispatcher（上版 plan 提过，但与交付信仰无关，可后续独立重构）。
- coordinationAudit 的高级过滤 / 搜索 / 导出。首版只要可见。
- 颜色主题、Workspace 信息架构重设。
- 调整启动确认面板文案。如果三项补齐后发现面板与实际不一致，另开 issue。
- LLM planner / TaskCreated hook / split panes。均保留 P2。

## 9. 变更后的语言升级建议

完成后，`README.md` / `docs/product-language.md` / `docs/audit/...` 中的描述字口可以从：

> Agent Team 是技术预览 / Beta。

改为：

> Agent Team 已支持 teammate 自主协作、受控写入隔离、重启恢复与可追溯决策。

这句话是 Definition of Done #8 的软验收语句，不要提前改。
