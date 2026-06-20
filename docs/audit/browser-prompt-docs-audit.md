# Browser Prompt And Docs Audit

## Scope

This audit covers Browser Use instructions exposed to agents and humans:

- tool prompt guidelines
- schema descriptions
- user-facing test documentation
- recovery guidance for repeated failures

## Current State

Tool schema descriptions document key constraints:

- `browser_click` requires selector or coordinates, not both.
- `browser_wait_for` requires exactly one of URL, selector, or text.
- tab switching indexes are zero-based and `tabId` is preferred.
- `browser_wait` empty input is only a short sleep and should not be used for readiness.
- in-app tab switching may reload URL state.

The prompt now tells agents to stop after two repeated failures, and the tool layer enforces this with `repeated_browser_action_failed`.

The manual computer-operation test set is recorded in `docs/browser-use-computer-test-cases.md`.

## Evidence

- `lib/browser/extension.ts`: prompt guidelines and tool schemas for browser tools.
- `lib/browser/extension.test.ts`: retry gate hard enforcement.
- `docs/browser-use-computer-test-cases.md`: richer Browser Use computer-operation test cases.

## Residual Risk

The browser prompt surface is large and evolves with new tools. New browser tools should add schema-level constraints and an explicit negative/recovery test before being considered stable.
