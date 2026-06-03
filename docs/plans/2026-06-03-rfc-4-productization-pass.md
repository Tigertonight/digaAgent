# RFC-4: Productization Pass

> **状态**：Planning
> **创建**：2026-06-03
> **目标**：把 mini-pi-web 从“功能可用”推进到“新用户能配置、长任务能放心跑、核心代码能继续演进”的 Beta+ 状态
> **范围**：Provider/Auth Onboarding、Long-running Reliability、ChatApp Thin Pass
> **预计工期**：5-7 人天

---

## 0. TL;DR

上一轮 pet/main 合并后，项目已经具备完整产品闭环：Web + Electron、本地 session、多模型、工具审批、Budget、搜索、项目记忆、DMG 打包。但下一阶段不应该继续堆功能，而应该补三类“产品化缺口”：

| Phase | 主题 | 解决什么 | 工时 |
|---|---|---|---|
| **A** | Provider/Auth Onboarding | 用户第一次打开不知道该选 API Key、OAuth 还是自定义 endpoint | 2-2.5d |
| **B** | Long-running Reliability | 长任务、审批、搜索、断线恢复还有进程内状态和提示欠账 | 2-2.5d |
| **C** | ChatApp Thin Pass | `ChatApp.tsx` 仍是 1500+ 行，Auth/Models 面板也偏厚 | 1.5-2d |

**执行原则**：每个子任务一个 commit；每个 commit 可独立验证、可回滚；Phase A 优先，因为入口不清楚会挡住所有后续体验。

---

## 1. 非目标

- 不新增模型 provider 能力，SDK 已覆盖主流 provider。
- 不重写 SDK 调用链。
- 不做新的桌面宠物能力。
- 不做自动摘要 F3，本 RFC 只为未来 F3 清理 provider/settings 基础。
- 不引入新的全局状态管理库，除非 C 阶段实际证明 React state 继续拆不动。

---

## 2. Phase A: Provider/Auth Onboarding

### A0. 文案与信息架构盘点

**Commit**

```text
docs(rfc): 补充 RFC-4 Provider/Auth 信息架构盘点
```

**目标**

先把当前 provider/auth 入口的用户心智写清楚：`openai` API Key、`openai-codex` OAuth、Anthropic/Google API Key、自定义 OpenAI-compatible endpoint 分别是什么。

**Files**

- `docs/plans/2026-06-03-rfc-4-productization-pass.md`
- `docs/guides/provider-auth.md`

**验收**

- 文档明确区分 API Key 与 ChatGPT/Codex OAuth。
- 写清凭证来源优先级：runtime override → `auth.json` → OAuth token → env → `models.json` fallback。
- 给出自定义 OpenAI-compatible endpoint 的 `models.json` 示例。

---

### A1. 新增 Provider Setup Wizard 壳

**Commit**

```text
feat(auth): 新增 ProviderSetupWizard 首次配置入口
```

**目标**

新增一个专门的配置向导组件，不替换现有 AuthPanel / ModelsConfigPanel，只在空凭证或用户点击 “Setup” 时打开。

**Files**

- Add: `app/components/ProviderSetupWizard.tsx`
- Modify: `app/components/TopHeader.tsx`
- Modify: `app/ChatApp.tsx`

**设计**

向导第一屏只做四个入口：

| 入口 | provider | 后续动作 |
|---|---|---|
| OpenAI API Key | `openai` | 填 API Key |
| ChatGPT/Codex OAuth | `openai-codex` | 打开 OAuthLoginModal |
| Anthropic / Claude | `anthropic` | 填 API Key 或 OAuth（如 SDK 支持） |
| Custom endpoint | 自定义 | 跳 ModelsConfigPanel |

**验收**

- 没有已授权 provider 时，用户能从主界面明显进入 Setup。
- 已有 provider 时不打扰现有用户。
- 不改变现有 AuthPanel 行为。

---

### A2. Provider 状态归一化 hook

**Commit**

```text
refactor(auth): 抽出 useProviderStatus 统一 provider/auth 状态
```

**目标**

当前 provider 数据分散在 ChatApp、AuthPanel、ModelsConfigPanel。抽一个 hook 统一加载 `/api/providers` 和 `/api/auth`，给 Wizard/AuthPanel/Composer 共享。

**Files**

- Add: `app/hooks/useProviderStatus.ts`
- Modify: `app/ChatApp.tsx`
- Modify: `app/components/AuthPanel.tsx`
- Modify: `app/components/ProviderSetupWizard.tsx`

**验收**

- provider 列表刷新逻辑从 ChatApp 里减少。
- 保存/删除凭证后能统一刷新 provider 和 auth 状态。
- TypeScript 通过。

---

### A3. API Key 保存后自动验证

**Commit**

```text
feat(auth): API key 保存后支持最小模型调用验证
```

**目标**

用户填 key 后不只显示 “saved”，而是能看到 “此凭证可调用某个模型”。优先复用现有 `/api/models-config/test` 的最小 prompt 逻辑；若 provider 是内置 provider，则新增轻量 test route。

**Files**

- Add or Modify: `app/api/auth/test/route.ts`
- Modify: `app/components/ProviderSetupWizard.tsx`
- Modify: `app/components/AuthPanel.tsx`

**验收**

- OpenAI API Key 可验证默认模型。
- 验证失败能显示具体原因：无模型、无 key、401、quota、baseUrl 不通。
- 不在 UI 暴露 key 内容。

---

### A4. OAuth/Codex 通道说明与登录结果刷新

**Commit**

```text
feat(auth): 优化 Codex OAuth 登录说明与登录后刷新
```

**目标**

把 `openai` 和 `openai-codex` 的差异产品化：前者是 OpenAI API Key，后者是 ChatGPT/Codex subscription OAuth。

**Files**

- Modify: `app/components/AuthPanel.tsx`
- Modify: `app/components/ProviderSetupWizard.tsx`
- Modify: `app/api/auth/login/[provider]/route.ts`（仅必要时）

**验收**

- OAuth 成功后自动刷新 provider/model 列表。
- UI 明确写出 `openai-codex` 使用 ChatGPT/Codex 授权通道。
- 失败/取消/需要粘贴 callback code 的状态更清楚。

---

### A5. 首次配置 e2e

**Commit**

```text
test(e2e): 覆盖 provider setup 基础路径
```

**目标**

补一条 Playwright 路径，确保 Setup 入口、AuthPanel、保存 key 的 mock 路由交互不会回归。

**Files**

- Add: `e2e/02-provider-setup.spec.ts`
- Modify: `e2e/fixtures.ts`

**验收**

- e2e 不打真实模型。
- 覆盖无授权 provider → 打开 setup → 选择 API key → mock save → provider 状态刷新。

---

## 3. Phase B: Long-running Reliability

### B1. Pending approval 可观测 API

**Commit**

```text
feat(collab): 暴露 pending approvals 查询接口
```

**目标**

先不做持久化，先让前端刷新后能主动拉当前 pending approvals，补上 “只靠 SSE ring buffer” 的缺口。

**Files**

- Modify: `lib/collab/server-store.ts`
- Add or Modify: `app/api/agent/[id]/approval/route.ts`
- Modify: `app/hooks/useApprovals.ts`

**验收**

- 前端 mount 时可拉取当前 agent 的 pending approval。
- 多 tab 同 agent 打开时，两个 tab 状态一致。
- 单测覆盖 `listPendingApprovals` 过滤 agentId。

---

### B2. Approval 状态刷新恢复

**Commit**

```text
feat(collab): 前端刷新后恢复待审批气泡
```

**目标**

页面刷新或 SSE 重连后，如果 server 仍有 pending approval，chat 内能重新显示审批气泡。

**Files**

- Modify: `app/hooks/useApprovals.ts`
- Modify: `app/hooks/useAgentEvents.ts`
- Modify: `lib/chat-reducer.ts`
- Modify: `lib/chat-reducer.test.ts`

**验收**

- 刷新页面后 pending 气泡不丢。
- 已 resolved 的气泡不会重复出现。
- 补充 approval bubble 倒序更新边界单测。

---

### B3. Search 冷构建提示与 timeout

**Commit**

```text
feat(search): 增加索引构建状态与超时提示
```

**目标**

解决 Phase B 回顾里的搜索冷构建 UI 假死风险。

**Files**

- Modify: `app/api/search/route.ts`
- Modify: `app/api/search/cache.ts`
- Modify: `app/hooks/useSearch.ts`
- Modify: `app/components/SidebarSearch.tsx`

**验收**

- 首次搜索时显示 “Building index...”。
- 超过阈值显示可重试提示。
- 不改变现有搜索结果排序。

---

### B4. SSE / session running 状态恢复提示

**Commit**

```text
feat(session): 增强 SSE 断线与后台运行状态提示
```

**目标**

长任务核心是用户知道“它还在跑还是断了”。强化 sidebar/session header 的 running、lost、idle 状态。

**Files**

- Modify: `app/hooks/useSseManager.ts`
- Modify: `app/components/Sidebar.tsx`
- Modify: `app/components/TopHeader.tsx`
- Modify: `app/pet/*`（如需要同步宠物状态）

**验收**

- SSE lost 时 UI 有明确状态。
- 用户能手动重连当前 session。
- 不影响后台 session 继续累积事件。

---

### B5. Reliability e2e

**Commit**

```text
test(e2e): 覆盖 approval 恢复与搜索冷构建提示
```

**目标**

补上历史文档里明确欠的 e2e：搜索和审批。

**Files**

- Add: `e2e/03-reliability.spec.ts`

**验收**

- mock pending approval → reload → 气泡仍显示。
- mock search slow build → UI 显示 building。

---

## 4. Phase C: ChatApp Thin Pass

### C1. Provider/model 状态下沉

**Commit**

```text
refactor(chat): 抽出 useProviderModel 收敛模型选择状态
```

**目标**

把 provider/model loading、localStorage 持久化、默认模型选择、reloadProviders 从 ChatApp 抽走。这个 hook 复用 A2 的 `useProviderStatus`。

**Files**

- Add: `app/hooks/useProviderModel.ts`
- Modify: `app/ChatApp.tsx`
- Modify: `app/components/Composer.tsx`

**验收**

- ChatApp 减少 100+ 行。
- 刷新后 provider/model 选择保持。
- 切换模型仍能调用 `/api/agent/:id set_model`。

---

### C2. UI modal state reducer

**Commit**

```text
refactor(chat): 用 modal reducer 收敛 ChatApp 弹层状态
```

**目标**

ChatApp 顶层 modal boolean 太多，抽成 `useChatModalsState` 或 reducer，降低 handler 分散度。

**Files**

- Add: `app/hooks/useChatModalsState.ts`
- Modify: `app/ChatApp.tsx`
- Modify: `app/components/ChatModals.tsx`

**验收**

- ChatApp 删除多组 `showX/setShowX`。
- ChatModals props 数下降。
- 所有 modal 打开/关闭路径不变。

---

### C3. 拆 AuthPanel 大组件

**Commit**

```text
refactor(auth): 拆分 AuthPanel 与 OAuthLoginModal
```

**目标**

`AuthPanel.tsx` 目前 800+ 行。拆出 OAuth modal、provider row、empty/error/loading 状态，方便 A 阶段继续改授权体验。

**Files**

- Add: `app/components/auth/OAuthLoginModal.tsx`
- Add: `app/components/auth/AuthProviderRow.tsx`
- Modify: `app/components/AuthPanel.tsx`

**验收**

- AuthPanel 行数降到 450 行以内。
- OAuth login 行为不变。
- TypeScript 通过。

---

### C4. 拆 ModelsConfigPanel 大组件

**Commit**

```text
refactor(models): 拆分 ModelsConfigPanel provider 与 model 编辑区
```

**目标**

`ModelsConfigPanel.tsx` 目前 800+ 行。拆 provider card、model row、test result，降低后续自定义 endpoint 改造成本。

**Files**

- Add: `app/components/models/ProviderConfigCard.tsx`
- Add: `app/components/models/ModelConfigRow.tsx`
- Modify: `app/components/ModelsConfigPanel.tsx`

**验收**

- ModelsConfigPanel 行数降到 500 行以内。
- Add/Edit/Delete/Test/Save 行为不变。

---

### C5. Final quality gate + retrospective

**Commit**

```text
docs(rfc): 补充 RFC-4 执行回顾
```

**目标**

按上一轮 pet 分支标准跑完整门禁并写回顾。

**命令**

```bash
npm test
npx tsc --noEmit
npm run build
npx playwright test
```

**验收**

- 单测全绿。
- e2e 全绿。
- build 成功。
- `ChatApp.tsx` 目标降到 1200 行以内；若未达成，回顾里解释剩余结构债。

---

## 5. 推荐执行顺序

严格顺序：

```text
A0 → A1 → A2 → A3 → A4 → A5
                     ↓
                  B1 → B2 → B3 → B4 → B5
                                      ↓
                                   C1 → C2 → C3 → C4 → C5
```

不建议并行做 C，因为 A/B 会继续改 AuthPanel、ModelsConfigPanel、ChatApp。如果先拆 C，后面容易出现重复搬迁。

---

## 6. Commit 清单总览

```text
docs(rfc): 补充 RFC-4 Provider/Auth 信息架构盘点
feat(auth): 新增 ProviderSetupWizard 首次配置入口
refactor(auth): 抽出 useProviderStatus 统一 provider/auth 状态
feat(auth): API key 保存后支持最小模型调用验证
feat(auth): 优化 Codex OAuth 登录说明与登录后刷新
test(e2e): 覆盖 provider setup 基础路径

feat(collab): 暴露 pending approvals 查询接口
feat(collab): 前端刷新后恢复待审批气泡
feat(search): 增加索引构建状态与超时提示
feat(session): 增强 SSE 断线与后台运行状态提示
test(e2e): 覆盖 approval 恢复与搜索冷构建提示

refactor(chat): 抽出 useProviderModel 收敛模型选择状态
refactor(chat): 用 modal reducer 收敛 ChatApp 弹层状态
refactor(auth): 拆分 AuthPanel 与 OAuthLoginModal
refactor(models): 拆分 ModelsConfigPanel provider 与 model 编辑区
docs(rfc): 补充 RFC-4 执行回顾
```

---

## 7. 风险登记

| 风险 | Phase | 影响 | 缓解 |
|---|---|---|---|
| Provider wizard 与现有 AuthPanel 逻辑重复 | A | 状态双源 | A2 先抽 `useProviderStatus` |
| API Key 验证误触真实高成本模型 | A3 | 成本/延迟 | 固定最小 prompt + 默认便宜模型 + timeout |
| OAuth provider 行为受 SDK 变更影响 | A4 | 登录失败 | UI 保留 manual code fallback |
| Pending approval 进程重启仍会丢 | B | 长任务恢复不完整 | B1/B2 先做刷新恢复；持久化另开 RFC |
| Search building 状态让 API 变复杂 | B3 | 回归搜索 | 保持结果 schema 向后兼容 |
| ChatApp 拆 hook 触发 stale closure | C | 高 | 每个 commit 只拆一类状态，并跑 e2e |

---

## 8. Done 标准

RFC-4 完成时应满足：

- 新用户打开 app 后能通过 Setup 明确选择授权方式。
- 用户能理解 `openai` API Key 与 `openai-codex` OAuth 的区别。
- 保存凭证后能验证是否可调用模型。
- 刷新页面后 pending approval 不丢。
- 搜索冷构建有明确反馈。
- SSE lost/running 状态更清楚。
- `ChatApp.tsx` 接近或低于 1200 行。
- AuthPanel / ModelsConfigPanel 不再是 800+ 行大组件。
- 至少新增 2 条 e2e：provider setup、reliability。
