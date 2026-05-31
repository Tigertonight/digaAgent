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

## Configuration

mini-pi-web reads from `~/.pi/`:

| File | Purpose |
|---|---|
| `~/.pi/auth.json` | API keys and OAuth credentials (per provider) |
| `~/.pi/models.json` | Custom providers and per-model overrides |
| `~/.pi/agent/skills/` | Installed agent skills |

The same files are used by the upstream `pi` CLI and `pi-web`, so they are
interchangeable.

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
