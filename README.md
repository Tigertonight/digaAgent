# mini-pi-web

Self-hosted UI for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
A mini fork of `pi-web` that runs as a standalone web server (or Electron app),
talks to the SDK directly, and keeps all configuration in `~/.pi/`.

## Quick Start

```bash
# One-shot: install + start + auto-open browser
npx mini-pi-web

# Custom port / host
npx mini-pi-web -p 4000
npx mini-pi-web -H 0.0.0.0

# Self-check before reporting issues
npx mini-pi-web doctor
```

Default URL: <http://localhost:30142>

## What's New (2026-06-02)

`pet` branch landed 4 major capabilities on top of the original web UI:

- **Desktop pet** (Electron): floating sprite with state animation, hover bubble,
  right-click menu, drag-to-edge snap, click-through transparent window
- **Multi-session knowledge layer** (RFC-3): per-session metadata persistence
  (pin / lastSeen / manual title), full-text search across all sessions, and
  project-level memory via SDK's built-in `AGENTS.md` / `CLAUDE.md` loader
- **Agent collaboration v0** (RFC-2): session-level budget guard (cost / turns /
  duration) with auto-abort modal, and inline tool approval bubbles (allow /
  deny / "don't ask again this session") with timeout fallback
- **Internal refactor** (RFC-1 + RFC-1.5): ChatApp.tsx split from 4673 → ~1445
  lines across 9 hooks + 11 view components; vitest infra with 152 tests

See [docs/plans/2026-06-02-rfc-index.md](./docs/plans/2026-06-02-rfc-index.md)
for the full architecture roadmap.

## Features

| Area | Status |
|---|---|
| Chat with any provider supported by the SDK | ✅ |
| API key management (`/api/auth`) | ✅ |
| OAuth login in-browser via SSE (`/api/auth/login/[provider]`) | ✅ |
| `models.json` editor (custom providers & per-model settings) | ✅ |
| Skills marketplace search + one-click install | ✅ |
| Tools toggle panel (runtime enable/disable) | ✅ |
| Image / HTML / wrapped-text preview in messages | ✅ |
| Session list, context inspector, export | ✅ |
| File picker bound to `MINI_PI_WEB_ROOT` | ✅ |
| Electron desktop build (`npm run electron:build`) | ✅ |
| **Desktop pet widget** (transparent, hover bubble, drag, right-click) | ✅ |
| **Session metadata**: pin / manual title / unread sync across reload | ✅ |
| **Full-text session search** (in-memory inverted index over all sessions) | ✅ |
| **Project memory** via `AGENTS.md` (auto-loaded by SDK from cwd ancestors) | ✅ |
| **Session-level budget** (cost / turns / duration limits with auto-abort) | ✅ |
| **Tool approval bubbles** (inline allow / deny / don't-ask with timeout) | ✅ |

## Configuration

mini-pi-web reads from `~/.pi/` (shared with `pi` CLI) and `~/.mini-pi-web/`
(mini-pi-web-only):

| File | Purpose |
|---|---|
| `~/.pi/auth.json` | API keys and OAuth credentials (per provider) |
| `~/.pi/models.json` | Custom providers and per-model overrides |
| `~/.pi/agent/skills/` | Installed agent skills |
| `~/.mini-pi-web/meta/<sessionId>.json` | Per-session metadata (title, pinned, lastSeenAt) |
| `~/.mini-pi-web/settings.json` | Global Budget defaults, approval rules, UI prefs |

The `~/.pi/` files are interchangeable with the upstream `pi` CLI and `pi-web`.

### Project-level memory

mini-pi-web inherits the SDK's `AGENTS.md` / `CLAUDE.md` auto-loader. Drop a
file named `AGENTS.md` anywhere from your project root up to filesystem root,
and it will be injected into the agent's system prompt automatically (no UI
needed). See [docs/guides/project-memory.md](./docs/guides/project-memory.md).

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `30142` | Server port |
| `HOSTNAME` | (none) | Bind host |
| `MINI_PI_WEB_ROOT` | `$HOME` | File picker / cwd sandbox root |
| `BROWSER=none` | — | Don't auto-open browser on start |

## doctor

```
$ npx mini-pi-web doctor
mini-pi-web doctor — 配置自检

✅ Node.js 22.10.0
ℹ️  Platform: darwin arm64
✅ ~/.pi 目录存在  /Users/you/.pi
✅ auth.json 可读  2 providers: anthropic, openai
✅ models.json 可读  3 providers, 12 models
✅ .next 构建产物  BUILD_ID=...
✅ next 16.2.6
✅ @earendil-works/pi-coding-agent 0.78.0
✅ 端口 30142  可用
```

## Smoke test

Once the server is running, you can hit every public endpoint with:

```bash
PORT=30142 node scripts/smoke-test.mjs
```

This is what the maintainers run before publishing.

## Development

```bash
# Hot reload (Next.js dev)
npm run dev

# Production build (web)
npm run build && npm start

# Electron dev
npm run electron:dev

# Electron build (mac arm64 by default)
npm run electron:build
```

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Browser (React)                                            │
│  ChatPanel / SettingsPanel / AuthPanel / SkillsPanel ...   │
└──────────────────────────────┬─────────────────────────────┘
                               │ fetch / EventSource
┌──────────────────────────────▼─────────────────────────────┐
│ Next.js API routes (/app/api/*)                            │
│  agent / auth / models-config / skills / sessions / files  │
└──────────────────────────────┬─────────────────────────────┘
                               │ direct calls
┌──────────────────────────────▼─────────────────────────────┐
│ @earendil-works/pi-coding-agent (SDK)                      │
│  AgentSession · AuthStorage · ModelRegistry · SkillManager │
└──────────────────────────────┬─────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────┐
│ ~/.pi/  (shared with pi CLI and upstream pi-web)           │
└────────────────────────────────────────────────────────────┘
```

No backend database. No external service. Just `~/.pi/`.

## License

MIT — see [LICENSE](./LICENSE).
