# Dynamic Workflows

Dynamic workflows let the main agent generate a task-specific JavaScript
orchestrator, then run that orchestrator in a restricted workflow runtime. The
runtime can fan out to child agents, validate structured outputs, checkpoint
state, save artifacts, and resume from earlier runs.

Use workflows when a task benefits from more compute, independent contexts, or
verification. For ordinary edits or short questions, a normal agent turn is
usually cheaper and clearer.

## Core Runtime

The main tool is `run_workflow_script`. The script body receives a restricted
`workflow` SDK:

```js
const review = await workflow.agent("Audit auth.ts", {
  title: "Auth audit",
  agentType: "reviewer",
  schema: {
    type: "object",
    required: ["bugs"],
    properties: {
      bugs: {
        type: "array",
        items: { type: "string" }
      }
    }
  }
});

workflow.artifact("auth-review", review.data);
return review.data;
```

The worker process cannot use `import`, `require`, `process`, `fs`, shell, or
network APIs directly. External work must go through the parent-controlled
workflow SDK, so capability approval, tool allowlists, abort, timeout, tracing,
and persistence stay centralized.

## Six Patterns

`workflow.patterns` includes helpers for the common dynamic workflow shapes:

| Pattern | Helper | Use when |
|---|---|---|
| Classify and act | `workflow.patterns.classifyAndAct` | A request needs routing before execution |
| Fan out and synthesize | `workflow.patterns.fanOutAndSynthesize` | Many independent slices can run in parallel |
| Adversarial verification | `workflow.patterns.adversarialVerify` | A result needs an independent critic |
| Generate and filter | `workflow.patterns.generateAndFilter` | You want many candidates and a quality gate |
| Tournament | `workflow.patterns.tournament` | Pairwise comparison is more reliable than scoring |
| Loop until done | `workflow.patterns.loopUntilDone` | The amount of work is unknown, but a stop condition is clear |

Prefer explicit stop conditions for loops, such as "no new failing tests" or
"no new unverified claims". The default max iteration guard is a safety net, not
the definition of done.

## Templates

Reusable workflows live in the local template registry:

```text
~/.mini-pi/workflows/templates/<templateId>.json
```

The HTTP registry API is:

```text
GET    /api/workflows/templates
GET    /api/workflows/templates?id=<templateId>
POST   /api/workflows/templates
DELETE /api/workflows/templates?id=<templateId>
```

Template runs use `run_workflow_template`. The runtime merges
`defaultParams` with call-time `params`, validates the merged value against
`paramsSchema`, then exposes it as `workflow.params`. Template metadata is
available as `workflow.template`.

Minimal template envelope:

```json
{
  "id": "quick-adversarial-review",
  "name": "Quick Adversarial Review",
  "version": "1.0.0",
  "description": "Review a short report with an independent critic.",
  "capabilities": ["spawn_agent", "read_files"],
  "paramsSchema": {
    "type": "object",
    "required": ["subject"],
    "properties": {
      "subject": { "type": "string" }
    }
  },
  "defaultParams": {},
  "script": "const subject = workflow.params.subject; const draft = await workflow.agent(`Review ${subject}`, { title: 'Primary reviewer', agentType: 'reviewer' }); const verdict = await workflow.patterns.adversarialVerify({ result: draft.text, verifier: (text) => workflow.agent(`Critique this review:\\n${text}`, { title: 'Adversarial verifier', agentType: 'verifier' }) }); workflow.artifact('adversarial-review', verdict); return verdict;"
}
```

Example templates are stored in
`docs/examples/workflow-templates/`. To install one locally, POST the file to the
template API or place the template object in the registry shape used by
`~/.mini-pi/workflows/templates`.

## Goal Mode And Looping

`/goal <objective>` is the durable loop for long-running workflow work:

1. The active goal is stored in `~/.mini-pi/goals/<agentId>.json`.
2. Each agent turn opens and closes a goal turn record.
3. If the goal remains active after a turn, the runtime automatically prompts
   the agent to continue the next useful step.
4. `goal_update complete` is accepted only when the verifier sees concrete
   evidence and no unresolved failed or aborted workflow runs.
5. Repeated blockers are tracked in `blockedState`; the runtime pauses instead
   of retrying the same blocker forever.

For repeatable long-running tasks, start a goal whose objective names the
template and parameters, for example:

```text
/goal Run the deep-research workflow template for "workflow mode parity",
verify every factual claim, record artifacts, and finish only after tests pass.
```

Inside the goal, the agent should prefer `run_workflow_template` when a saved
template matches the task. The workflow artifacts and logs then become evidence
for the goal timeline and completion verifier.

## Inspector

Workflow history exposes a per-run Inspector. It reads:

```text
GET /api/agent/:agentId/workflows?id=<workflowId>&debug=1
```

The returned debug bundle contains:

- workflow summary and manifest
- resume snapshot
- script
- trace events
- logs
- artifacts
- checkpoints
- return value

Use this view to diagnose agent laziness, goal drift, schema failures,
capability approvals, worktree isolation, and failed merges.

## Skill Distribution

For repeatable organization workflows, distribute a skill that points agents at
the saved template instead of embedding a large script in prompt text. A minimal
`SKILL.md` can look like:

```markdown
---
name: workflow-triage
description: Use when triaging a queue of bugs, support tickets, or review items with the saved workflow template.
---

# Workflow Triage

When this skill applies:

1. Call `run_workflow_template` with `templateId: "triage-queue"`.
2. Pass queue-specific inputs as structured `params`.
3. Inspect workflow artifacts before summarizing.
4. If the task is long-running, keep it under `/goal` and only mark complete
   after evidence is recorded.
```

Keep skill workflows template-oriented. Let the agent adapt parameters and final
synthesis, but keep the orchestration code in the registry so it can be tested,
versioned, and inspected.

## Acceptance Checklist

- `run_workflow_script` can spawn agents, checkpoint, artifact, resume, and emit
  trace events.
- `workflow.agent` supports `schema`, `agentType`, `tools`, `maxTurns`,
  `timeoutMs`, and `isolation: "worktree"`.
- `workflow.patterns` exposes all six dynamic workflow patterns.
- `run_workflow_template` validates params against `paramsSchema` before
  execution.
- Workflow history can inspect debug bundles.
- `/goal` keeps long work moving and rejects completion without evidence.
- Docs and example templates describe how to package repeatable workflows into
  skills.
