# Architecture Health Technical Implementation Plan

Date: 2026-06-06

Source: `docs/plans/2026-06-05-architecture-health-roadmap.md`

## Objective

Turn the architecture health roadmap into an implementation plan that hardens diga-agent from a feature-rich agent UI into a reliable agent operating workbench.

The plan focuses on two convergence layers:

1. **Runtime Identity Layer**: one place to answer what persisted session, live agent, browser runtime, workflow run, subagent task, goal, and UI runner are currently related.
2. **Runtime Event + Evidence Layer**: one inspectable event/evidence stream shared by browser, workflow, subagent, goal, approval, and progress surfaces.

This is not a feature expansion sprint. It is a reliability and composability pass.

## Current Baseline

As of 2026-06-06, several items in the original roadmap have already moved forward:

| Area | Current state |
| --- | --- |
| Browser tools | Structured tools exist: `browser_open`, `browser_click`, `browser_type`, `browser_extract`, `browser_verify`, `browser_wait_for`; prompt-time browser preflight has been removed or avoided. |
| Browser identity | `agent:*`, `standalone:*`, and fallback lookup are partially implemented; BrowserPanel standalone mode works but runtime ownership still lives in multiple places. |
| Browser evidence | Browser steps and acceptance evidence exist; the shape is still browser-specific. |
| Annotations | Structured annotations exist with `id`, `rect`, `screenshotDataUrl`, `comment`, lifecycle status, and feed-to-agent behavior. |
| Safety | External-site approval and sensitive-action approval exist. |
| Progress | Progress is grouped and displayed in the message stream; recent fixes addressed scroll jitter and abort/progress state desync. |
| Electron webview | PoC can attach to webContents and drive CDP navigation/screenshot/click; it is not yet the canonical browser runtime. |

Remaining architectural problem:

Feature state is still often inferred from whichever id is available at the call site. That makes bugs likely when a historical session has no live agent, when BrowserPanel is standalone, when a workflow continues in background, or when a progress item outlives the active streaming turn.

## North Star Architecture

```txt
PersistedSession
  -> RuntimeIdentity
       -> AgentRuntime
       -> WorkspaceRuntime
            -> BrowserRuntime
            -> WorkflowRuns
            -> SubagentBatches
            -> GoalRuntime
            -> ApprovalRequests
            -> Progress
            -> Evidence
            -> RuntimeEvents
```

The UI must be able to answer:

- Which persisted session is selected?
- Is there a live agent runtime for it?
- Which browser runtime is attached?
- Which workflows/subagents/goals are active?
- Which evidence belongs to this session, turn, task, workflow, or browser action?
- What can the user inspect, approve, annotate, stop, resume, or replay?

## Data Model

### Runtime Identity

Add a small identity module instead of spreading ownership inference across UI components and API routes.

Suggested file:

- `lib/runtime/identity.ts`

Types:

```ts
export type RuntimeMode = "draft" | "persisted_only" | "live";

export interface RuntimeIdentity {
  mode: RuntimeMode;
  sessionId: string | null;
  sessionPath: string | null;
  cwd: string;
  runnerKey: string;
  agentId: string | null;
  browserId: string;
  goalId?: string | null;
}

export interface RuntimeIdentityInput {
  selectedSessionId: string | null;
  selectedSessionPath: string | null;
  cwd: string;
  activeRunnerKey: string;
  liveAgentId: string | null;
}
```

Rules:

- `sessionId` is persisted history identity.
- `agentId` is only a live SDK runtime identity.
- `runnerKey` is UI runtime-store identity.
- `browserId` is never guessed from UI state directly; it is derived through identity rules:
  - live agent: `agent:${agentId}`
  - selected persisted session with no live agent: `standalone:session:${sessionId}`
  - draft/no selected session: `standalone:default`
  - isolated task browser: `task:${taskId}`
- Features receive `RuntimeIdentity`, not scattered `agentId/sessionId/browserId` props.

### Runtime Event Envelope

Suggested file:

- `lib/runtime/events.ts`

```ts
export type RuntimeEventSource =
  | "agent"
  | "browser"
  | "workflow"
  | "subagent"
  | "goal"
  | "approval"
  | "progress";

export type RuntimeEventStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "blocked"
  | "aborted";

export interface RuntimeEvent<TPayload = unknown> {
  id: string;
  source: RuntimeEventSource;
  type: string;
  status?: RuntimeEventStatus;
  sessionId?: string | null;
  agentId?: string | null;
  browserId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  parentId?: string | null;
  payload: TPayload;
  evidence?: EvidenceRef[];
  createdAt: number;
  updatedAt?: number;
}
```

This is initially a UI-facing normalized envelope. It should not replace mature domain types in one big migration.

### Evidence Model

Suggested file:

- `lib/evidence/types.ts`
- `lib/evidence/server-store.ts`

```ts
export type EvidenceKind =
  | "browser_snapshot"
  | "browser_step"
  | "browser_annotation"
  | "workflow_artifact"
  | "subagent_result"
  | "goal_turn"
  | "approval_decision"
  | "progress_artifact"
  | "log";

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  title: string;
  sessionId?: string | null;
  agentId?: string | null;
  browserId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  url?: string;
  filePath?: string;
  screenshotDataUrl?: string;
  textPreview?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}
```

Store shape:

```ts
interface EvidenceStore {
  bySession: Map<string, EvidenceRef[]>;
  byAgent: Map<string, EvidenceRef[]>;
  byBrowser: Map<string, EvidenceRef[]>;
}
```

MVP storage can be in memory plus existing domain persistence. A later pass can persist evidence envelopes to disk.

## Implementation Phases

### Phase 1: Runtime Identity Convergence

Goal:

Stop individual panels and APIs from inferring ownership from arbitrary ids.

Deliverables:

- Add `lib/runtime/identity.ts`.
- Add `resolveRuntimeIdentity(input)`.
- Add unit tests for live, persisted-only, draft, and task-browser cases.
- Refactor `ChatApp` to compute a `runtimeIdentity` once.
- Pass identity to BrowserPanel, ToolsPanel, Progress, GoalBar, and approval helpers where relevant.
- Make historical session selected with no live agent an explicit UI state.

Likely files:

- `lib/runtime/identity.ts`
- `lib/runtime/identity.test.ts`
- `app/ChatApp.tsx`
- `app/components/BrowserPanel.tsx`
- `app/components/ToolsPanel.tsx`
- `app/components/Composer.tsx`
- `app/hooks/useChatStream.ts`
- `app/hooks/useAgentEvents.ts`

Compatibility rule:

Do not remove existing `agentId`, `browserId`, or `runnerKey` parameters in the first commit. Add `RuntimeIdentity` alongside them, then migrate call sites.

DoD:

- BrowserPanel works in:
  - draft mode
  - selected historical session with no live agent
  - live agent mode
- Switching sessions does not leave BrowserPanel or progress bound to stale agent data.
- Stop button can abort when either streaming or progress is still running.
- Unit tests cover identity derivation.

### Phase 2: Browser Runtime Ownership + Tool Output Contract

Goal:

Make browser use reliably structured and evidence-producing.

Deliverables:

- Define browser tool result shape in `lib/browser/types.ts`.
- Ensure every browser tool returns `{ observation, snapshot, evidence }`.
- Make browser step evidence creation a shared helper.
- Convert annotations into `EvidenceRef` of kind `browser_annotation`.
- Ensure `browser_wait_for` has explicit timeout, condition, and failure evidence.
- Remove any remaining prompt-time browser side effects.

Suggested types:

```ts
export interface BrowserToolResult {
  observation: string;
  snapshot: BrowserSnapshot;
  evidence: EvidenceRef[];
}
```

Likely files:

- `lib/browser/types.ts`
- `lib/browser/runtime.ts`
- `lib/browser/extension.ts`
- `lib/browser/browser-id.ts`
- `app/api/browser/[id]/route.ts`
- `app/components/BrowserPanel.tsx`
- `app/components/InAppBrowserSurface.tsx`

DoD:

- One user prompt causes exactly one browser execution path.
- `browser_open/click/type/extract/verify/wait_for` all produce browser step evidence.
- BrowserPanel timeline can render from evidence, not only local logs.
- Annotation lifecycle creates and updates evidence.
- Standalone browser actions do not require live `agentId`.

### Phase 3: Runtime Event + Evidence Store

Goal:

Normalize domain events without rewriting every subsystem at once.

Deliverables:

- Add `lib/runtime/events.ts`.
- Add `lib/runtime/event-store.ts` with append/list helpers.
- Add `lib/evidence/types.ts`.
- Add `lib/evidence/server-store.ts`.
- Add bridge helpers:
  - browser step -> runtime event + evidence
  - progress update -> runtime event + progress evidence
  - approval request/decision -> runtime event + approval evidence
  - workflow checkpoint/artifact -> runtime event + evidence
  - subagent result -> runtime event + evidence
  - goal turn -> runtime event + evidence
- Extend `/api/agent/[id]` with event/evidence read actions.

Likely files:

- `lib/runtime/events.ts`
- `lib/runtime/event-store.ts`
- `lib/evidence/types.ts`
- `lib/evidence/server-store.ts`
- `lib/goal/evidence-bridge.ts`
- `lib/progress/server-store.ts`
- `lib/subagents/orchestrator.ts`
- `lib/workflows/server-store.ts`
- `app/api/agent/[id]/route.ts`
- `app/hooks/useAgentEvents.ts`

Migration strategy:

- Keep domain-specific stores.
- Add bridges on write paths.
- UI panels can gradually switch to normalized events.

DoD:

- A browser action, approval decision, progress update, subagent result, workflow artifact, and goal turn can all be listed through one normalized event API.
- Event records include enough ids to answer ownership questions.
- Evidence records can be referenced from final messages and timelines.

### Phase 4: Productized Evidence Panels

Goal:

Build visible audit surfaces on top of stable event/evidence data.

Deliverables:

- Browser acceptance panel uses evidence rows.
- Goal timeline can include browser, workflow, and subagent evidence.
- Workflow history shows checkpoint/artifact/evidence links.
- Subagent lifecycle view shows queued/running/done/failed tasks and produced evidence.
- Annotation manager lists open/resolved annotations as evidence.

Likely files:

- `app/components/BrowserPanel.tsx`
- `app/components/GoalTimeline.tsx`
- `app/components/ProgressPopover.tsx`
- `app/components/MessageView.tsx`
- `app/components/SubagentBatchView.tsx` or new `RuntimeTimeline.tsx`
- `app/components/WorkflowHistoryModal.tsx`

UI constraints:

- Avoid adding unrelated floating panels.
- Prefer one timeline/event feed with filters over disconnected duplicated views.
- Keep evidence details inspectable but not always expanded.

DoD:

- User can inspect: what ran, what it did, what evidence it produced, and what failed.
- Browser evidence, goal evidence, workflow artifacts, and subagent results share visual language.
- Final answer can reference evidence ids or titles.

### Phase 5: Electron/Webview/Pet Alignment

Goal:

Make desktop surfaces consume the same runtime/evidence model instead of inventing parallel truth.

Deliverables:

- Pet state consumes normalized runtime events.
- Electron BrowserPanel uses the same browser identity and evidence path as web.
- Decide Webview PoC direction:
  - **Option A: complement** Playwright runtime as a visible Electron surface.
  - **Option B: replacement** for Electron-only browser runtime.
  - **Option C: retire** PoC if it creates a second semantics path.
- If kept, webview tabs map to `browserId` and emit evidence through the same helpers.

Likely files:

- `electron/main.js`
- `electron/preload.js`
- `app/components/WebviewPocPanel.tsx`
- `app/components/InAppBrowserSurface.tsx`
- `app/pet/*`
- `app/hooks/usePetPusher.ts`

DoD:

- Electron-only affordances do not fork browser task semantics.
- Webview actions generate the same evidence/event envelopes as BrowserPanel actions.
- Pet can show running/done/blocked status without maintaining its own session truth.

## Implementation Sequence

Recommended commit sequence:

1. `feat(runtime): add runtime identity resolver`
2. `refactor(chat): pass runtime identity to panels`
3. `feat(browser): standardize browser tool result evidence`
4. `feat(evidence): add evidence store and browser bridge`
5. `feat(runtime): add normalized runtime event store`
6. `feat(progress): bridge progress updates into runtime events`
7. `feat(approval): bridge approval decisions into evidence`
8. `feat(workflow): bridge checkpoints and artifacts into evidence`
9. `feat(subagents): bridge task lifecycle into runtime events`
10. `feat(ui): productize evidence timeline panels`
11. `feat(electron): align webview/pet with runtime events`

Each commit should pass:

```bash
npm run lint
npx tsc --noEmit --pretty false
npm run test
```

UI-impacting commits should also be checked in Electron with Computer Use.

## Risk Register

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Big-bang model migration | Too many mature stores already exist | Add normalized bridges first; do not delete domain stores in early phases. |
| Evidence duplication | Same artifact may be emitted by browser/progress/goal | Use stable ids where possible: `source:id`, `browserStepId`, `workflowArtifactId`. |
| Stale runtime identity | Session switch bugs are currently common | Centralize identity derivation and unit-test mode transitions. |
| Electron webview diverges | Creates second browser semantics | Do not promote PoC until it emits same browser event/evidence shape. |
| UI timeline overload | Evidence feed can become noisy | Add filters by source/status and collapsed details. |
| Abort/progress desync | User loses trust when UI says running after stop | Keep abort path closing progress and emitting an aborted/failed event. |
| Persistence cost | Full evidence persistence can become heavy | MVP stores refs/text/screenshot thumbnails; defer large binary persistence. |

## Open Decisions

1. Should evidence be persisted per session immediately, or bridged in memory first?
   - Recommended: bridge in memory first, persist after schema stabilizes.
2. Should Electron webview replace Playwright browser runtime?
   - Recommended: no decision until Phase 2/3 evidence shape is stable.
3. Should `task:*` browser ids be created for each browser tool sequence?
   - Recommended: start with `agent:*` and `standalone:*`; add `task:*` when replay/multi-tab needs it.
4. Should RuntimeEvent become the canonical SSE event shape?
   - Recommended: not initially. Keep current SSE events, add normalized derived events.

## Final Acceptance

The hardening pass is complete when:

- A selected session has one resolved runtime identity.
- BrowserPanel works with and without a live agent.
- Browser tools produce normalized evidence.
- Progress, approval, browser, workflow, subagent, and goal events can be inspected through one normalized API.
- User-facing panels answer:
  - what is running
  - what happened
  - what evidence proves it
  - what is blocked
  - what can be resumed, annotated, approved, stopped, or replayed
