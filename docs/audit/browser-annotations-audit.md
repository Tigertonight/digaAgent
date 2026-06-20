# Browser Annotations Audit

## Scope

This audit covers BrowserPanel page annotations consumed by agent tools:

- listing pending annotations for the active agent/session browser set
- resolving annotations by id
- preventing cross-session or cross-agent annotation resolution

## Current State

Annotation listing only scans browser ids returned by `annotationBrowserIds(agentId, extraBrowserIds)`.

Resolution now uses the same scoped lookup and fails if the annotation id is not found in the current agent/session browser set. It no longer silently falls back to `agentBrowserId(agentId)`, which previously could make an incorrect "resolved" response appear successful while not resolving the requested annotation.

## Evidence

- `lib/browser/extension.ts`: `findAnnotationBrowserId` throws when the annotation id is not found in the scoped browser id list.
- `lib/browser/extension.test.ts`: annotation created under another agent is rejected for the current agent.

## Residual Risk

`standalone:default` is still included as a compatibility fallback for older BrowserPanel flows. Session-specific standalone ids are preferred and ordered before the default fallback.
