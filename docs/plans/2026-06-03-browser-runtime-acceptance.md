# Browser Runtime Acceptance

Date: 2026-06-03

## Goal

让“需要浏览器”的用户任务先被本地 runtime 稳定接管，再把真实浏览器观察结果注入模型上下文。模型可以继续解释、总结、判断，但不再需要先猜自己有没有浏览器能力。

## Completed Checklist

- [x] Browser intent router: 从自然语言里识别 open URL、search、verify、copy first result、click visible text、fill input、press Enter。
- [x] Runtime preflight: 在 `/api/agent/:id` 收到 prompt 后先执行浏览器任务，再把 observation 拼回模型 prompt。
- [x] Search/copy path: 搜索后提取结果链接，可选择第一条并写入剪切板。
- [x] Open/copy path: 打开页面后提取链接，可选择第一条并写入剪切板。
- [x] Click path: 打开页面后按可见文本点击按钮或链接，再二次 extract。
- [x] Fill path: 打开页面后填入第一个可见输入框，可选按 Enter，再二次 extract。
- [x] Task timeline: 每个 runtime 动作带同一个 `taskId`，并同步到 Browser Panel 的 logs/steps。
- [x] UI visibility: Browser Panel 可以在没有现有 session 时打开；收到 `browser_state` 后自动展开。
- [x] Safety policy: 本地站点自动允许，外部站点仍走 allow/block policy。

## Acceptance Evidence

- `npx vitest run lib/browser/intent.test.ts`: 9 tests passed.
- `npx tsc --noEmit`: passed.
- `npx eslint lib/browser/intent.ts lib/browser/runtime.ts lib/browser/task-runtime.ts app/components/BrowserPanel.tsx app/components/TopHeader.tsx 'app/api/agent/[id]/route.ts' --quiet`: passed.
- `npx playwright test e2e/05-browser.spec.ts`: 3 tests passed.
- Manual API/browser runtime QA:
  - Prompt: open `http://localhost:3000/browser-task-fixture.html`, fill `hello runtime`, press Enter, read page state.
  - Result: task `passed`, intent `navigate`, actions under one `taskId`: `open -> extract -> fill -> extract`.

## Remaining Boundaries

- Cross-site public search can still be affected by captcha, anti-bot redirects, and site policy. Runtime should surface `blocked` instead of pretending success.
- Natural language ordering is currently simple: open/extract, fill/extract, click/extract. More complex mixed workflows need a small planner.
- Link clicking inside assistant markdown now opens the right Browser Panel, but model-generated instructions still need explicit browser intent text to trigger deterministic preflight.
- Visual annotation is UI-ready, but “annotation drives runtime action” is not yet implemented.
