# mini-pi-web Architecture Health Roadmap

Date: 2026-06-05

This note captures the current architecture health assessment for mini-pi-web and turns it into a follow-up hardening plan. The project has moved beyond a small demo: it is already an agent workbench with chat, sessions, browser use, workflows, subagents, goals, approvals, Electron, and persistence. The next step is not simply adding more features, but tightening the runtime model and evidence model so the existing capabilities become reliable, inspectable, and composable.

## Executive Summary

mini-pi-web has several strong first versions, but some of them are still in the "functional but not productized" stage. The biggest architecture need is convergence:

1. A **Runtime Identity Layer** that clearly separates persisted sessions, live agents, browser runtimes, workflow runs, subagent tasks, and UI runner keys.
2. A unified **Evidence/Event Layer** that normalizes browser, workflow, subagent, goal, approval, and progress events into one inspectable stream.

Without these two layers, each new capability will keep re-solving ownership questions such as whether state belongs to `sessionId`, `agentId`, `browserId`, `taskId`, `workflowId`, `runnerKey`, or a file path.

## Current Maturity Map

| Area | Current maturity | Diagnosis |
| --- | --- | --- |
| Chat UI and basic agent session | Medium-high | Usable, broad, but still centralized around a large app-level coordinator. |
| Session persistence and search | Medium-high | Strong knowledge layer direction, but live runtime identity remains separate from restored history. |
| Browser use | Medium | Runtime and panel exist, but full Codex-style visual acceptance loop is not yet mature. |
| Subagents | Backend medium-high, UX medium-low | Orchestration is ambitious; lifecycle visualization and artifact/evidence surfacing need productization. |
| Workflows | Backend medium-high, UX medium | Script runtime, checkpoints, resume, and policy exist; still feels like an advanced mode rather than a natural task escalation. |
| Goal and budget | Medium | Good concepts, but goal progress, evidence, browser results, workflow artifacts, and subagent results need one task-management shell. |
| Tool approval and progress | Medium | Works as separate mechanisms; lacks a shared event protocol across runtime features. |
| Electron, desktop pet, webview PoC | Experimental | Valuable experiments, but should not outrun the core browser/runtime architecture. |
| Testing | Medium | Good unit and e2e base; needs more end-to-end capability stories. |

## Key Architecture Gaps

### 1. Browser Use Is Not Yet A Full Visual Acceptance Workbench

Existing strengths:

- Playwright-backed browser runtime.
- Browser snapshot state.
- Screenshot, screencast, input replay, and BrowserPanel.
- Browser API actions.
- Site policy.
- Logs and steps.

Missing or immature pieces:

- Structured `browser_*` tools need to fully replace prompt preflight browser execution.
- Browser tool output should consistently return `{ observation, snapshot, evidence }`.
- Browser task execution needs multi-step planning, step-level failure recovery, and explicit wait semantics.
- BrowserPanel logs and steps should become a real acceptance evidence panel.
- User annotations should be stored as first-class evidence, not only inserted as text.
- `agent`, `standalone`, and `task` browser identities need strict lifecycle ownership.

Target state:

Browser use should become a shared visual workbench where the user and agent can preview, operate, annotate, verify, and replay web app behavior.

### 2. Session Runtime Identity Is Too Implicit

The current system has many related identifiers:

- persisted `sessionId`
- live `agentId`
- session file path
- `runnerKey`
- `browserId`
- workflow id
- subagent task id
- goal id

The historical-session vs live-agent split already showed up as a practical bug: BrowserPanel could open but actions were disabled when no live `agentId` existed.

Target model:

```txt
SessionRecord
  Persisted conversation history, metadata, cwd, path, title, search index.

AgentRuntime
  Live SDK session, model, SSE stream, tools, approvals, progress, current turn.

WorkspaceRuntime
  Shared runtime resources attached to a session/thread/workspace:
  browser, workflows, subagents, goals, artifacts, evidence.
```

The UI should be able to answer these questions mechanically:

- Which persisted session is selected?
- Is there a live agent runtime for it?
- Which browser runtime is attached?
- Which tasks or workflows are currently active?
- Which evidence belongs to this session vs this turn vs this task?

### 3. Events Are Fragmented Across Capabilities

Current feature families emit or store their own shapes:

- `browser_state`
- approval events
- progress updates
- goal events
- workflow events
- subagent events
- SSE agent messages

This works locally, but makes the UI understand too many special protocols.

Target event envelope:

```ts
interface RuntimeEvent<TPayload = unknown> {
  id: string;
  source: "agent" | "browser" | "workflow" | "subagent" | "goal" | "approval" | "progress";
  type: string;
  status?: "queued" | "running" | "done" | "error" | "blocked";
  sessionId?: string;
  agentId?: string;
  browserId?: string;
  taskId?: string;
  workflowId?: string;
  parentId?: string;
  payload: TPayload;
  evidence?: EvidenceRef[];
  createdAt: number;
  updatedAt?: number;
}
```

This should not necessarily replace every domain type immediately. It can first become the normalized UI-facing envelope.

### 4. Evidence Is Not Yet A First-Class Cross-Cutting Layer

Browser screenshots, workflow artifacts, subagent outputs, goal turns, approval decisions, and progress artifacts are all evidence-like. Today they are surfaced in separate places.

Target evidence object:

```ts
interface EvidenceRef {
  id: string;
  kind:
    | "browser_snapshot"
    | "browser_step"
    | "browser_annotation"
    | "workflow_artifact"
    | "subagent_result"
    | "goal_turn"
    | "approval_decision"
    | "log";
  title: string;
  url?: string;
  filePath?: string;
  screenshotDataUrl?: string;
  textPreview?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}
```

The same evidence layer should feed:

- BrowserPanel step timeline.
- Goal timeline.
- Workflow history.
- Subagent task view.
- Final answer summaries.
- Future review or acceptance pane.

## Capability-Specific Hardening Notes

### Browser Use

Recommended next steps:

1. Remove prompt-time `parseBrowserIntent` side effects from `/api/agent/[id]/route.ts`.
2. Route browser behavior only through structured `browser_*` tools.
3. Standardize each browser tool return as `{ observation, snapshot, evidence }`.
4. Add or harden `browser_wait_for`.
5. Convert BrowserPanel logs and steps into evidence-backed timeline rows.
6. Store annotations as structured browser evidence.
7. Make browser runtime ownership explicit through `browserId`, with `agent:*`, `standalone:*`, and `task:*` prefixes.

Acceptance criteria:

- A prompt that asks to use the browser triggers exactly one browser execution path.
- Every browser action produces one step event and one evidence item.
- BrowserPanel can work without a live agent.
- Agent browser use and user manual preview share the same snapshot model.

### Multi-Session Runtime

Recommended next steps:

1. Create a small runtime identity module that maps selected session, live agent, browser runtime, and runner key.
2. Stop making individual features infer ownership from whichever id is available.
3. Make restored historical sessions explicitly "persisted only" until resumed.
4. Add a visible UI state for "history selected, no live agent yet".

Acceptance criteria:

- Switching sessions never leaves BrowserPanel, ToolsPanel, approvals, or progress bound to a stale agent.
- A historical session can expose preview/browser/comment features without requiring an agent runtime.
- Starting or resuming an agent updates the runtime identity in one place.

### Subagents

Recommended next steps:

1. Add a task lifecycle view for subagents: queued, running, blocked, done, failed.
2. Store subagent outputs as evidence.
3. Surface write-boundary and merge decisions as approval/evidence records.
4. Show parent-child relationships in the same event timeline used by workflows and goals.

Acceptance criteria:

- A user can inspect what each subagent was asked to do, what it produced, and what changed.
- Subagent results can be referenced by the main agent as structured evidence.
- Merge or write-boundary approvals are auditable.

### Workflows

Recommended next steps:

1. Treat workflows as long-running task escalation, not a separate hidden mode.
2. Normalize checkpoints and artifacts into the evidence layer.
3. Show workflow events in the same runtime event stream.
4. Make resume state visible in the main task UI.

Acceptance criteria:

- A workflow run has a clear objective, status, checkpoints, artifacts, and resume affordance.
- Workflow artifacts can feed goal completion and final answer evidence.
- Network and worktree approvals are visible alongside other approval events.

### Goal And Budget

Recommended next steps:

1. Bind goals to the normalized runtime identity.
2. Let goals consume browser, workflow, and subagent evidence.
3. Show why a goal is advancing, blocked, or complete.
4. Make budget interruption explain what evidence exists and what remains.

Acceptance criteria:

- Goal timeline can show browser steps, workflow artifacts, and subagent results.
- Blocked status includes concrete missing input or failed capability.
- Budget guards can pause work without losing the ability to resume from evidence.

### Electron, Pet, And Webview PoC

Recommended next steps:

1. Keep Electron and pet features downstream of the runtime event model.
2. Do not let pet state invent its own session truth.
3. Decide whether webview is a replacement for or complement to the Playwright/screencast BrowserPanel after browser evidence is stable.

Acceptance criteria:

- Pet UI consumes normalized session/runtime events.
- Electron-only affordances do not fork browser task semantics.
- Webview PoC has a clear migration or retirement decision.

### Testing

Recommended next steps:

1. Add capability-story e2e tests instead of only isolated component/API tests.
2. Cover browser standalone preview.
3. Cover agent-driven browser tool execution.
4. Cover annotation-to-agent handoff.
5. Cover historical session selected with no live agent.

Example acceptance story:

```txt
start app
select historical session
open BrowserPanel
open localhost manually
verify screenshot/live preview appears
create annotation
ensure composer receives structured annotation text or evidence reference
start agent
agent uses browser tools
verify BrowserPanel receives step timeline and evidence
```

## Recommended Priority Order

### Phase 1: Runtime Identity Convergence

Deliverables:

- `browserId` fully decoupled from `agentId`.
- Runtime identity helper for selected session, agent runtime, browser runtime, and runner key.
- BrowserPanel standalone mode is explicit and tested.

Why first:

This prevents every downstream feature from re-creating the same ownership logic.

### Phase 2: Structured Browser Tools

Deliverables:

- `browser_open`
- `browser_click`
- `browser_type`
- `browser_extract`
- `browser_verify`
- `browser_wait_for`
- Unified `{ observation, snapshot, evidence }` tool output.
- Removal of prompt-time browser preflight side effects.

Why second:

This is the capability jump from "browser panel exists" to "agent can use browser reliably".

### Phase 3: Evidence/Event Layer

Deliverables:

- Runtime event envelope.
- Evidence object model.
- Browser steps, workflow artifacts, subagent results, goal turns, and approvals represented as evidence.

Why third:

Once browser tools produce consistent evidence, the rest of the system can converge on the same model.

### Phase 4: Productized Evidence Panels

Deliverables:

- Browser acceptance panel.
- Goal evidence timeline.
- Workflow/subagent task timeline.
- Annotation manager.

Why fourth:

The UI should be built on stable event/evidence data, not before it.

### Phase 5: Advanced Surface Integration

Deliverables:

- Electron/pet state consumes normalized runtime events.
- Webview PoC decision.
- Long-running workflow/goal resume experience.

Why fifth:

These surfaces become much easier once the core workbench model is stable.

## Non-Goals For The Next Hardening Pass

- Do not add more isolated UI panels before converging event/evidence shape.
- Do not create another browser execution path parallel to structured tools.
- Do not make Electron or webview semantics diverge from web BrowserPanel semantics.
- Do not make subagents or workflows write directly into UI-specific state.
- Do not bind new runtime features only to `agentId`.

## Architectural North Star

mini-pi-web should become an agent operating workbench:

```txt
Persisted Session
  -> Live Agent Runtime
  -> Workspace Runtime
       -> Browser
       -> Workflows
       -> Subagents
       -> Goals
       -> Approvals
       -> Evidence
```

The user should always be able to answer:

- What is running?
- What did it do?
- What evidence proves it?
- What is blocked?
- What can I inspect, annotate, approve, resume, or replay?

That is the line between a capable chat UI and a mature agent workbench.
