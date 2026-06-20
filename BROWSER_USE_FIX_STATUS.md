# Browser Use 修复状态核对

## 概述

本报告核对 `BROWSER_USE_AUDIT.md` 中 10 条 finding（H1 / M1 / M2 / M3 / M4 / L1 / L2 / L3 / L4 / L5）在当前代码中的修复状态。

核对依据由三组 verifier 输出整合而成：

- **Dispatcher 组**：H1 / M3 / M4 / L3 / L4，覆盖 `lib/browser/runtime.ts` 中 `browserTabOpen` / `formatBrowserTabs` / `disposeBrowser` 等派发与生命周期路径。
- **Tool-schema 组**：M1 / M2 / L1 / L2，覆盖 `lib/browser/extension.ts` 中 `ClickParams` / `WaitForParams` / `WaitParams` / `SearchParams` 的 schema 与系统 prompt，以及 `lib/browser/runtime.ts` 中对应入口校验。
- **审计缺口项**：L5，覆盖原报告中"safety / annotations / errors / prompt-docs 四个子模块未独立深度审计"这一立项请求是否落地。

判定值采用三档：`fixed`（与 expected_fix 完全一致）、`partially_fixed`（部分项落地、有显著残余风险）、`not_fixed`（核心 expected_fix 未落地）。所有引用的代码位置均为当前仓库实际行号，原审计中过期行号不再使用。

## 修复状态总表

| id | severity | 标题 | status | 关键证据 (file:line) | 残余风险 |
|----|----------|------|--------|----------------------|----------|
| H1 | high | `tab_open` switchTo:false 返回旧 tab 快照但声称是新 tab | fixed | `lib/browser/runtime.ts:1455-1497`（in-app 分支显式返回 `openedUrl`+`switchTo:false` 合约）；`lib/browser/runtime.ts:1498-1530`（Playwright 分支 goto 后才切 `rec.page` 与 `upsertBrowserTab`）；`lib/browser/extension.ts:815`（prompt 显式声明 switchTo:false 不假设 active 是新页） | 无 |
| M1 | medium | `ClickParams` selector 与 (x,y) 互斥未在 schema 表达 | fixed | `lib/browser/extension.ts:52-66`（`Type.Union` XOR）；`lib/browser/runtime.ts:257-272, 350-356, 1117-1125`（`validateClickInput` 前置 + `invalid_params` 错误码） | 无 |
| M2 | medium | `WaitForParams` 允许空入参，in-app 直接 passed:true | fixed | `lib/browser/extension.ts:139-168`（三分支判别联合）；`lib/browser/runtime.ts:244-255, 1336-1352`（`validateWaitForInput` 入口前置统一两条路径） | 无（in-app 路径回归测试覆盖不在本次代码核查范围） |
| M3 | medium | `formatBrowserTabs` 1-based 与 schema 0-based 错位 | fixed | `lib/browser/runtime.ts:273-282`（输出改为 0-based）；`lib/browser/extension.ts:198-203`（description 标注 zero-based 并推 tabId 优先） | 无 |
| M4 | medium | `tab_open` 恒等三元 + existingPage 死分支 + 预先写未确认状态 | fixed | `lib/browser/runtime.ts:1498`（仅一次 `context.newPage()`）；`grep existingPage` 无命中；`lib/browser/runtime.ts:1505-1518`（`upsertBrowserTab` 仅在 goto 成功后调用一次）；`lib/browser/runtime.ts:1533-1551`（catch 关闭新 page，无需回滚） | 无 |
| L1 | low | `browser_wait` 空入参隐式 sleep 1000ms 未声明 | fixed | `lib/browser/extension.ts:116-125`（`WaitParams.ms` description 显式 1000ms 默认）；`lib/browser/extension.ts:464, 480`（系统提示推 `browser_wait_for`） | 无 |
| L2 | low | `SearchParams.engine` 默认与适用场景未在 schema 表达 | fixed | `lib/browser/extension.ts:99-114`（`Type.Union` 带 description 注明默认 baidu 与 google/bing 场景） | 无 |
| L3 | low | in-app `tab_switch` URL 重新 goto 丢失 tab 内状态未告知 | fixed | `lib/browser/extension.ts:463`（系统 prompt 显式声明"in-app 模式 switching 可能 reload URL 而非保留 form/scroll/history"）；`lib/browser/runtime.ts:1567-1574`（实现保持 reload 语义） | 无 |
| L4 | low | `disposeBrowser` 错误未分类 + agent cleanup fire-and-forget | fixed | `lib/browser/runtime.ts`（错误分类：`browser_host_disconnected` 静默吞、其他 `console.warn`）；`lib/agent-registry.ts`（`disposeAgent` awaits `disposeBrowser(agentBrowserId(id))`） | 无 |
| L5 | low | safety / annotations / errors / prompt-docs 四子模块未独立深审 | fixed | `docs/audit/browser-safety-audit.md`、`browser-annotations-audit.md`、`browser-errors-audit.md`、`browser-prompt-docs-audit.md`；`lib/browser/policy.ts`（scoped approvals）；`lib/browser/extension.ts`（annotation ownership failure + repeated failure gate） | Settings UI 仍保留全局 allow/block 管理入口，后续可在产品文案上区分全局策略与本会话记住 |

## 详细核对

### Dispatcher 组 (H1 / M3 / M4 / L3 / L4)

#### H1 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/runtime.ts:1455-1497`（in-app 路径的 switchTo:false 分支）：
    ```ts
    if (input.switchTo === false) {
      const log = pushLog(rec, "tab_open", normalized, opts);
      upsertBrowserTab(rec, { id: tabId, url: normalized, title: null, active: false });
      finishLog(log); pushStep(rec, log, rec.snapshot);
      return {
        result: { url: rec.snapshot.url, tabId, openedUrl: normalized, switchTo: false },
        snapshot: { ...rec.snapshot, updatedAt: Date.now() },
      };
    }
    ```
    这里返回的快照确实是旧（当前活跃）tab 的快照，但通过额外字段 `openedUrl + switchTo:false` 显式将这一语义暴露给调用方。
  - `lib/browser/runtime.ts:1498-1530`（Playwright 路径）：goto 完成后才 `rec.page = targetPage`、才 `upsertBrowserTab`、才根据 switchTo 决定 `refreshSnapshot(rec, targetPage)` 或返回带 `status:"ready"` 的旧 snapshot。
  - `lib/browser/runtime.ts:1533-1551` catch 分支：`await targetPage.close()` 回滚后，抛 `BrowserRuntimeError` 携带 `classified.code / recoverable`，匹配 `failedToolResult({ errorCode })` 契约。
  - `lib/browser/extension.ts:815`：prompt guideline 显式声明 "When switchTo=false, do not assume the active snapshot is the new page; switch to that tab before extracting it"，将"返回旧 tab 快照"作为合约暴露。
- **reasoning**: 原 finding 的三个问题都已处理：(1) switchTo:false 时不再让 runAction 拿旧 `rec.page` 走通用刷新流程，而是分支化处理并显式告知调用方返回的是旧 snapshot；(2) `upsertBrowserTab` 成功态挪到 goto 完成后；(3) 恒等三元 / `existingPage` 死分支已删除（详见 M4）。
- **residual_risk**: 无。

#### M3 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/runtime.ts:273-282` `formatBrowserTabs`：
    ```ts
    return snapshot.tabs.map(
      (tab, index) =>
        `${index}. ${tab.active ? "*" : " "} ${tab.id} ${tab.title ?? "(untitled)"} ${tab.url ?? "(no url)"}`
    ).join("\n");
    ```
    输出已改为 **0-based**。
  - `lib/browser/extension.ts:201-203` `TabSwitchParams.index` description：`"Zero-based tab index exactly as shown by browser_tabs. Prefer tabId when possible."`
  - `lib/browser/extension.ts:198-200` 同时强调 tabId 更优先："Stable tab id returned by browser_tabs. Prefer this over index."
- **reasoning**: 原 finding 推荐方案 1（`formatBrowserTabs` 输出 0-based 与 schema 对齐）+ 方案 3（推 tabId 优先）已同时落地，1-based 错位消失。
- **residual_risk**: 无。

#### M4 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/runtime.ts:1498` 仅一次 `await context.newPage()`，原 `switchTo===false ? newPage() : newPage()` 恒等三元已不存在。
  - `grep "existingPage" lib/browser/runtime.ts` → No matches，死分支兜底已删除。
  - `lib/browser/runtime.ts:1505-1518`：`upsertBrowserTab` 仅在 `await targetPage.goto(...)` 成功后调用一次，不再有"runAction 之前预先写一次 active:true"的双写。
  - `lib/browser/runtime.ts:1533-1551` catch：失败时 `targetPage.close()` 并把 `rec.snapshot` 置为 error，再抛 `BrowserRuntimeError`。因为成功态从未被预先写入，无需对 `upsertBrowserTab` 做回滚。
- **reasoning**: H1 / M4 合并修复已完成；恒等三元、`existingPage` 兜底、预先写入未确认状态三处均消除。
- **residual_risk**: 无。

#### L3 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/extension.ts:463`（系统 prompt）：
    > "5. browser_tabs / browser_tab_open / browser_tab_switch when the user asks to compare or switch between multiple pages. Prefer tabId over index. **In the in-app browser host, switching a tab slot may reload that tab's URL instead of preserving form/scroll/history state.**"
  - in-app `tab_switch` 实现仍是 URL 重新 goto（`lib/browser/runtime.ts:1567-1574` 调 `runInAppAction("tab_switch", ..., { tabId, url })`），但已通过系统提示明确告知模型这一行为差异。
- **reasoning**: 原 finding 的 expected_fix 是"在系统提示中告知 in-app 模式下避免假定 tab 内状态可保留"——已逐字落地。语义本身（重新 goto）按 finding 也允许保留。
- **residual_risk**: 无。

#### L4 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/runtime.ts:1839-1856` `disposeBrowser`：
    ```ts
    try { await browserClose(browserId); }
    catch (error) {
      if (isBrowserRuntimeError(error) && error.code === "browser_host_disconnected") {
        // Expected when an in-app panel is already gone.
      } else {
        console.warn("[browser] dispose failed", error instanceof Error ? error.message : String(error));
      }
    }
    reg.browsers.delete(browserId);
    ```
    错误已分类：`browser_host_disconnected` 静默吞，其他通过 `console.warn` 记录。
  - `lib/agent-registry.ts`：`disposeAgent` 现在 `await disposeBrowser(agentBrowserId(id));`，browser cleanup 已纳入 agent dispose 生命周期。
- **reasoning**: 原 finding expected_fix 两点均已落地："区分 `host_disconnected` 与其他错误并记录"已修；"在 cleanup hook 中显式 await 返回的 Promise"也已修。
- **residual_risk**: 无。

### Tool-schema 组 (M1 / M2 / L1 / L2)

#### M1 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/extension.ts:52-66` `ClickParams` 改为 `Type.Union([{selector}, {x,y}], { description: "Provide either selector OR both x and y, but not both." })`，schema 层面表达 selector XOR (x,y)。
  - `lib/browser/runtime.ts:257-272` 新增 `validateClickInput`，对非法组合（同时给 / 都不给 / 只给一个坐标）抛 `invalidParamsError(...)`。
  - `lib/browser/runtime.ts:350-356` `invalidParamsError` 通过 `BrowserRuntimeError` 携带 `code: "invalid_params"`，匹配 `failedToolResult({ errorCode: "invalid_params" })` 的契约期望。
  - `lib/browser/runtime.ts:1117-1125` `browserClick` 入口立刻调用 `validateClickInput(input, browserId)`，然后才进入 in-app / Playwright 分支。
- **reasoning**: Schema 已用 `Type.Union` 表达 selector XOR (x,y)，且 handler 在路径分发之前做前置校验并以 `invalid_params` 错误码返回，与 expected_fix 完全一致。
- **residual_risk**: 无。

#### M2 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/extension.ts:139-168` `WaitForParams` 已改为 `Type.Union` 三分支（url / selector / text），每支 `timeoutMs` 仍为 `Type.Optional`，外层 description 明确写 "Empty input is invalid."。
  - `lib/browser/runtime.ts:244-255` `validateWaitForInput`：当 `url/selector/text` 全空时抛 `invalidParamsError(..., "wait_for requires at least one of url/selector/text")`。
  - `lib/browser/runtime.ts:1336-1352` `browserWaitFor` 入口第一步即 `validateWaitForInput(input, browserId)`，**先于** in-app 与 Playwright 分支分发，两条路径行为已统一。
- **reasoning**: Schema 改为判别联合保留可选 `timeoutMs`；"至少一个条件"的校验被前移至公共入口，in-app 路径不再可能用 `{}` 直接走到 `() => ({ passed: true })`。
- **residual_risk**: 无（对应 in-app 路径回归测试是否补齐属于测试覆盖问题，不在本次代码核查范围）。

#### L1 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/extension.ts:116-125` `WaitParams.ms` 的 description 已扩写为：`"Milliseconds to wait. If selector/text/ms are all omitted, browser_wait sleeps for 1000ms."`，将隐式 sleep 行为对模型显式化。
  - `lib/browser/extension.ts:480` 系统提示中新增一条：`"browser_wait with empty input is only a short 1000ms sleep. Prefer browser_wait_for with url, selector, or text for real readiness checks."`。
  - `lib/browser/extension.ts:464` 系统提示步骤 6 也专门强调 `browser_wait_for` 用于真实就绪检查。
- **reasoning**: expected_fix 中"在 description 增补 'Default 1000ms when no condition is given.' 并在系统提示中提倡用 `browser_wait_for`"两项均落地，措辞略不同但语义等价且更明确。
- **residual_risk**: 无。

#### L2 — fixed

- **status**: fixed
- **evidence**:
  - `lib/browser/extension.ts:99-114` `SearchParams.engine` 的 `Type.Union` 现在带有 description：
    ```ts
    Type.Union(
      [Type.Literal("baidu"), Type.Literal("google"), Type.Literal("bing")],
      { description: "Search engine. Default is baidu. Use google or bing when an English/global query is more appropriate." },
    )
    ```
- **reasoning**: 默认值 `baidu` 与 `google / bing` 适用场景已写入 union 的 description，模型可见，符合 expected_fix。
- **residual_risk**: 无。

### 审计缺口项 (L5)

#### L5 — fixed

- **status**: fixed
- **evidence**:
  1. **独立审计文档已落地**：
     - `docs/audit/browser-safety-audit.md`
     - `docs/audit/browser-annotations-audit.md`
     - `docs/audit/browser-errors-audit.md`
     - `docs/audit/browser-prompt-docs-audit.md`
  2. **origin 审批 scoped 化**：`lib/browser/policy.ts` 新增 `allowedScopedOrigins` / `blockedScopedOrigins`，agent Browser Use 通过 `agent:<agentId>|<origin>` 记忆站点审批；`lib/browser/runtime.ts` 根据 `browserId` 推导 agent scope 做二次校验。
  3. **annotation 归属失败显式化**：`lib/browser/extension.ts` 的 `findAnnotationBrowserId` 找不到当前 agent/session browser set 内的 annotation 时抛错，不再 fallback 到当前 agent browser 假装成功。
  4. **两次失败停止重试硬计数**：`lib/browser/extension.ts` 的 `runBrowserTool` 按 agent/tool/target 记录失败，第三次相同失败返回 `repeated_browser_action_failed`。
- **reasoning**: L5 要求的四个子模块审计文档、两处可疑代码点，以及 prompt-only retry guidance 的硬兜底均已补齐。
- **residual_risk**: Settings UI 仍保留全局 allow/block 管理入口，作为显式全局管理能力保留；后续产品文案可进一步区分"本会话记住"与"全局允许"。

## 结论与下一步

**统计**（共 10 条）：

- **fixed**：10 条 — H1 / M1 / M2 / M3 / M4 / L1 / L2 / L3 / L4 / L5
- **partially_fixed**：0 条
- **not_fixed**：0 条

**按优先级建议下一步动作**：

1. **产品文案**：Settings 里的 browser policy 是全局策略；审批卡片里的"本会话记住"是 scoped approval。后续可在 UI 文案上明确区分。
2. **持续测试**：新 browser tool 增加时，应同步补 schema 约束、structured error、以及 repeated-failure 行为测试。

**整体判定**：10 条 finding 均已闭环。Browser Use 审计可以整体关闭；后续只剩产品文案与新工具接入时的持续测试要求。
