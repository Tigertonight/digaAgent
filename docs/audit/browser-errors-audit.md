# Browser Errors Audit

## Scope

This audit covers Browser Use error behavior:

- validation errors before dispatch
- timeout/error snapshots
- cleanup/dispose behavior
- user-facing structured tool failures

## Current State

Invalid `browser_click` and empty `browser_wait_for` inputs fail before dispatch with `invalid_params`.

Browser runtime errors include snapshots and error codes. `failedToolResult` maps runtime errors into structured evidence fields such as `ok`, `errorCode`, `errorMessage`, `finalUrl`, `browserStatus`, `durationMs`, and `recoverable`.

`disposeBrowser` classifies expected `browser_host_disconnected` cleanup as non-fatal and logs unexpected cleanup failures. Agent disposal now awaits `disposeBrowser(agentBrowserId(id))`, so cleanup is part of the dispose lifecycle rather than fire-and-forget.

## Evidence

- `lib/browser/runtime.ts`: `invalidParamsError`, `validateClickInput`, `validateWaitForInput`, and classified cleanup in `disposeBrowser`.
- `lib/browser/extension.ts`: `failedToolResult` maps failures into structured evidence.
- `lib/agent-registry.ts`: `disposeAgent` awaits browser cleanup.
- `lib/browser/runtime.test.ts`: invalid click/wait_for inputs are rejected before host dispatch.

## Residual Risk

In-app host state can still disappear asynchronously when the BrowserPanel closes. The expected behavior is structured failure plus recoverable guidance, not silent success.
