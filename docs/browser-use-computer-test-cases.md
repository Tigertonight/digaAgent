# Browser Use Computer Operation Test Cases

Use this checklist for manual computer-use validation of the in-app BrowserPanel and `browser_*` tools.

## A. Connection And Takeover

1. Send `open https://example.com` before opening BrowserPanel.
   - Expected: error asks the user to open BrowserPanel and click Take over.
2. Open BrowserPanel but do not take over, then retry.
   - Expected: guidance still points to Take over, not a generic connection error.
3. Click Take over, then open `https://example.com`.
   - Expected: URL and title are `https://example.com/` and `Example Domain`.
4. Refresh the app and run another browser action.
   - Expected: either takeover recovers or the UI clearly asks to take over again.

## B. Basic Browsing

5. Open and extract `https://example.com`.
   - Expected: title and short body summary are returned.
6. Navigate `example.com` -> `https://www.iana.org/domains/reserved`.
   - Expected: current page is replaced by IANA, title is correct.
7. Navigate back to `example.com`.
   - Expected: snapshot reflects the new current page.
8. Manually type a URL in BrowserPanel, then ask the agent to inspect the page.
   - Expected: agent reads the manually navigated page.

## C. External-Site Approval

9. First visit to `https://www.iana.org/domains/reserved`.
   - Expected: visible approval card appears in the latest chat area.
10. Click Allow.
   - Expected: the same tool call resumes without resending the prompt.
11. Visit the same origin again in the same session.
   - Expected: no duplicate approval.
12. Visit a new external origin and click Deny.
   - Expected: tool reports user denial and does not retry.
13. Scroll away while approval is pending.
   - Expected: a visible pending-confirmation hint remains available.

## D. Long Pages And Large DOM

14. Extract IANA reserved domains.
   - Expected: returns summary or `partial=true`, not a blank timeout.
15. Extract MDN HTML docs.
   - Expected: title, headings, main text, and actions are available.
16. Extract a table-heavy page.
   - Expected: result is bounded and does not block subsequent tools.
17. Run extract twice after one long extract.
   - Expected: no stale pending command affects the second run.

## E. Network And URL Failures

18. Open `https://example.invalid/browser-use-test`.
   - Expected: structured navigation failure, not success.
19. Extract the invalid-domain page.
   - Expected: Chrome error page is recognized with `chrome-error://chromewebdata/`.
20. Open a malformed URL.
   - Expected: validation error is clear.
21. Approve an external origin that then fails to load.
   - Expected: distinguishes approval success from network failure.

## F. Interactions

22. Search for `Diga Agent GitHub`.
   - Expected: input, Enter, and result extraction work.
23. Click a search result.
   - Expected: URL changes and title is read.
24. Open a local test page and click a button.
   - Expected: state change is verified.
25. Fill a normal form without submitting.
   - Expected: field value changes.
26. Click a submit button.
   - Expected: sensitive-action confirmation appears.
27. Deny the sensitive action.
   - Expected: form is not submitted.
28. Allow the sensitive action.
   - Expected: action continues and approval is logged.

## G. Recovery And Abort

29. Abort during a long extract.
   - Expected: pending browser command is cleared.
30. Immediately send a new `browser_open`.
   - Expected: no stale command affects the new run.
31. Continue normal chat after a browser timeout.
   - Expected: composer remains usable.
32. Close BrowserPanel and run `browser_open`.
   - Expected: stale host message is clear.
33. Reopen BrowserPanel and take over.
   - Expected: retry succeeds.

## H. State Consistency

34. Observe sidebar/runtime while a browser tool is running.
   - Expected: not shown as completed while a tool call is pending.
35. Observe sidebar/runtime while approval is pending.
   - Expected: waiting-user state is visible.
36. Observe after tool timeout.
   - Expected: failed/recoverable state, not infinite "extracting".
37. Simulate SSE reconnect.
   - Expected: messages, approval, and browser evidence stay consistent.
38. Simulate send POST failure.
   - Expected: optimistic user bubble is marked failed or removed.

## I. Evidence And Visuals

39. Inspect evidence after every browser tool.
   - Expected: URL, title, status, and error fields are present.
40. Screenshot failure on an error page.
   - Expected: final URL/error code still exist.
41. BrowserPanel displays `chrome-error://`.
   - Expected: user sees "page failed to load" instead of an empty page.
42. Evidence step list after failures.
   - Expected: timeout/error steps are preserved and do not disappear.
