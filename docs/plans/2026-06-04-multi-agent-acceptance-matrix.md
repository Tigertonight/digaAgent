# Multi-Agent Acceptance Matrix

> Date: 2026-06-04
> Scope: `delegate_subagents` -> planner/policy -> orchestrator -> worker -> verifier -> synthesizer -> audit UI.

## Goal

Prove that the current multi-agent system is no longer just parallel tool calls. A passing build must show that a parent agent can create a subagent batch, persist it, recover it, retry or continue work, verify task quality, synthesize safe guidance, and expose an audit trail in UI/state.

## Automated Gates

| Gate | Command | Evidence |
|---|---|---|
| Type safety | `npx tsc --noEmit` | All subagent API, UI, reducer, and tool result shapes compile. |
| Unit/integration | `npm test` | Orchestrator, store, reducer, extension, workflow safety tests pass. |
| Targeted subagent tests | `npm test -- lib/subagents/planner.test.ts lib/subagents/orchestrator.test.ts lib/subagents/extension.test.ts lib/chat-reducer.test.ts` | Covers heuristic planning, execute, persist, retry, resume, verify, synthesize, restore. |
| Subagent UI E2E | `npx playwright test e2e/08-subagents.spec.ts` | Mock SSE drives batch/task events; UI shows planner, verifier, synthesis, expanded answer, session file, retry action, restored batch, sidebar child count, child-session open action, and continue action. |

## Capability Matrix

| Capability | Required Evidence | Current Automated Evidence |
|---|---|---|
| Planner / policy | Main agent can ask a planner before delegation; batch stores `planning.status`, task count, requested/actual concurrency, warnings. | `lib/subagents/planner.test.ts` validates heuristic fan-out recommendations; `lib/subagents/extension.test.ts` validates `plan_subagents`; `lib/subagents/orchestrator.test.ts` validates clamping and persisted planning. |
| Tool visibility | Main agent receives planner recommendation, planning, and synthesis guidance in tool result text/details. | `lib/subagents/extension.test.ts` validates `plan_subagents`, `## Planning policy`, `## Synthesis guidance`, and details payload. |
| Parallel execution | Batch creates child agents and returns per-task results. | `lib/subagents/orchestrator.test.ts` lifecycle test. |
| Runtime cleanup | Child runtime is disposed after task completion. | `disposeChild` assertion in orchestrator lifecycle test. |
| Persistence | Batch/task metadata writes to `~/.diga-agent/subagents/batches/*.json`. | Store hydration assertions in orchestrator tests. |
| Restore by session | Historical session context can restore persisted batches by `parentSessionPath`. | `appendRestoredSubagentBatches` reducer tests, context API wiring, and `e2e/08-subagents.spec.ts` restored-session flow. |
| Retry one task | A single task can rerun while preserving prior attempt. | `retrySubagentTask` test asserts attempts and metadata update. |
| Continue unfinished batch | Restored unfinished batch can rerun pending/running tasks by session ownership. | `resumeSubagentBatch` test asserts interrupted attempt and new parent id; `e2e/08-subagents.spec.ts` verifies cold restored UI creates a parent agent with the original `sessionPath` before POSTing `resume`. |
| Audit trail | Prior runs are retained as `attempts[]`; batch lifecycle is persisted as structured `auditEvents[]`. | Retry/resume tests assert previous completed/interrupted attempts; orchestrator tests assert batch/task/retry/resume/verify/synthesize audit events; `e2e/08-subagents.spec.ts` verifies audit UI for live and restored batches. |
| Verifier | Task and batch verification are persisted and surfaced; batch verifier checks coverage, terminal state, unique ids, and obvious cross-task conflicts. | Orchestrator and reducer tests assert `verification.status`; orchestrator conflict test asserts `cross-task-conflicts` warning. |
| Synthesizer | Batch synthesis separates usable/caution/rejected task ids. | Orchestrator, reducer, and extension tests assert `synthesis`. |
| Write boundary policy | Write-capable subagent tools require declared `writePaths`; unsafe write tools are removed before child creation, and child runtime blocks write/edit/patch targets outside the boundary before tool execution. | `lib/subagents/orchestrator.test.ts` validates stripping unsafe tools, passing bounded write paths, prompt boundary, and audit event; `lib/subagents/write-boundary.test.ts` validates file, directory, outside-boundary, missing-boundary, and `apply_patch` path parsing. |
| Child continuation | Completed child task sessions can be opened from the parent audit card for deeper follow-up. | `e2e/08-subagents.spec.ts` verifies the child-session open action switches the active runner to the child session path. |
| UI expansion | Subagent cards show planning, verification, synthesis, answer, session file, retry/continue actions. | `e2e/08-subagents.spec.ts` verifies planner/synthesis/answer/session/retry and restored Continue. |
| SSE continuity | Parent receives batch/task start/end updates and reducer merges them. | Reducer tests cover task and batch events; `e2e/08-subagents.spec.ts` drives the same events through the page SSE bridge. |

## Manual Browser Acceptance

Use the in-app browser at `http://localhost:3000/`.

1. Start a parent session with a prompt that explicitly requests 3+ independent subagents.
2. Confirm a `Subagents` card appears under the parent assistant message.
3. Expand a task and confirm answer body, session file, verification badge, and retry button are visible.
4. Confirm the card header shows Planner, Verifier, and Synthesis state.
5. Reload or reopen the session and confirm the restored subagent card appears.
6. If restored card has unfinished tasks, click `Continue` and confirm task events stream back into the same card.
7. Click retry on a completed/failed task and confirm:
   - task starts again,
   - previous answer is retained as an attempt,
   - final task answer updates,
   - verifier/synthesis badges update.
8. Confirm child sessions are grouped under the parent in sidebar, not shown as unrelated top-level sessions.

## Known Remaining Risks

| Risk | Status | Next Step |
|---|---|---|
| Full restored-session browser acceptance | Mitigated | Playwright now covers restored Continue and sidebar child count; still use in-app Browser plugin when available for final visual acceptance against `http://localhost:3000/`. |
| Verifier is deterministic, not LLM-judged | Mitigated | Deterministic verifier now checks task quality and cross-task conflicts; next step is optional LLM verifier that writes into the same verification model. |
| Planner is heuristic, not LLM-autonomous | Mitigated | `plan_subagents` provides rule-based pre-delegation recommendations; next step is optional LLM JSON planner using the same recommendation shape. |
| Write boundary is not OS sandboxed | Mitigated | SDK `tool_call` path guard now blocks write/edit/patch targets outside declared `writePaths`; next step is optional OS-level sandboxing for shell commands that can write indirectly. |
| Child continuation UX is basic session switching | Mitigated | Parent card can open the child session; next step is a dedicated follow-up composer that preloads a child-specific continuation prompt. |
