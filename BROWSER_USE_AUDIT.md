# Browser Use 功能审核报告


## 概述

本报告对 `diga-agent` 仓库中 "Browser Use" 相关的全部代码路径进行结构化审计，覆盖工具定义、调度执行、安全策略、标注 (annotations) 流转、错误处理、以及面向 LLM 的 Prompt/文档说明。审计聚焦于：

- Schema 与运行时契约是否一致（schema/handler drift）
- 多分支执行路径（Playwright vs in-app host）是否语义一致
- 多标签页 (tabs) 状态的一致性与并发风险
- 失败、超时、断连等异常路径是否对外暴露稳定的 errorCode
- LLM 可见的 description/系统提示是否会诱发可避免的错误调用

合计识别 **1 个高危 (High)**、**3 个中危 (Medium)**、**2 个轻微/信息项 (Low/Info)**；其中部分子模块（safety / annotations / errors / prompt-docs）因输入材料未单独提供深度审计，本报告只能基于已知证据给出现状结论，并明确标注未覆盖的缺口。

## 范围与方法

### 审计范围（代码）

| 模块 | 主要文件 |
| --- | --- |
| 工具定义 / Schema | `lib/browser/extension.ts` |
| 运行时调度 | `lib/browser/runtime.ts` |
| 浏览器 ID / 注册 | `lib/browser/browser-id.ts`, `lib/agent-registry.ts` |
| 安全策略 | `lib/browser/policy.ts` |
| 类型定义 | `lib/browser/types.ts` |
| 工作流编排 | `lib/workflows/script-runtime.ts` (`BROWSER_WORKFLOW_AGENT_TOOLS`) |
| 单元测试参考 | `lib/browser/extension.test.ts`, `lib/browser/runtime.test.ts`, `lib/browser/policy.test.ts` |

### 审计输入

本报告基于两段子审计的原始输出进行去重、合并与归类：

- `tools` 子审计：聚焦 Schema 与 Handler 之间的契约一致性，含 5 项 finding (F1–F5)。
- `dispatcher` 子审计：聚焦 `runAction` / `tab_open` / `tab_switch` / `disposeBrowser` 等多页面状态流转。

未单独收到独立子审计输出的子模块（`safety`、`annotations`、`errors`、`prompt-docs`）以"基于已观察到的证据 + 现状描述 + 缺口标注"方式呈现，不臆断额外问题。

### 方法

1. 对每条 finding 标注严重度、`file:line`、问题摘要、证据原文（或精确等价引用）、建议修复。
2. 对跨子审计重复出现的问题（例如 schema 必填缺失、Playwright 与 in-app host 路径不一致）执行**合并去重**。
3. 对源码中的关键代码片段做了二次核对（见 `lib/browser/extension.ts:48-55`、`lib/browser/runtime.ts:242-249`），确保引用准确，不依赖摘要的二手描述。
4. 对未提供深度子审计的模块明确写出"未发现问题（基于现有证据）"或"输入不足，缺口待补"，避免编造结论。

## 严重问题 (High)

### H1 — `browser_tab_open` 在 `switchTo:false` 时返回错误标签页的快照（dispatcher）

- 严重度：**High**
- 文件：`lib/browser/runtime.ts:1399-1440`（`browserTabOpen`），`runAction` 中的 `refreshSnapshot(rec, page)` 调用
- 问题：当调用 `browser_tab_open({ url, switchTo: false })` 时，新页面被创建并执行 `goto(url)`，但 `rec.page` 不会被切换到新页面；随后 `runAction` 依然以原 `rec.page`（旧 active tab）作为参数调用 `refreshSnapshot`，导致返回给 LLM 的快照（URL/title/screenshot）反映的是**旧 tab**，而不是刚打开的新 tab。同时新 tab 的 title 仍保持初始 `null`。
- 证据：

  ```js
  // runtime.ts ~1408
  const page = input.switchTo === false ? await context.newPage() : await context.newPage();
  page.setDefaultTimeout(10_000);
  rec.tabPages.set(tab.id, page);
  if (input.switchTo !== false) rec.page = page;
  return runAction(browserId, "tab_open", normalized, async (_page, rec) => {
    const targetPage = rec.tabPages.get(tab.id) ?? existingPage;
    await targetPage.goto(normalized, ...);
    ...
  });
  ```

  `runAction` 内部则统一执行：

  ```js
  const { rec, page } = await ensurePage(browserId);   // page === rec.page
  const result = await fn(page, rec);
  const snapshot = await refreshSnapshot(rec, page);   // 旧 page，不是 targetPage
  ```

- 后果：
  1. 模型据此快照做下一步决策时极易走错（以为新页面打开失败、或 URL/title 与预期不符而触发重复 open/wait_for）。
  2. `upsertBrowserTab` 在 `runAction` 之前已被调用一次（提前写入"打开成功"状态），如 `goto` 后续抛错，外层快照仍声称该 tab 处于 `active`/已就位状态，状态被提前固化，回滚也未实现。
  3. 同一条路径上，三元 `input.switchTo === false ? context.newPage() : context.newPage()` 两支完全相同（dead code），说明意图与实现已经丢失，回归风险高。
- 建议修复：
  1. 让 `runAction` 接受显式 `page` 参数，或在 `tab_open` 内部跳过外层 `refreshSnapshot`、改为用 `targetPage` 单独刷新 `tabPages` 中对应记录的快照。
  2. 删除恒等三元，改为 `const page = await context.newPage();`，将"前后台"语义集中在 `switchTo` 决定 `bringToFront()` 与 `rec.page` 赋值。
  3. 将 `upsertBrowserTab` 的"成功态"写入挪到 `goto` 完成后；`goto` 失败路径返回标准化 `failedToolResult({ errorCode: "tab_open_failed" })`，而不是把临时态固化进快照。
  4. 增加单元测试：`switchTo:false` 后 `rec.page` 不变，且工具返回的 `snapshot.url` 等于旧 tab URL（或显式返回新 tab 的快照——任选其一，但必须在文档与实现中明确）。

## 中等问题 (Medium)

### M1 — `browser_click` Schema 未表达 "selector XOR (x,y)" 契约（tools, F1）

- 严重度：**Medium**（贴近 High，因为是**高频**工具）
- 文件：`lib/browser/extension.ts:48-55`（schema），`lib/browser/runtime.ts:1055-1094`（handler）
- 问题：`ClickParams` 把 `selector`、`x`、`y` 三者全部声明为 `Optional`。模型可以发出 `browser_click({})`，仅在执行到 handler 末尾时才 `throw new Error("selector or x/y required")`。同时只传 `x` 不传 `y`（或反之）也只能在运行时落到 `else throw`。
- 证据：

  ```ts
  const ClickParams = Type.Object({
    selector: Type.Optional(Type.String(...)),
    x: Type.Optional(Type.Number(...)),
    y: Type.Optional(Type.Number(...)),
  });
  ```

  ```ts
  // runtime.ts
  } else { throw new Error("selector or x/y required"); }
  ```

- 后果：白白消耗一轮工具调用、污染时间线、增加延迟；模型从 schema 里看不到正确契约，错误持续复现。
- 建议修复：
  1. 用 `Type.Union` 表达两种合法形态：`{ selector: string }` 或 `{ x: number; y: number }`；或在顶层加显式 `description: "Provide either selector OR both x and y."`
  2. 在 `execute` 入口做前置校验，命中时直接返回 `failedToolResult({ errorCode: "invalid_params" })`，不要让异常穿透到通用错误通道。

### M2 — `browser_wait_for` Schema/Handler 漂移，且 in-app 与 Playwright 路径行为不一致（tools, F2）

- 严重度：**Medium**
- 文件：`lib/browser/extension.ts:118-133`，`lib/browser/runtime.ts:1281-1289`
- 问题：`WaitForParams` 四个字段全 Optional，`{}` 调用在 Playwright 分支会抛 `wait_for requires at least one of url/selector/text`；但 `runInAppAction` 分支（runtime.ts:1281 附近）**不做这个前置校验**就把命令派发给 webview，最终结果构建器无条件返回 `{ passed: true }`。同一工具在两条传输路径上得到**相反**的结果。
- 证据：

  ```ts
  // extension.ts
  const WaitForParams = Type.Object({
    url: Type.Optional(...), selector: Type.Optional(...),
    text: Type.Optional(...), timeoutMs: Type.Optional(...),
  });
  ```

  ```ts
  // runtime.ts (Playwright 路径)
  if (!input.url && !input.selector && !input.text) {
    throw new Error("wait_for requires at least one of url/selector/text");
  }
  ```

- 后果：模型在 in-app host 下会得到误导性的"成功 + passed=true"，这在工作流断言场景下是**正确性级别**的问题。
- 建议修复：
  1. 把"至少一个条件"前移到 `browserWaitFor` 入口，**在路径分发之前**统一校验。
  2. Schema 改为 `Type.Union([{url},{selector},{text}])` 形式的判别联合，并保留 `timeoutMs` 为可选附加项。
  3. 添加针对 in-app 路径的回归测试。

### M3 — `browser_tab_switch` 索引语义与 `browser_tabs` 输出错位（dispatcher）

- 严重度：**Medium**
- 文件：`lib/browser/runtime.ts:242-249`（`formatBrowserTabs`），`lib/browser/extension.ts:163-167`（`TabSwitchParams.index`）
- 问题：`browser_tabs` 工具向模型展示的列表使用 **1 起始**编号 (`${index + 1}.`)，而 `browser_tab_switch` 的 `index` 字段 description 写的是 **"Zero-based tab index from browser_tabs."**——两者错位 1。模型按照展示编号去 switch 必然命中错误 tab 或越界。
- 证据：

  ```ts
  // runtime.ts:242
  function formatBrowserTabs(snapshot: BrowserSnapshot): string {
    if (snapshot.tabs.length === 0) return "No browser tabs are registered.";
    return snapshot.tabs.map((tab, index) =>
      `${index + 1}. ${tab.active ? "*" : " "} ${tab.id} ...`
    ).join("\n");
  }
  ```

  ```ts
  // extension.ts:163
  index: Type.Optional(
    Type.Number({ description: "Zero-based tab index from browser_tabs." })
  ),
  ```

- 后果：典型 off-by-one footgun。即便模型能看到 description，它看到的列表也会强烈暗示 1-based。
- 建议修复（任选其一并保持一致）：
  1. **推荐**：改 `formatBrowserTabs` 输出为 `${index}. ...`（0-based），与 schema 对齐；并在 description 中注明"as shown by browser_tabs"。
  2. 或者把 `TabSwitchParams.index` 改为 1-based，handler 内部 `-1`，并同步 description。
  3. 进一步建议：让 `browser_tabs` 优先教 LLM 使用 `tabId`（更稳定），把 `index` 标注为"fallback/legacy"。

### M4 — `browser_tab_open` 中存在恒等三元 dead code，且预先写入未确认状态（dispatcher）

- 严重度：**Medium**（与 H1 同源，单独列出修复要点便于跟踪）
- 文件：`lib/browser/runtime.ts:1408-1428`
- 问题：
  1. `input.switchTo === false ? await context.newPage() : await context.newPage()` 两支完全相同——明显是历史上"前台/后台 tab"语义遗失留下的空壳。
  2. `upsertBrowserTab` 在 `runAction` 之前调用（`switchTo:true` 路径下设置 `active: true`），随后 `runAction` 内部又再次调用——重复写且 `goto` 失败时不会回滚。
  3. `existingPage` 通过 `ensurePage` 拿到，但 `rec.tabPages.get(tab.id)` 永远命中，导致 `?? existingPage` 后半永远是死分支。
- 证据：见 H1 中代码片段。
- 建议修复：与 H1 合并修复；同时移除 `existingPage` 兜底以减少误导。

## 轻微 / 信息 (Low / Info)

### L1 — `browser_wait` 空入参隐式 sleep 1s 未在 description 中说明（tools, F3）

- 严重度：**Low**
- 文件：`lib/browser/extension.ts:97-101`，`lib/browser/runtime.ts:1265`
- 问题：`WaitParams` 三字段全 Optional。`browser_wait({})` 落入 `await page.waitForTimeout(Math.min(Math.max(input.ms ?? 1000, 100), 30_000))`，等价于无条件 sleep 1s。这在文档中**没有**说明。
- 证据：`else await page.waitForTimeout(Math.min(Math.max(input.ms ?? 1000, 100), 30_000));`
- 后果：不是 bug，但会助长模型大量发出无用的 `browser_wait()` 占位调用。
- 建议修复（二选一）：
  - 在 description 增补 `"Default 1000ms when no condition is given."`，并在系统提示中显式提倡 `browser_wait_for` 用于条件等待。
  - 或移除隐式 sleep，要求 `ms` 在缺省 selector/text 时为必填。

### L2 — `browser_search.engine` 缺少 description / 默认值不可见（tools, F5）

- 严重度：**Info**
- 文件：`lib/browser/extension.ts:84-94`
- 问题：`SearchParams.engine` 是 `"baidu" | "google" | "bing"` 的 `Type.Union`，但 union 上没有 `description`，模型看不到"默认 = baidu"以及三者各自的适用场景。
- 证据：

  ```ts
  engine: Type.Optional(Type.Union([
    Type.Literal("baidu"), Type.Literal("google"), Type.Literal("bing"),
  ])),
  ```

- 后果：影响模型自主选择检索引擎；不影响正确性。
- 建议修复：在 union（或外层 Optional）上加 `description: "Search engine. Default 'baidu'. Use 'google'/'bing' when an English query is more appropriate."`

### L3 — In-app host 的 `tab_switch` 是 "重新 goto URL" 而非真实切换（dispatcher, 信息项）

- 严重度：**Info**
- 文件：`lib/browser/runtime.ts`（in-app `tab_switch` 分支，包含 `if (!target.url) throw new Error('tab ${target.id} has no URL to restore')`）
- 问题：In-app 浏览器在切换 tab 时通过 URL 重新导航来"恢复"页面，而 Playwright 路径是真实的 page 切换。两者在 cookie/scroll/history-stack/表单状态保留上行为不同；这种差异未在工具 description 或系统提示中标注。
- 后果：如果工作流依赖 tab 内已填写的表单状态/未提交数据，in-app 路径会丢失。
- 建议修复：
  - 在 `browser_tab_switch` description 加一句 "in some hosts, switching may reload the tab"；或
  - 在系统提示中告知模型 in-app 模式下避免假定 tab 内状态可保留。

### L4 — `disposeBrowser` 与 in-app host 断连的竞态被静默吞掉（dispatcher, 信息项）

- 严重度：**Low**
- 文件：`lib/browser/runtime.ts`（`disposeBrowser`、`browserClose`）
- 问题：`browserClose` 在 host 已断开时会 reject 为 `browser_host_disconnected`，外层 `disposeBrowser` 用 `.catch(() => {})` 静默吞掉。Agent 释放路径 `void disposeBrowser(agentBrowserId(id))` 是 fire-and-forget，agent record 立即删除——若此时还有正在进行的 Playwright 操作则可能成为孤儿。
- 后果：通常无害（资源最终被进程退出回收），但在长生命周期工作流中可能产生悬挂的 page/context 资源。
- 建议修复：
  1. 在 `disposeBrowser` 中区分 `browser_host_disconnected`（可吞）与其他错误（应记录），不要全部静默。
  2. 让 `disposeBrowser` 返回的 Promise 至少被 `await` 在工作流结束前的 cleanup hook 中。

### L5 — 子模块 `safety` / `annotations` / `errors` / `prompt-docs`：审计输入缺口（信息项）

- 严重度：**Info**
- 状态：本次报告未收到针对这四个子模块的独立深度审计输出。基于已观察到的代码：
  - `lib/browser/policy.ts` 与 `policy.test.ts` 存在，外站审批 / 敏感动作二次确认在系统提示中有明确表述（见仓库中相关提示模板）。
  - `annotationBrowserIds` / `listOpenAnnotationsForAgent`（`lib/browser/extension.ts`）实现了多 browserId 聚合与去重，未发现表面缺陷。
- 缺口：未对以下点做穷举核查，建议后续补审：
  - 外站首次访问的"已审批 origin"在 session 间是否会泄漏。
  - `browser_resolve_annotation` 是否做权限/归属校验。
  - 工具失败时返回结构是否始终满足 `{ errorCode, finalUrl, title, recoverable }`（提示词承诺）的契约。
  - 系统提示中"两次失败必须停止重试"是否在 dispatcher 层有强制兜底。

## 各模块状态总览 (tools / dispatcher / safety / annotations / errors / prompt-docs)

| 模块 | 主要文件 | 状态 | 关联 finding |
| --- | --- | --- | --- |
| **tools / schema** | `lib/browser/extension.ts` | ⚠️ 多处 Schema 与 Handler 契约漂移 | M1, M2, L1, L2 |
| **dispatcher / runtime** | `lib/browser/runtime.ts` | ❌ 含一个 High（tab_open 快照错位），以及 tab 索引 off-by-one | H1, M3, M4, L3, L4 |
| **safety / policy** | `lib/browser/policy.ts`, `lib/browser/policy.test.ts` | 🟢 现有证据未发现问题；**未做穷举核查** | L5（缺口） |
| **annotations** | `lib/browser/extension.ts` (`annotationBrowserIds`, `listOpenAnnotationsForAgent`) | 🟢 多 browserId 聚合 + 去重逻辑未见表面缺陷 | L5（缺口） |
| **errors / failedToolResult** | `lib/browser/runtime.ts` 各 handler | ⚠️ 部分路径仍 `throw new Error(...)`，未统一走 `failedToolResult({ errorCode })` | M1, M2 |
| **prompt-docs / 系统提示** | `lib/browser/extension.ts` 内嵌 system prompt | ⚠️ 缺：`browser_wait` 默认 1s、in-app `tab_switch` 重新 goto 语义、tab 索引 0 vs 1、`engine` 默认值 | M3, L1, L2, L3 |

图例：🟢 = 未发现问题（证据有限）；⚠️ = 有可改进项；❌ = 含高危

## 建议的修复优先级

### P0（先修，阻断正确性问题）

1. **H1 + M4** — `browser_tab_open` 路径重构：
   - 删除恒等三元；
   - 让 `runAction` 接收显式 `page` 或在 tab_open 内单独刷新新 tab 的快照；
   - `goto` 完成后再写入"成功态" tab，失败走 `failedToolResult({ errorCode: "tab_open_failed" })`；
   - 加单测覆盖 `switchTo:false` 与 `goto` 失败两种回归。
2. **M2** — `browser_wait_for` 在路径分发**之前**统一前置校验"至少一个条件"，并补 in-app 路径回归测试，避免 `passed:true` 误导。
3. **M3** — `browser_tabs` 输出与 `browser_tab_switch.index` 的 0/1-based 对齐（推荐改输出为 0-based）。

### P1（提升模型成功率与可观测性）

4. **M1** — `browser_click` schema 改判别联合 + handler 入口前置校验，统一 `errorCode: "invalid_params"`。
5. **L1** — `browser_wait` 在 description 中明确"无条件即 1s sleep"，并在系统提示中引导优先 `browser_wait_for`。
6. **L4** — `disposeBrowser` 区分 `browser_host_disconnected` 与其他错误；工作流 cleanup hook 中显式 await。

### P2（文档与可发现性）

7. **L2** — `SearchParams.engine` 增补 description（默认值与各引擎适用场景）。
8. **L3** — In-app `tab_switch` 重新 goto 语义在 description / 系统提示中显式标注。
9. **L5** — 单独立项审计 `safety / annotations / errors / prompt-docs` 的剩余面（origin 审批跨 session 行为、annotation 归属校验、`failedToolResult` 字段契约一致性、"两次失败停止重试"的 dispatcher 兜底）。

### 关键回归测试清单（建议落地）

- `browser_tab_open({ switchTo: false })` 后 `rec.page` 不变；返回快照与新 tab 行为符合明示契约。
- `browser_wait_for({})` 在 Playwright 与 in-app host 两条路径返回**同一种** `failedToolResult`。
- `browser_click({})`、`browser_click({ x: 1 })`（单轴）走 `invalid_params`，不污染时间线。
- `browser_tabs` 列出 N 个 tab 后，`browser_tab_switch({ index: N-1 })` 命中最后一个 tab；`{ index: N }` 返回越界错误。

## 附录: 审计输入摘要

本节列出原始子审计输入的核心要点，便于回溯。

### A. tools 子审计（`lib/browser/extension.ts`）— 5 项 finding

| ID | 标题 | 严重度 | 本报告映射 |
| --- | --- | --- | --- |
| F1 `tooldef.click.no-required-input` | `browser_click` 允许零参调用，schema 未表达 selector XOR (x,y) | high | **M1** |
| F2 `tooldef.wait_for.no-condition` | `browser_wait_for` schema 全 Optional，且 in-app 路径不前置校验 | medium | **M2** |
| F3 `tooldef.wait.implicit-sleep` | `browser_wait()` 空入参 = 隐式 sleep 1s，无文档 | low | **L1** |
| F4 `tooldef.tab_open.switchTo-default` | `browser_tab_open` 三元两支恒等，dead code | medium | **M4 / H1** |
| F5 `tooldef.search.engine-description` | `SearchParams.engine` 缺 description | info | **L2** |

> 注：tools 子审计将 F1 标为 high；本报告将其下调为 Medium，理由是该问题表现为"模型多花一轮",并非破坏运行时正确性，重新分级以避免与真正的状态错位 (H1) 混淆。

### B. dispatcher 子审计（`lib/browser/runtime.ts`）— 主要要点

1. `formatBrowserTabs` 使用 `${index + 1}.` 输出，而 `TabSwitchParams.index` description 为 "Zero-based"，存在 off-by-one footgun。→ **M3**
2. `browserTabOpen` 中 `input.switchTo === false ? context.newPage() : context.newPage()` 两支恒等，且 `runAction` 内 `refreshSnapshot(rec, page)` 仍用旧 `rec.page`，导致 `switchTo:false` 时返回**旧 tab 的快照**。→ **H1 / M4**
3. `upsertBrowserTab` 在 navigation 完成前已被调用一次（switchTo:true 路径），失败时不回滚。→ **M4**
4. `existingPage` 兜底为死分支（`rec.tabPages.get(tab.id)` 永远命中）。→ **M4**
5. In-app `tab_switch` 通过 URL 重新 `goto` 来"恢复" tab，与 Playwright 真实 page 切换在状态保留上语义不一致。→ **L3**
6. `disposeBrowser` 用 `.catch(() => {})` 静默吞掉 `browser_host_disconnected` 之外的错误；agent dispose 路径 `void disposeBrowser(...)` 是 fire-and-forget。→ **L4**

### C. 未独立提供子审计的模块

`safety / annotations / errors / prompt-docs` 未收到独立审计输出。本报告基于 `lib/browser/policy.ts`、`lib/browser/extension.ts` 中的 `annotationBrowserIds` / `listOpenAnnotationsForAgent` 等可见证据给出"未发现问题"的现状结论，并在 **L5** 标注后续应独立立项核查的具体面向。

### D. 关键代码位置索引（便于后续修复）

- `lib/browser/extension.ts:48-55` — `ClickParams`
- `lib/browser/extension.ts:84-94` — `SearchParams`
- `lib/browser/extension.ts:97-101` — `WaitParams`
- `lib/browser/extension.ts:118-133` — `WaitForParams`
- `lib/browser/extension.ts:142-147` — `TabOpenParams`
- `lib/browser/extension.ts:163-167` — `TabSwitchParams`
- `lib/browser/runtime.ts:242-249` — `formatBrowserTabs`
- `lib/browser/runtime.ts:1055-1094` — `click` handler
- `lib/browser/runtime.ts:1265` — `browser_wait` 隐式 sleep
- `lib/browser/runtime.ts:1281-1289` — `browser_wait_for` Playwright 校验分支
- `lib/browser/runtime.ts:1399-1440` — `browserTabOpen`
