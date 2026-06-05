# Architecture Health Regression Test Plan

Date: 2026-06-06

Source: `docs/plans/2026-06-05-architecture-health-roadmap.md`

## Objective

Define the regression suite needed to harden mini-pi-web's runtime identity, browser workbench, evidence/event layer, workflows, subagents, goals, approvals, progress, and Electron surfaces.

The purpose is to catch the class of bugs already seen in practice:

- BrowserPanel opens but actions are disabled because no live `agentId` exists.
- Browser use executes twice through two paths.
- Progress keeps showing `RUNNING` after the turn is stopped or ended.
- Stop button disappears because `streaming` is false while progress is still running.
- Session switch leaves BrowserPanel, approvals, progress, or ToolsPanel bound to stale runtime state.
- Electron in-app browser diverges from web BrowserPanel behavior.

## Test Layers

| Layer | Purpose | Tools |
| --- | --- | --- |
| Unit tests | Pure identity, event, evidence, browser-id, progress, policy logic | Vitest |
| API tests | Runtime routes, browser routes, agent actions, approval/progress/evidence APIs | Vitest route tests or integration helpers |
| Component tests | BrowserPanel, ProgressPopover, GoalTimeline, Composer stop state | Existing React test setup when available; otherwise targeted e2e |
| Browser e2e | Web UI capability stories | Playwright |
| Electron acceptance | In-app BrowserPanel/webview/pet-specific behavior | Computer Use + optional Playwright Electron harness later |
| Manual acceptance | High-risk UX flows involving live model/tool behavior | Structured checklist |

## Baseline Regression Commands

Every implementation phase should run:

```bash
npm run lint
npx eslint . --max-warnings=0
npx tsc --noEmit --pretty false
npm run test
```

For UI-impacting changes:

```bash
npm run dev
ELECTRON_DISABLE_PET=1 npm run electron:dev
```

Then validate in Electron with Computer Use.

## Phase 1: Runtime Identity Regression

### Unit Tests

File:

- `lib/runtime/identity.test.ts`

Cases:

1. Draft mode:
   - no selected session
   - no live agent
   - browser id resolves to `standalone:default`
   - mode is `draft`

2. Persisted-only historical session:
   - selected `sessionId`
   - selected `sessionPath`
   - no live agent
   - browser id resolves to `standalone:session:${sessionId}`
   - mode is `persisted_only`

3. Live agent session:
   - selected session and live agent exist
   - browser id resolves to `agent:${agentId}`
   - mode is `live`

4. Task browser:
   - task id provided
   - browser id resolves to `task:${taskId}`

5. Session switch:
   - identity changes from live A to persisted-only B
   - browser id changes
   - previous agent id is not retained

### E2E Stories

1. Historical session no live agent:
   - Start app.
   - Select historical session.
   - Open BrowserPanel.
   - Confirm BrowserPanel shows explicit standalone/history state.
   - Manually open `http://localhost:3000/browser-task-fixture.html`.
   - Confirm page renders and actions are enabled.

2. Live agent switch:
   - Select live/running session A.
   - Open BrowserPanel.
   - Switch to session B.
   - Confirm BrowserPanel URL/snapshot/evidence do not show stale A state unless explicitly shared.

3. Stop state:
   - Create a progress state with running/pending steps.
   - Ensure Composer shows Stop even if `streaming=false`.
   - Click Stop.
   - Confirm progress running/pending steps become failed/aborted.

## Phase 2: Structured Browser Tools Regression

### Unit/API Tests

Files:

- `lib/browser/browser-id.test.ts`
- `lib/browser/runtime.test.ts`
- `lib/browser/extension.test.ts`
- `app/api/browser/[id]/route.test.ts`

Cases:

1. `browser_open` result shape:
   - contains `observation`
   - contains `snapshot`
   - contains at least one evidence item

2. `browser_extract` result shape:
   - extracted text exists
   - evidence includes `browser_step`
   - snapshot URL/title are current

3. `browser_click` navigation:
   - opens fixture
   - clicks `Diga Result A`
   - waits for URL containing `browser-target-a.html`
   - evidence includes click and navigation/wait result

4. `browser_wait_for` timeout:
   - waits for impossible text
   - returns failed/error evidence
   - does not hang test suite

5. No preflight duplicate:
   - prompt/router path does not call browser runtime outside `browser_*` tool call.
   - If a test harness exists, spy browser runtime and assert one call per tool.

### Browser E2E Story

Use fixture pages:

- `public/browser-task-fixture.html`
- `public/browser-target-a.html`
- `public/browser-target-b.html`
- `public/browser-sensitive-fixture.html`

Flow:

1. Ask agent to open fixture.
2. Verify visible tool cards:
   - `browser_open`
   - `browser_extract`
   - `browser_click_text` or `browser_click`
   - `browser_wait_for`
   - `browser_verify`
3. Verify BrowserPanel shows target page.
4. Open evidence drawer.
5. Verify each step row has:
   - action label
   - status
   - URL
   - timestamp
   - details/extracted text where relevant

## Phase 3: Evidence/Event Layer Regression

### Unit Tests

Files:

- `lib/runtime/events.test.ts`
- `lib/runtime/event-store.test.ts`
- `lib/evidence/server-store.test.ts`
- Bridge-specific tests:
  - `lib/browser/evidence-bridge.test.ts`
  - `lib/goal/evidence-bridge.test.ts`
  - `lib/progress/evidence-bridge.test.ts`
  - `lib/subagents/evidence-bridge.test.ts`
  - `lib/workflows/evidence-bridge.test.ts`

Cases:

1. Runtime event append/list:
   - append event with session id
   - list by session
   - list by source
   - preserve createdAt ordering

2. Evidence append/list:
   - add browser evidence
   - add workflow evidence
   - add approval evidence
   - list by session/agent/browser

3. Bridge id stability:
   - same source artifact does not duplicate if re-emitted.

4. Evidence ownership:
   - browser annotation evidence has browser id.
   - subagent result evidence has task id and parent id.
   - workflow artifact evidence has workflow id.
   - approval decision evidence has agent id/session id.

### API Tests

Cases:

1. `/api/agent/:id` can return normalized runtime events.
2. `/api/agent/:id` can return evidence list.
3. Missing agent/session returns clear error or empty list, never 500.

## Phase 4: Productized Panel Regression

### BrowserPanel

Cases:

1. Standalone open:
   - with no live agent, BrowserPanel can open a URL.
   - evidence drawer records manual open.

2. Agent-driven open:
   - agent tool updates same BrowserPanel snapshot model.

3. Screenshot mode:
   - click screenshot.
   - screenshot review appears.
   - click live/reopen.
   - live view returns.

4. Annotation lifecycle:
   - drag select.
   - enter comment.
   - annotation appears with number.
   - evidence item exists.
   - resolve changes status.
   - delete removes it.
   - refresh/reopen preserves backend state when expected.

5. Annotation to agent:
   - feed one annotation.
   - composer receives URL, rect, and comment or evidence reference.
   - agent can call `browser_annotations`.

### GoalTimeline

Cases:

1. Goal with browser evidence:
   - browser verify creates evidence.
   - goal timeline shows browser evidence.

2. Blocked goal:
   - blocked status includes category/unblock action.
   - no infinite auto-resume.

3. Complete goal:
   - no evidence -> verifier rejects.
   - with evidence -> verifier accepts.

### ProgressPopover / Composer

Cases:

1. Progress grouped numbering:
   - replace steps twice.
   - second group starts at 1.

2. Scroll stability:
   - while progress updates repeatedly, message scroll does not jitter.
   - input remains visible.

3. Abort state:
   - progress running + streaming false still shows Stop.
   - clicking Stop marks running/pending failed.
   - backend `abort` pushes progress update.

### Subagent Task View

Cases:

1. Batch lifecycle:
   - queued -> running -> done.
   - UI shows each task status.

2. Result evidence:
   - subagent result appears as evidence.
   - parent final summary can reference it.

3. Worktree merge approval:
   - merge request appears.
   - deny records approval/evidence.
   - worktree is discarded.

### Workflow View

Cases:

1. Workflow run:
   - objective visible.
   - checkpoints visible.
   - artifacts visible.
   - resume affordance visible if interrupted.

2. Policy/approval:
   - network or worktree approval is visible alongside other approval events.

## Phase 5: Electron/Webview/Pet Regression

### Electron Startup

Cases:

1. Start order:
   - `npm run dev`
   - `ELECTRON_DISABLE_PET=1 npm run electron:dev`
   - Electron window loads `Diga Agent`, not Electron default page.

2. Dev server missing:
   - Electron logs clear `ERR_CONNECTION_REFUSED`.
   - user-facing recovery does not create confusing default state if possible.

### Electron BrowserPanel

Cases:

1. Default BrowserPanel uses in-app browser.
2. Browser URL input does not get overwritten when typing into page input.
3. Localhost does not recursively nest the app unless explicitly requested.
4. BrowserPanel can take screenshot.
5. BrowserPanel evidence drawer remains usable.

### Webview PoC

Cases:

1. Open Webview PoC.
2. Set URL to local fixture.
3. `src 加载` produces webContents id.
4. `attach` returns ok.
5. `取标题` returns fixture title.
6. `CDP导航` returns ok.
7. `截图` returns image bytes and renders preview.
8. `CDP点击中心` returns ok.
9. Closing panel detaches/cleans up.

### Pet

Cases:

1. Pet reads normalized runtime events.
2. Switching sessions does not leave pet pointing to stale active agent.
3. Pet stop action uses same abort endpoint and progress closeout.

## Capability Story E2E Matrix

| Story | Priority | Surface | Must pass before release |
| --- | --- | --- | --- |
| Historical session browser standalone preview | P0 | Web + Electron | Yes |
| Agent browser tool chain open/extract/click/wait/verify | P0 | Web + Electron | Yes |
| Annotation create/resolve/delete/feed agent | P0 | Web + Electron | Yes |
| Stop while progress running | P0 | Web + Electron | Yes |
| External site approval allow/deny | P0 | Web + Electron | Yes |
| Sensitive action approval deny | P0 | Web + Electron | Yes |
| Session switch stale runtime guard | P0 | Web | Yes |
| Workflow run/resume artifact evidence | P1 | Web | Yes |
| Subagent batch lifecycle evidence | P1 | Web | Yes |
| Worktree merge approval evidence | P1 | Web | Yes |
| Electron webview CDP PoC | P2 | Electron | No, unless webview promoted |
| Pet normalized runtime state | P2 | Electron | No, unless pet changes |

## Manual Acceptance Checklist

Run this after all automated tests pass.

### Setup

```bash
npm run dev
ELECTRON_DISABLE_PET=1 npm run electron:dev
```

### Browser Workbench

- Open BrowserPanel with no live agent.
- Open `http://localhost:3000/browser-task-fixture.html`.
- Confirm page renders in panel.
- Take screenshot.
- Create annotation.
- Resolve annotation.
- Feed annotation to composer.
- Start agent and ask it to read annotations.

### Agent Browser Tools

Prompt:

```txt
请严格使用 browser tools 分步完成：
1. 打开 http://localhost:3000/browser-task-fixture.html
2. 提取页面内容
3. 点击链接 "Diga Result A"
4. 等待 URL 包含 browser-target-a.html
5. 验证页面上有 "Reached target A" 字样。
不要只描述，必须实际调用 browser_open/browser_extract/browser_click/browser_wait_for/browser_verify。
```

Expected:

- Tool cards appear in order.
- BrowserPanel shows target A.
- Evidence drawer shows each step.
- No duplicated browser run.

### Approval

External:

```txt
请用 browser_open 打开 https://mini-pi-approval-check.invalid/
```

Expected:

- Approval bubble appears.
- Deny returns clear denial.
- Agent does not loop retry.

Sensitive:

```txt
请打开 http://localhost:3000/browser-sensitive-fixture.html 并点击“提交表单”。
```

Expected:

- Sensitive action approval appears.
- Deny prevents form submission.
- Denial text is explicit.

### Progress + Stop

Prompt:

```txt
请做一个较长的三步进度任务：先 update_progress 标记 3 步，然后每步之间等待或执行一个轻量工具。开始后我会点击 Stop。
```

Expected:

- Composer shows Stop while streaming.
- If progress is still running but streaming ends, Stop remains visible.
- Stop marks running/pending progress steps failed/aborted.
- Input returns to normal after stop.

### Electron Webview

- Click BrowserPanel diagnostic.
- Set local fixture URL.
- Click `src 加载`.
- Confirm `wcId`.
- Click `attach`.
- Click `取标题`.
- Click `截图`.
- Click `CDP点击中心`.

Expected:

- All actions return ok.
- URL input is not overwritten by page input typing.

## Automated Test Additions By File

Suggested additions:

```txt
lib/runtime/identity.test.ts
lib/runtime/event-store.test.ts
lib/evidence/server-store.test.ts
lib/browser/evidence-bridge.test.ts
lib/progress/server-store.test.ts
app/api/browser/[id]/route.test.ts
e2e/09-runtime-identity.spec.ts
e2e/10-browser-workbench.spec.ts
e2e/11-progress-abort.spec.ts
e2e/12-evidence-timeline.spec.ts
```

## Release Gates

A release candidate passes only if:

1. `npm run lint` passes.
2. `npx eslint . --max-warnings=0` passes.
3. `npx tsc --noEmit --pretty false` passes.
4. `npm run test` passes.
5. Browser workbench P0 stories pass.
6. Progress Stop P0 story passes.
7. Approval P0 stories pass.
8. Electron smoke passes when Electron code changed.

## Failure Triage Guide

| Symptom | Likely cause | First files to inspect |
| --- | --- | --- |
| BrowserPanel actions disabled in historical session | Runtime identity resolved as agent-only | `lib/runtime/identity.ts`, `app/ChatApp.tsx`, `BrowserPanel.tsx` |
| Browser action runs twice | Preflight path still active or duplicate tool path | `app/api/agent/[id]/route.ts`, `lib/browser/extension.ts` |
| Evidence missing from BrowserPanel | Browser tool did not bridge evidence | `lib/browser/runtime.ts`, evidence bridge |
| Stop disappears while progress running | Composer only checks streaming | `app/ChatApp.tsx`, `app/components/Composer.tsx` |
| Progress remains running after abort | Abort path did not close progress | `app/api/agent/[id]/route.ts`, `lib/progress/server-store.ts` |
| Session switch shows stale browser | browser id not derived from identity | `lib/runtime/identity.ts`, `BrowserPanel.tsx` |
| Electron URL input overwritten | focus/input routing conflict | `InAppBrowserSurface.tsx`, `WebviewPocPanel.tsx`, `BrowserPanel.tsx` |
| Approval deny unclear | denial reason not propagated | `ApprovalBubble.tsx`, `MessageView.tsx`, approval route |

## Final Signoff Template

```txt
Architecture Health Regression Signoff

Date:
Commit:

Static checks:
- lint:
- eslint max warnings:
- tsc:
- vitest:

P0 stories:
- historical standalone browser:
- agent browser tools:
- annotation handoff:
- progress stop:
- external approval:
- sensitive approval:
- session switch stale guard:

Electron:
- startup:
- BrowserPanel:
- Webview PoC:

Known gaps:
- 

Approved for next phase:
- yes/no
```
