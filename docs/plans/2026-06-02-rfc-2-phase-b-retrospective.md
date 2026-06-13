# RFC-2 Phase B：工具审批架构改造执行回顾

> **状态**：✅ 已完成（2026-06-02）
> **作者**：Diga Agent 团队（含 AI 辅助）
> **创建**：2026-06-02
> **完成**：2026-06-02（当日）
> **实际工期**：约半天（vs 预估 3.5–4 人天）
> **关联**：[RFC-2 Phase B 计划](./2026-06-02-rfc-2-phase-b.md) ｜ [RFC-2 主文](./2026-06-02-rfc-2-agent-collaboration.md) §4 Phase B
> **commits**：`e322086` → `eb72286`（共 4 个）

---

## 0. TL;DR

让用户敢把 agent 放手跑危险工具：在 `rm -rf` / `git reset --hard` 等高危命令真正执行前，chat 流出现内联审批气泡，可 allow / deny + 「本会话不再问」+ 5 分钟自动按 defaultDecision 兜底；全程 0 行为退化、0 lint 漂移。

**实际成果**：

| 指标 | Before (Phase A 完成时) | After | Δ |
|---|---|---|---|
| 新增 lib 代码 | — | `lib/collab/` 共 ~600 行（含 25 单测） | +600 |
| 新增组件 | — | ApprovalBubble + CollabSettings(2) | +3 |
| SDK 接缝 | 0 用 extension | DefaultResourceLoader 注入 CollabExtension | +1 |
| API 路由 | — | `/api/agent/[id]/approval` (POST) | +1 |
| SSE 事件类型 | 内置 | 扩 RingBufferEvent union: `+approval_request` `+approval_resolved` | +2 |
| 单测 cases | 65 | **96（+31：16 matcher + 9 settings + 6 reducer）** | +31 |
| e2e | 6/6 ✓ | 6/6 ✓ | 持平 |
| lint warnings | 91 | **91** | 持平 |
| lint errors | 20 | **20** | 持平 |
| TS 严格通过 | ✓ | ✓ | 持平 |
| build | ✓ | ✓（含 approval 路由）| 持平 |

**关键判断**：Phase B 走"先架构后能力"的两轮接入。B1（架构改造，no-op 注入）+ B2（matcher + stub onApprovalNeeded）跑通最危险的接缝，验证 SDK 行为完全符合预期；B3 才接 UI + 真审批通道；B4 加超时 + remember + Settings 开关。这种节奏的好处是 B1/B2 各自的回归面极小（B1 行为完全不变、B2 只在命中规则时改变行为），任何回归都精确定位到当次 commit。

**未做（留给 Phase C / 后续）**：

- 意图预览（F3：让 agent 先口头说要做什么，再真执行）
- deny 的 session remember（避免危险的"自动 deny"语义）
- edit 路径（修改命令后允许执行）
- 全局规则持久化到 `~/.pi/agent/approval-rules.json`（v0 内置 1 条规则即够）
- Settings 里编辑/新增 / 删除自定义规则的 UI（v0 仅总开关）
- pet 形态弹窗 + 智能体头像（Phase C 体验提升）

---

## 1. 背景：为什么 Phase B 选 Approval

### 1.1 RFC-2 Phase B 在 RFC 主文中的定位

RFC-2 主文 §4 把 Phase B 定义为**"多 agent 协作 + 共享 context"**。在 Phase A 完成后，实际推进 Phase B 时做了一次范围重定向：

| RFC 主文原 Phase B | 实际 Phase B | 原因 |
|---|---|---|
| 多 agent 协作面板 | 工具审批 | 用户最强痛点是 Phase A 已经能放手 30 轮、但**仍不敢让 agent 自动跑 `rm -rf`**——budget 防的是"烧钱"，approval 防的是"删错文件" |
| 共享 context store | 留给 RFC-3 | 共享 context 强依赖 session 元数据系统，与 RFC-3 重叠 |

→ **审批比多 agent 协作更紧迫**，且独立可发布（不依赖 RFC-3），是 Phase B 的天然首选。

### 1.2 用户决策

经过架构讨论，用户拍板：

- 按"先架构后能力"的 4 子阶段推进（B1 接缝 → B2 stub → B3 真通道 → B4 polish）
- 不切碎成多个 PR，连续推进，每子阶段独立 commit
- v0 内置 1 条规则（`rm -rf` 等），不实现全局规则编辑 UI
- 不实现 edit 路径，allow / deny 二选一（edit 是 RFC §6 但 v0 价值有限）

执行约定（继承 Phase A 形成的工作流）：

- 不再每步等确认，连续推进
- 每个阶段必须 `tsc + lint(91 warn 持平) + vitest + build + e2e 6/6` 全绿才 commit
- commit message 含中文 → `git commit -F /tmp/commit-msg.txt`
- 抽出/新增代码必须读源码确认类型签名，不凭印象

---

## 2. Phase B：4 阶段执行回顾

### 2.1 阶段成果一览

| 阶段 | commit | 新增文件 | 修改文件 | 关键产物 |
|---|---|---|---|---|
| B1 | `e322086` | — | `lib/agent-registry.ts` | DefaultResourceLoader 注入 no-op CollabExtension |
| B2 | `c0a9340` | `lib/collab/{extension,matcher,rules,matcher.test}.ts` | `lib/agent-registry.ts` | matcher + DEFAULT_RULES + stub onApprovalNeeded |
| B3 | `2ca1047` | `lib/collab/server-store.ts` + `app/api/agent/[id]/approval/route.ts` + `app/components/ApprovalBubble.tsx` + `app/hooks/useApprovals.ts` | reducer + types + useAgentEvents + MessageView / Scroll / ChatApp | 真审批通道 + 内联气泡 + 5min 超时 |
| B4 | `eb72286` | `lib/collab/settings.ts` + `settings.test.ts` + `CollabSettingsSection{,Inner}.tsx` | server-store + extension + approval route + bubble + agent-registry + useAgentEvents + ChatApp + SettingsPanel | session remember + 全局总开关 |

### 2.2 阶段 B1：架构接缝（no-op CollabExtension）

**目标**：把 SDK 的 ExtensionFactory 注入接缝跑通，全程行为不变（agent 跑得跟以前一样）。

**产物**：

- `lib/agent-registry.ts` 改造（仅 +几行）：
  - `createAgentSession(...)` 加 `resourceLoader: new DefaultResourceLoader({ extensionFactories: [() => createCollabExtension(...)] })`
  - 临时 `createCollabExtension` 内嵌返回 no-op `{ on: () => {} }`

**关键设计决定**：

| 决策 | 理由 |
|---|---|
| B1 不抽 lib/collab，直接内嵌 no-op | B1 价值是验证"SDK 注入接缝能跑"，过早抽 lib 是空架子 |
| 不动 RingBufferEvent union | B1 行为完全不变，0 事件改动 = 0 SSE 路径改动 = 0 前端改动 |
| extension 用 inline factory（每个 session 1 个 instance）| RFC §3 的明确选型：session-scoped 隔离，避免多 session 串状态 |

**门禁**：tsc ✅ / lint 91w 20e ✅ / vitest 65/65 ✅ / build ✅ / e2e 6/6 ✅

#### 踩坑

第一版尝试用 module-level singleton extension，被 SDK 类型系统挡掉了：`ExtensionFactory` 签名是 `(api) => Extension`，每次 session 创建会调一次，必须返回新 instance（避免 api binding 串）。读 SDK 源码确认后改成 factory 内 new。

---

### 2.3 阶段 B2：matcher + DEFAULT_RULES + stub onApprovalNeeded

**目标**：把"命中规则"的判定层做完，但 onApprovalNeeded 仍是 stub（默认 allow），仍不改变实际行为。

**产物**：

- `lib/collab/extension.ts`（~80 行）：
  - `ToolPolicyOptions { rules, onApprovalNeeded, defaultDecision, ... }`
  - `createCollabExtension(opts)` 返回 `Extension`
  - `on("tool_call", async (ev) => { const rule = matchRule(ev, opts.rules); if (rule) await opts.onApprovalNeeded(...); })`
  - try/catch 兜底（R6），extension 抛错时默认 allow（不拦正常 agent 流程）
- `lib/collab/matcher.ts`（~60 行）：
  - `matchRule(event, rules)` 纯函数
  - 规则字段：`{ id, toolName?, argMatcher?: (input) => boolean, decision?, reason? }`
- `lib/collab/rules.ts`（~30 行）：
  - `DEFAULT_RULES`：1 条 Bash 命令匹配 `rm -rf` / `git reset --hard` / `mkfs` / `:(){:|:&};:`（fork bomb）
- `lib/collab/matcher.test.ts`（16 cases）：覆盖空规则 / 不匹配 / argMatcher 抛错 / 多规则取第一个等
- `agent-registry.ts`：把 B1 的 inline no-op 换成调 `createCollabExtension({ rules: DEFAULT_RULES, onApprovalNeeded: async () => "allow" })`

**关键设计决定**：

| 决策 | 理由 |
|---|---|
| matcher 是纯函数（无 IO / 无随机） | 16 单测全覆盖，未来加规则只改这里 |
| argMatcher 是 callback 而非 JSON schema | v0 内置规则少，callback 表达力强；未来想做 UI 编辑规则时再抽 schema |
| stub `onApprovalNeeded` 默认 allow | B2 不改变 user-visible 行为，仅验证"命中规则 → 调到 callback"链路 |
| extension 内 try/catch 兜底 allow（R6）| 防御性：extension 自身 bug 不能阻塞正常 agent |

**门禁**：tsc ✅ / lint 91w 20e ✅ / vitest **81/81（+16）** ✅ / build ✅ / e2e 6/6 ✅

---

### 2.4 阶段 B3：真审批通道（server-store + 路由 + UI）

**目标**：把 onApprovalNeeded 接到真审批通道，弹出 chat 内联气泡，用户点 allow / deny 后 SDK runner 真的被解锁/阻塞。

**关键设计**：

#### 双层 store 选型：server pending Map + client 复用 reducer

server 端（`lib/collab/server-store.ts`，~120 行）：

- `globalThis.__digaAgentCollab.pending: Map<key, { resolve, deny, defaultDecision, timer, ruleId }>`
- key 为复合 `${agentId}:${toolCallId}` 满足多 session 并发
- `registerPendingApproval(...)` 返回 Promise，CollabExtension 的 onApprovalNeeded 在此 await
- `resolveApproval(key, decision)` 清 timer + clear map + resolve Promise
- 5min timeout：到点按 `defaultDecision`（rule 配的 / 全局 allow）自动 resolve

client 端：**不引入新 store**，直接扩 chatReducer：

- `lib/types.ts` 加 `MessagePart` 的 `kind: "approval"`（status: pending / allowed / denied / timed_out）
- `lib/chat-reducer.ts`：
  - `approval_request` → push 内联 part 到当前 assistant message
  - `approval_resolved` → 倒序遍历找该 toolCallId 的 part 更新 status（兼容 active 已 close 的场景）

#### SSE 事件通道选型

走相同 ring buffer：扩 `RingBufferEvent` union（非 SDK 的 `AgentSessionEvent` union）加 `approval_request` / `approval_resolved` 两个 custom kind。

**为什么不开第二条 SSE**：

| 选项 | 评估 |
|---|---|
| 走同 SSE ring buffer + 扩 union | ✅ 顺序保证（approval 气泡严格在 tool_call 后）/ 0 新连接 / SSE 路径 JSON.stringify 透明 |
| 开第二条 `/api/agent/[id]/approvals/stream` | ❌ 需要前端协调两路顺序 / 多一条连接 / 客户端 onMount race |

#### POST 路由不推 SSE 事件

`/api/agent/[id]/approval`（POST）：

- body: `{ key, decision }` → 调 `resolveApproval(key, decision)`
- 不推 SSE `approval_resolved`
- 由 CollabExtension 在 await pendingApproval 解锁后**统一推一次** approval_resolved 事件

**这一点设计很关键**：避免双源真实——如果 POST 路由也推 SSE，那么 timer 路径（5min 到点自动解锁）必须额外推一次，POST 路径就会重复推。统一在 await 解锁后推，user / timeout 两条路径自动覆盖。

#### 闭包前向引用

CollabExtension 在 factory 内创建时需要拿到 `pushExternalEvent`，但 `agent-registry.ts` 里 `pushExternalEvent` 又依赖即将创建的 session holder。

**解法**：用 `recordHolder` 模式——先创建空 holder（ref 形状），factory 闭包拿这个 holder ref，session 创建后再填充 holder.session。这样 factory 内闭包不会捕获 stale undefined。

#### approveCall / denyCall hook 边界

`app/hooks/useApprovals.ts`：

- approve / deny 都是**纯 POST**，不做乐观更新
- UI 状态从 pending → allowed / denied **唯一由 SSE approval_resolved 驱动**

理由：乐观更新会引入"用户点了但 server 失败"的回滚逻辑，B3 直接放弃乐观——网络快情况下肉眼无差，慢情况下用户能看到 pending 一直转圈、按钮可点（重试），语义清晰。

#### ApprovalBubble 形态

- pending：黄色边框 + ⚠️ + 显示规则 reason + Allow / Deny 按钮 + 5min 倒计时（每秒重渲）
- allowed：绿色边框 + ✓
- denied：红色边框 + ✗
- timed_out：灰色边框 + 时钟图标 + "按默认决策处理"

**门禁**：tsc ✅ / lint 91w 20e ✅ / vitest **87/87（+6 reducer）** ✅ / build ✅ / e2e 6/6 ✅

#### 踩坑

1. **active 已 close 的 approval_resolved**：用户 deny 后 agent abort，新 user message 来了，但 approval_resolved 事件仍在 SSE buffer 里。chatReducer 第一版只看 active assistant，会找不到 part。**解法**：倒序遍历 messages 找最近一个 approval part 匹配 toolCallId，命中后 in-place 更新。
2. **JSX 引号转义**：bubble 文案一开始用英文 `"` 触发 `react/no-unescaped-entities`，换成中文「」绕过。

---

### 2.5 阶段 B4：超时 + remember + Settings 开关

**目标**：把 B3 的"基础可用"升级到"日常体验流畅"——同 session 内重复操作不再反复弹气泡 + 用户能一键关闭整个协作层。

**关键设计**：

#### Session remember 走 server 端（最干净的"不再问"）

server 端不弹气泡才是真正的"不再问"——节省 round-trip 也保证不闪 UI：

- `server-store.ts` 加 `sessionRemember: Map<agentId, Set<ruleId>>`
- `addSessionRemember(agentId, ruleId)` / `hasSessionRemember(agentId, ruleId)` / `clearSessionRemember(agentId)` 三个 helper
- `lib/collab/extension.ts` 的 `ToolPolicyOptions` 加可选 `hasRemember(ruleId)` 回调
- extension `on("tool_call")` 命中规则后先检查 `hasRemember`，命中即 return ALLOW，**根本不调 onApprovalNeeded**
- `lib/agent-registry.ts` 注入时把 `hasRemember` 接到 server-store 的 `hasSessionRemember`
- `disposeAgent` 调 `clearSessionRemember(id)` 清理（防 Map 越积越大）

#### POST 路由必须先 addSessionRemember 后 resolveApproval

```ts
// 错序：可能极端竞态再弹一次
resolveApproval(key, "allow");        // SDK 解锁 → 下一个 tool_call 进来
addSessionRemember(agentId, ruleId);  // 此时 remember 还没写

// 正序
addSessionRemember(agentId, ruleId);  // 先写
resolveApproval(key, "allow");        // 再解锁
```

#### Deny 不实装 remember（明确决策）

deny + remember 语义是"以后这条规则的命令全部自动 deny"——这非常危险，可能 agent 反复尝试 → 反复 deny → 进入死循环。留给 Phase C 设计"deny remember + agent 收到上下文知道换策略"的协议。

#### 全局总开关走纯 client（不引入 PUT 路由 + 双源同步）

第一版方案：server 端加 `/api/collab/settings` PUT 路由 + server-store 存全局 enabled flag → 否决。原因：

| 维度 | client only | + server PUT |
|---|---|---|
| 实现复杂度 | 1 个 localStorage key | + PUT 路由 + server state + 双源同步 |
| 用户体验差异 | 关闭时 server 仍弹一次→client 立即 fetch POST allow（1 round-trip） | 完全不弹（0 round-trip） |
| 风险 | 浪费一次 round-trip | server 重启 state 丢 / 多 client 不同步 |

→ client only 完全够用，是用户的"逃生舱"按钮，浪费一次 round-trip 可接受。

实现：

- `lib/collab/settings.ts`（~50 行）+ 9 单测：`loadCollabSettings()` / `saveCollabSettings(s)` / safeStorage 容错
- `app/hooks/useAgentEvents.ts` 的 `approval_request` case：
  - 每次都 `loadCollabSettings()`（立即生效，不依赖 react state）
  - `enabled === false` → **不渲染气泡** + autoApprove 直接 fetch POST allow
- autoApprove **不走 approveCall**：approveCall 绑定 activeKey，但 SSE 的 aidForEvents 可能 ≠ activeKey（A 切到 B 时 A 仍跑），所以用事件携带的 aid 直接 fetch
- `app/ChatApp.tsx` 注入 `loadCollabSettings` + `autoApprove` 到 useAgentEvents
- `CollabSettingsSection.tsx` + `Inner.tsx`：复用 Phase A4 的 `next/dynamic({ ssr: false })` 模式，避免 hydration mismatch；UI 仅 1 个 `enabled` checkbox

#### Bubble 加「本会话不再问」勾选框

- 仅 `ruleId` 存在 + Allow 路径下显示（deny 不显示）
- 勾上 → POST body 加 `remember: "this-session"` + `ruleId`

#### useCallback deps 漂移修复

useAgentEvents 一开始加了 `isCollabEnabled` + `autoApprove` 但忘加到 deps，lint 报 1 warning（91 → 92）。修法：直接补 deps。ChatApp 那边传的是 inline arrow（每次 render 新引用），但 handleAgentEvent 是被 ref 包装的（`handleAgentEventRef.current`），所以新 callback 实例不会触发额外 SSE 重连。

**门禁**：tsc ✅ / lint **91w** 20e ✅ / vitest **96/96（+9 settings）** ✅ / build ✅ / e2e 6/6 ✅

---

## 3. 数据流全景

```
                        ┌───────────────────┐
                        │ Settings Panel    │   localStorage
                        │ (pi-collab)       │ ◄──┐ (enabled)
                        └─────────┬─────────┘    │
                                  │ load         │ save
              ┌───────────────────▼──────────────┘
              │  loadCollabSettings() (每次 approval_request 重读)
              └───────────────────┬──────────────
                                  │
   ┌──────────────────────────────┘
   │
   │  SSE: approval_request
   │
   ▼
┌───────────────────┐                    ┌──────────────────────────────┐
│ useAgentEvents    │                    │  CollabExtension (in SDK)    │
│ approval_request: │                    │  on("tool_call") {           │
│  if (!enabled)    │                    │    rule = matchRule(...)     │
│    autoApprove()  │                    │    if (rule) {               │
│  else             │                    │      if (hasRemember(rid))   │
│    push bubble    │                    │        return ALLOW          │
└────────┬──────────┘                    │      decision = await         │
         │                               │        onApprovalNeeded(...)  │
         │ 用户点 Allow/Deny             │      push approval_resolved   │
         ▼                               │      return decision          │
┌───────────────────┐                    │    }                          │
│ useApprovals      │                    │  }                            │
│ POST /approval    │                    └──────────────┬───────────────┘
│ {key, decision,   │                                   ▲
│  remember,ruleId} │                                   │ await
└────────┬──────────┘                                   │
         │                              ┌───────────────┴───────────────┐
         ▼                              │ server-store                  │
┌───────────────────────────┐           │ pending: Map<key, {           │
│ POST route                │  ───────► │   resolve, deny, timer,       │
│ if (remember==this-session│           │   defaultDecision, ruleId }>  │
│   && ruleId)              │           │ sessionRemember:              │
│   addSessionRemember()    │           │   Map<aid, Set<ruleId>>       │
│ resolveApproval(key,d)    │           └───────────────┬───────────────┘
└───────────────────────────┘                           │
                                                        │ 5min timer 到
                                                        ▼
                                         按 defaultDecision 自动 resolve
                                         （走相同 push approval_resolved 路径）
```

server pending Map / sessionRemember Map 的生命周期：

| 事件 | pending | sessionRemember |
|---|---|---|
| approval 弹出 | +1 entry | — |
| 用户 allow / deny | -1 entry | — |
| 用户 allow + 「本会话不再问」 | -1 entry | +1 ruleId 到 agentId set |
| 5min 超时 | -1 entry | — |
| disposeAgent (session 关闭) | （SDK 自动）| 整个 agentId 删除 |

---

## 4. 接缝清单（Phase C / 后续 RFC 可复用）

Phase B 留下了 5 个干净接缝，未来扩展不用动 SDK / 不用动 ChatApp 核心：

| 接缝 | 用途 | 示例扩展 |
|---|---|---|
| `lib/collab/rules.ts` 的 `DEFAULT_RULES` | 内置规则集 | 加 `kubectl delete` / `dd if=` 等只追加 |
| `ToolPolicyOptions.onApprovalNeeded` callback | 决策入口 | 接 webhook / 写审计日志 / 接 pet 形态弹窗 |
| `ToolPolicyOptions.hasRemember` callback | 跳过判定 | 加全局 remember（跨 session）只改这里 |
| `MessagePart` 的 `kind: "approval"` | 内联气泡渲染 | 加 edit 路径（status 加 `editing`）只改 reducer + bubble |
| SSE `approval_request` / `approval_resolved` 事件 | 跨进程通知 | 推第二 client（dashboard）观察审批情况 |

---

## 5. 未做的 / 留给 Phase C

### 5.1 已显式 out-of-scope

| 项 | 留给 | 原因 |
|---|---|---|
| F3 意图预览（agent 先口头说要做什么）| Phase C | 需要 SDK 加 pre-tool-call 钩子或前置 message hook |
| Deny 的 session remember | Phase C | 需要设计"agent 收到 deny 上下文知道换策略"的协议，避免死循环 |
| Edit 路径（修改命令后允许执行）| Phase C | SDK 支持 input mutation 但 UI 改造较大，v0 价值有限 |
| 全局规则 JSON 持久化 | Phase C | 当前 1 条 DEFAULT_RULES 够用；持久化要做规则 schema 校验 |
| Settings 自定义规则 CRUD UI | Phase C | 同上 |
| Pet 形态弹窗 + 智能体头像 | Phase C | 已规划在 `2026-06-01-pet-interaction-design.md`，体验提升项 |
| 多 agent 共享审批（一个 agent allow 影响其他）| 后续 RFC | 与 RFC-3 session 元数据系统强耦合 |

### 5.2 已知 sharp edges

1. **5min 超时后默认决策的"防御性 allow"风险**：当前 `defaultDecision` 默认是 allow。如果用户挂着 agent 跑半小时然后关电脑去吃饭，回来发现自动放行了一堆危险命令。Phase C 应该改成默认 deny 或加用户可配的 timeout policy。
2. **Server 重启 pending 全丢**：开发态 dev server 重启会把所有 pending Promise 永久挂起。生产态短时间内有效，但 long-running 审批（用户去开会）跨 Electron 主进程重启会丢。RFC-3 持久化层可接。
3. **autoApprove 的 race**：用户在 settings 把开关从 on 切到 off 后，已经在飞行中的 approval_request 还是会弹气泡（因为已经走到 push bubble 分支）。补救：用户手动 allow / deny / 等超时即可。极端 case，Phase C 可考虑加"刚切关时主动 fetch 所有 pending 自动 allow"。
4. **sessionRemember 的 ruleId 漂移**：如果改了 `DEFAULT_RULES` 的 id，老 session 的 remember set 里的旧 id 会失效（不再命中）。等于"自动遗忘"，可接受。
5. **多浏览器 tab**：同 agent 在两个 tab 打开时，approval 气泡会在两个 tab 都显示（同 ring buffer 推），但 resolve 只能一个 tab 操作（另一个 tab 看到 approval_resolved 后会变 disabled）。SSE 自动一致，无需额外处理。

---

## 6. 复盘：本轮做对的 5 件事

1. **B1 / B2 走 no-op + stub**：架构改造和能力上线分两 commit，B1 跑通 SDK 接缝（行为不变）、B2 跑通 matcher 链路（行为仅在命中时变）。这两次 commit 各自的回归面极小，给 B3 那次大改打了底。
2. **SSE 走同一 ring buffer**：扩 RingBufferEvent union 而非开第二条 SSE，零顺序协调成本，前端 reducer 加 2 个 case 就完事。
3. **server-store 用 globalThis singleton**：Next.js dev hot reload 不会重建 globalThis 上的对象，pending Map 跨 reload 不丢。生产 build 也是单进程模式（Electron），无 worker race。
4. **session remember 走 server**：第一版想用 client localStorage（持久化跨 reload），但 server 端仍弹气泡 → client 立即 deny → 体验闪烁。改成 server 端 Map 后，server 真的不弹，体验最干净。
5. **总开关走 client（不引入 PUT 路由）**：识别出"逃生舱浪费 1 round-trip 完全可接受"，避免引入 client/server 双源同步的复杂度。这是用 30 分钟讨论换 2 天编码的判断。

## 7. 复盘：本轮可以更好的 3 件事

1. **B4 lint 漂移**：useCallback deps 漏加 isCollabEnabled + autoApprove，跑完全门禁才发现 92 warning。教训：**修任何 hook 的依赖前先 grep 一下 deps 数组**，不要凭印象。
2. **闭包前向引用第一次没识别出**：B3 把 CollabExtension 真接通时，factory 闭包要拿 pushExternalEvent，但 session 还没建，第一次写直接捕获了 undefined。靠 recordHolder 模式绕开，但绕开本身花了一轮 debug。教训：**factory 模式 + 闭包 + 后填依赖** 是经典 race，下次先画依赖图。
3. **Approval bubble 倒序遍历的边界没单测**："active 已 close 的 approval_resolved" 这个 case 是手测发现的（deny 后发新 message，旧 bubble 应该更新成红色）。reducer 单测应该补一条覆盖。留给 Phase C 收尾时补。

---

## 附录 A：commit 清单

```
eb72286 feat(collab): 审批超时 + session 记忆 + Settings 开关（RFC-2 Phase B4）
2ca1047 feat(collab): 工具审批 chat 内联气泡 + 真审批通道（RFC-2 Phase B3）
c0a9340 feat(collab): CollabExtension + matcher + 1 条内置规则（RFC-2 Phase B2）
e322086 refactor(agent): 注入 DefaultResourceLoader + no-op CollabExtension（RFC-2 Phase B1）
```

## 附录 B：新增 / 修改文件清单（B1 → B4 累计）

**新增**：

```
lib/collab/extension.ts                          80    ToolPolicyOptions + createCollabExtension
lib/collab/matcher.ts                            60    matchRule 纯函数
lib/collab/matcher.test.ts                      170    16 cases
lib/collab/rules.ts                              30    DEFAULT_RULES (1 条 bash)
lib/collab/server-store.ts                      150    pending Map + sessionRemember Map + helpers
lib/collab/settings.ts                           50    localStorage pi-collab + safeStorage
lib/collab/settings.test.ts                     130    9 cases
app/api/agent/[id]/approval/route.ts             80    POST 决策路由
app/components/ApprovalBubble.tsx               150    3 status + 倒计时 + 「本会话不再问」
app/hooks/useApprovals.ts                        60    approve / deny POST hook
app/settings/CollabSettingsSection.tsx           22    next/dynamic ssr:false wrapper
app/settings/CollabSettingsSectionInner.tsx      80    纯 CSR 单 enabled checkbox
                                              -----
                                               1062    总
```

**修改**：

```
lib/agent-registry.ts          ~+40   注入 DefaultResourceLoader + CollabExtension + recordHolder
                                       + pushExternalEvent + RingBufferEvent union 扩两 kind
                                       + disposeAgent 调 clearSessionRemember
lib/types.ts                    +5    MessagePart 加 kind:"approval"
lib/chat-reducer.ts             +40   approval_request push part / approval_resolved 倒序更新
                                       + findApprovalPartIndex helper
lib/chat-reducer.test.ts        +6    6 cases (approval push / resolve / 倒序 / 兼容)
app/hooks/useAgentEvents.ts     +35   approval_request / approval_resolved 两 case
                                       + isCollabEnabled / autoApprove 注入分支
app/components/MessageView.tsx   +5    透传 onApproveCall / onDenyCall（opts 第二参）
app/components/MessagesScrollArea.tsx  +5    同上
app/ChatApp.tsx                 +20   wire useApprovals / useAgentEvents 注入 settings
app/settings/SettingsPanel.tsx   +5    两个 panel 各嵌一份 <CollabSettingsSection />
```

## 附录 C：与 RFC-2 / RFC-3 的关系

```
RFC-1（已完成）
  └─ RFC-1.5 / RFC-test-infra（已完成）
      └─ RFC-2 Phase A（已完成）—— 会话级 Budget MVP
          └─ RFC-2 Phase B（本文，已完成）—— 工具审批
              └─ RFC-2 Phase C（未启动）—— 意图预览 + Edit + Deny remember
                  └─ pet 形态弹窗集成（已规划）
              └─ RFC-3（未启动）—— Session 元数据 / 搜索 / 摘要
                                    ↑
                                    └─ Phase C 的"跨 session 全局规则持久化"依赖此
```
