# Browser Safety Audit

## Scope

This audit covers Browser Use safety boundaries:

- external-site approval and remembered approvals
- sensitive action confirmation
- repeated failure retry behavior
- local/in-app host readiness failures

## Current State

External-site approval is now scoped when Browser Use is driven by an agent. The approval key is stored as `agent:<agentId>|<origin>` in `allowedScopedOrigins` / `blockedScopedOrigins`, while legacy global `allowedOrigins` / `blockedOrigins` remains available for Settings/UI compatibility.

Runtime calls also re-check site policy using the browser owner derived from `browserId`, so a tool path that bypasses extension-level `guardSite` still cannot reuse another agent's approval.

Sensitive actions still require `requestSensitiveActionApproval` when detected by selector/text.

Repeated browser action failures are no longer prompt-only guidance: the extension tracks repeated failures per agent/tool/target and returns `repeated_browser_action_failed` on the third identical attempt.

## Evidence

- `lib/browser/policy.ts`: scoped allow/block/check APIs.
- `lib/browser/runtime.ts`: `browserPolicyScope(browserId)` passed to `assertBrowserSiteAllowed`.
- `lib/browser/extension.ts`: `guardSite` writes scoped approvals and `runBrowserTool` blocks repeated failures.
- `lib/browser/policy.test.ts`: scoped approvals stay isolated across agents.
- `lib/browser/extension.test.ts`: third identical browser action failure is blocked.

## Residual Risk

The Settings policy UI still edits the legacy global lists. That is acceptable for explicit global administration, but product copy should eventually distinguish global policy from per-session remembered approvals.
