# Diga Agent Product Language

This document is the source of truth for product language in Diga Agent.
It complements `docs/design-tokens.md`: visual tokens define how the product
looks; product language defines how the product speaks.

The goal is to make every state legible. Users should know whether Diga Agent
is working, waiting, blocked, recovering, or done without reading raw HTTP
codes, SDK errors, internal variable names, or network diagnostics.

## References

These references inform the language system, but Diga Agent should keep its own
voice as a focused agent/cowork workspace.

- OpenAI Codex mobile: live state, approvals, context, model changes, and
  cross-device work need clear status feedback.
- Replit Agent: use everyday language for agent capabilities, planning, task
  progress, testing, checkpoints, and recovery.
- Atlassian message guidance: message type, component, icon, color, and urgency
  should match.
- NN/g content standards: content rules belong inside the design system, not in
  scattered review comments.
- Fluent 2 tokens: semantic naming helps teams apply consistent meaning across
  platforms.
- GitHub Primer: product UI should be governed through foundations, accessible
  primitives, icons, and reusable components.

## Principles

1. Be clear before being clever.
   Use simple Chinese for task state and next steps. Keep English for product
   names, model names, protocol names, file paths, commands, and code.

2. Name the state, then give the action.
   A blocked user should see what happened and what to do next. Avoid messages
   that only say "failed".

3. Hide implementation details by default.
   Do not show `401`, `403`, `HTTP 500`, `load failed`, stack traces, SDK
   exceptions, internal ids, or env var names in primary UI. Put diagnostics in
   logs, details, or debug-only surfaces.

4. Keep agent work reviewable.
   Execution, approval, clarification, retries, and recovery should read as a
   continuous timeline. Do not make the user guess whether the agent is waiting
   for them.

5. Prefer stable nouns.
   Use the same words for the same concepts across desktop, mobile, settings,
   menus, and empty states.

6. Be concise on mobile.
   Mobile labels should be shorter than desktop labels. Keep the full reason in
   expandable detail or a secondary line.

## Voice And Tone

Diga Agent should sound professional, calm, and collaborative. It is a capable
workbench, not a marketing assistant and not a character.

- Voice: precise, steady, helpful.
- Tone: neutral by default; firmer for risk; lighter for successful completion.
- Sentence shape: short title plus one actionable sentence.
- Avoid: hype, blame, jokes in critical states, exaggerated confidence,
  anthropomorphic claims, and vague reassurance.

Examples:

| Use | Avoid |
| --- | --- |
| `需要重新扫码` | `鉴权失败` |
| `公网连接不可用` | `load failed` |
| `模型账号需要配置` | `provider auth failed` |
| `等待你确认` | `pending approval` |
| `状态已变化，请刷新后重试。` | `404 not found` |

## State Language

Use these states consistently across PC and mobile.

| State | Primary label | Message pattern | Tone |
| --- | --- | --- | --- |
| Loading | `正在加载` | `正在读取当前会话…` | neutral |
| Idle | `任务空闲` | `可以开始新任务或继续当前会话。` | neutral |
| Streaming | `执行中` | `Agent 正在处理任务。` | neutral |
| Thinking | `思考中` | `正在整理下一步。` | muted |
| Tool running | `正在执行工具` | `正在运行 {tool}。` | neutral |
| Waiting approval | `等待你确认` | `需要你确认后才能继续。` | warning |
| Waiting clarification | `需要补充信息` | `请选择下一步或补充说明。` | warning |
| Reconnecting | `网络恢复中` | `正在恢复和电脑端的连接。` | warning |
| Failed | `操作失败` | `操作没有完成，请稍后重试。` | danger |
| Completed | `已完成` | `任务已完成，可以继续追问或查看结果。` | success |
| Aborted | `已停止` | `任务已停止，没有继续执行。` | muted |

Status labels should be short. Put details in secondary text or expandable
content.

## Error Language

Every user-facing error should contain:

1. What happened.
2. Why it may have happened, when useful.
3. What the user can do next.

Use `lib/user-facing-error.ts` as the first implementation baseline.

| Code | Title | Message | Action |
| --- | --- | --- | --- |
| `pairing_required` | `需要重新扫码` | `当前移动端授权已失效，请回到电脑端重新生成二维码并扫码连接。` | `重新扫码` |
| `remote_unreachable` | `网络恢复中` | `暂时无法连接电脑端，请确认电脑端 Diga Agent 已开启，并稍后重试。` | `重试` |
| `public_unavailable` | `公网连接不可用` | `公网通道暂时不可达，请刷新、重新扫码，或让手机和电脑切换到同一 Wi-Fi 后重试。` | `重试` |
| `not_found` | `状态已变化` | `当前会话或资源已变化，请刷新后重试。` | `刷新` |
| `rate_limited` | `请求过于频繁` | `模型服务暂时限流，请稍后再试，或切换其他模型。` | `稍后重试` |
| `model_auth_missing` | `模型账号需要配置` | `当前没有可用模型或凭证不可用，请到设置里的“模型与账号”完成配置。` | `去设置` |
| `server_busy` | `服务暂时不可用` | `电脑端服务正在恢复，请稍后刷新重试。` | `刷新` |
| `unknown` | `操作失败` | `操作没有完成，请稍后重试。` | `重试` |

Rules:

- Primary UI must not expose raw network status codes.
- If a diagnostic code is useful, place it under "详细信息" or debug output.
- Never blame the user. Say what to do, not what they did wrong.
- If recovery is automatic, say so: `正在恢复连接…`.
- If the user must act, make the action visible: `重新扫码`, `刷新`, `去设置`,
  `确认`, `停止`.

## Component Copy

Component language should match the visual component and urgency.

| Component | Use for | Copy rules |
| --- | --- | --- |
| Badge / StatusPill | Short state | 2-6 Chinese characters where possible: `已连接`, `执行中`, `需确认`. |
| Button | Clear action | Verb first: `刷新`, `保存`, `删除`, `重新扫码`, `停止任务`. |
| Menu item | Direct command | No subtitle by default. Use one action per row. |
| Toast / Flag | Event feedback | One short sentence. Do not include raw errors. |
| Inline message | Local issue | Put it near the affected field or section. |
| Modal | Blocking decision | Title should name the decision. Body should explain consequence. |
| Bottom Sheet | Mobile choices | Short title, options first, details second. |
| Empty state | Nothing to show | Say what can happen next. |
| Confirmation card | Agent blocked | Make the user action obvious and keep it in the message timeline. |

Button labels:

| Intent | Preferred labels |
| --- | --- |
| Primary continue | `继续`, `确认`, `开始`, `发送` |
| Recovery | `重试`, `刷新`, `重新扫码` |
| Navigation | `返回应用`, `去设置`, `查看详情` |
| Destructive | `删除`, `停止任务`, `清空授权` |
| Secondary | `取消`, `稍后再说`, `复制链接` |

Avoid long button labels. If the action needs context, put the context in the
surrounding sentence.

## Agent-Specific Language

### Execution Summary

Use a compact summary for process containers:

`{model} · 已处理 {n} 个步骤 · {tool summary} · {token/cost}`

Examples:

- `GPT-5.5 · 已处理 3 个步骤 · bash×1 / read×2`
- `MiniMax-M3 · 已处理 31 个步骤，1 个问题已恢复`

Default state should be collapsed. Expanded details should group content by:

- `思考`
- `工具调用`
- `审批`
- `工作流`
- `子任务`

### Thinking

Use `思考中` for the compact state. Do not expose chain-of-thought wording.
Expanded technical notes should be summarized, not presented as raw hidden
reasoning.

### Tool Calls

Use tool names only when useful for developers. For general users, prefer the
plain-language action.

| Raw | Preferred |
| --- | --- |
| `bash` | `运行命令` |
| `read` | `读取文件` |
| `write` | `写入文件` |
| `browser` | `检查浏览器` |
| `computer_use` | `操作电脑` |

### Approval

Use `等待你确认` as the primary label.

Approval cards should include:

- What Agent wants to do.
- Why the action needs confirmation.
- The consequence of allowing or denying.
- Primary actions: `允许`, `拒绝`.

Do not say `approval_request`, `toolCallId`, or `pending`.

### Clarification

Use `需要补充信息` or `需要你选择下一步`.

Clarification cards should present choices first. Additional explanation should
be secondary and short.

### Abort And Stop

Use `停止任务` for the action, `已停止` for the final state.

If stopping is in progress:

- Label: `正在停止`
- Message: `正在通知 Agent 停止当前任务。`

### Long Task Recovery

When a long-running task resumes, show:

- `正在恢复任务状态`
- `已恢复到最近一次进度`
- `需要你确认后继续`
- `恢复失败，请刷新后重试`

Do not imply the task is complete until the agent emits completion.

## Settings Language

Settings section names are fixed:

- `模型与账号`
- `安全与审批`
- `用量保护`
- `技能`
- `MCP 工具`
- `浏览器`
- `工作流网络`
- `移动端访问`

Rules:

- Keep section names noun-based and stable.
- Put low-frequency or advanced controls inside Settings, not session menus.
- Avoid exposing provider internals in section titles.
- Use `服务商` for provider-facing configuration.
- Use `模型` for model choices.
- Use `账号` for credentials and OAuth sign-in.

Provider/auth copy:

| Concept | Preferred term |
| --- | --- |
| Provider | `模型服务商` |
| API key | `API 密钥` |
| OAuth | `OAuth 登录` |
| Credential | `凭证` |
| Custom provider | `自定义服务商` |
| Saved | `已保存` |
| Not configured | `未配置` |

## Mobile And Remote Access

Mobile copy must focus on connection state and next action.

Primary status labels:

- `正在连接`
- `已连接`
- `网络恢复中`
- `需要重新扫码`
- `电脑端未开启`
- `公网连接不可用`
- `配对中，请稍作等待`

Remote access terms:

| Use | Avoid |
| --- | --- |
| `公网` | `临时公网` |
| `同一 Wi-Fi` | `局域网 2`, `局域网 3` |
| `重新扫码` | `重新授权 token` |
| `电脑端未开启` | `host offline` |
| `网络恢复中` | `load failed` |

The QR and pairing flow should not ask users to understand candidates, base
URLs, or status codes. Diagnostics can be placed in Settings detail areas.

## Terminology

Keep these terms stable.

| English / internal | Product term |
| --- | --- |
| agent | `Agent` |
| session | `会话` |
| branch | `分支` |
| system prompt | `系统提示词` |
| approval | `审批` or `确认` depending on context |
| clarification | `补充信息` |
| workflow | `工作流` |
| subagent | `子任务` |
| checkpoint | `检查点` |
| model picker | `模型选择` |
| provider | `模型服务商` |
| credentials | `凭证` |
| remote access | `移动端访问` |
| public tunnel | `公网` |
| local network | `同一 Wi-Fi` |

Use English when it is the product or protocol name:

- `Diga Agent`
- `Codex`
- `MCP`
- `OAuth`
- `API`
- Model names, such as `GPT-5.5`, `Claude Opus 4.7`, `MiniMax-M3`
- Commands, code, file paths, env vars, and package names

Avoid unnecessary mixed-language labels such as `Provider 凭证`, `session 文件`,
or `workflow history` in primary UI.

## Do / Don't

| Situation | Don't | Do |
| --- | --- | --- |
| Pairing expired | `401 Unauthorized` | `需要重新扫码` |
| Public URL failed | `load failed` | `公网连接不可用` |
| Several LAN candidates | `局域网 3` | `同一 Wi-Fi` |
| Server error | `HTTP 500` | `服务暂时不可用` |
| Missing API key | `provider auth failed` | `模型账号需要配置` |
| Agent waiting | `pending approval` | `等待你确认` |
| Resource changed | `404 not found` | `状态已变化` |
| Rate limit | `429` | `请求过于频繁` |
| Unknown failure | raw exception | `操作失败，请稍后重试。` |

## Review Checklist

Use this checklist when reviewing new UI copy:

- Does the copy name the user's visible state?
- Does an error include a next action?
- Are raw HTTP codes, SDK errors, ids, stack traces, and internal names hidden
  from primary UI?
- Are desktop and mobile using the same state terms?
- Is the button label a direct action?
- Is destructive copy explicit about the consequence?
- Does the component match the urgency: badge, inline message, toast, modal, or
  confirmation card?
- Are Settings terms consistent with the fixed section names?
- Are English terms limited to product names, protocols, commands, paths, code,
  models, or provider names?
- Is mobile copy short enough to fit without truncating the action?

## Maintenance

When adding new UI:

1. Pick the semantic state first.
2. Pick the component that matches urgency.
3. Write the short label.
4. Add the explanatory sentence only if needed.
5. Add a direct action when the user can recover.
6. If the phrase is reusable, add it to this document or
   `lib/user-facing-error.ts`.

Future automation can add a `product-language:check` script to scan for raw
HTTP status messages, unhandled English errors, overly long button labels, and
state terms that do not appear in this document.
