# Dynamic Workflow Script Harness

> 状态：MVP landed + process worker runtime
> 日期：2026-06-04

## 目标

把 dynamic workflow 从固定 JSON stage DAG 升级为 Claude Code 风格的 **task-specific script harness**：

```text
Main agent
  -> generates workflow script
  -> run_workflow_script executes script in a restricted runtime
  -> script calls workflow SDK
  -> SDK spawns subagents / runs parallel branches / writes checkpoints
  -> main agent synthesizes result
```

## 为什么不是裸 JS

脚本可以使用 JS 控制流，但不能直接拿 Node 能力。runtime 默认在独立 Node 子进程里执行受限脚本；脚本上下文不暴露 `require`、`import`、`process`、`fs`、shell 或网络 API。所有外部行动必须通过 `workflow` SDK：

- `workflow.spawnAgent(...)`
- `workflow.parallel([...])`
- `workflow.stage(title, fn)`
- `workflow.checkpoint(name, value)`
- `workflow.artifact(name, value)`
- `workflow.readArtifact(name)`
- `workflow.listArtifacts()`
- `workflow.createWorktree({ name, baseRef })`
- `workflow.diffWorktree(worktree)`
- `workflow.mergeWorktree(worktree)`
- `workflow.removeWorktree(worktree)`
- `workflow.askUser({ title, question, context, options, recommendedOptionId })`
- `workflow.fetchUrl({ url, method, headers, body, maxBytes })`
- `workflow.log(message)`
- `workflow.warn(message)`
- `workflow.error(message)`
- `workflow.sleep(ms)`

这样模型拥有编排表达力，但权限仍然集中在父进程 SDK 入口，继续复用 subagent 的 tool allowlist、timeout、event 和 abort 链路。

## Runtime 架构

```text
run_workflow_script tool
  -> parent runtime creates workflow run + manifest
  -> capability approval broker validates requested capabilities
  -> parent spawns lib/workflows/script-worker-child.cjs
  -> child process runs generated async JS body in restricted vm context
  -> child workflow SDK sends JSON-line requests over stdout
  -> parent handles SDK requests, writes store, emits SSE, spawns subagents
  -> parent returns JSON-line responses to child
  -> child reports final return value or error
```

关键点：

- 子进程只负责 JS 控制流，不直接读写文件、不调用 shell、不访问网络。
- 父进程是唯一 capability enforcement point：`spawnAgent`、worktree、checkpoint、artifact、log 都在父进程处理。
- `workflow.checkpoint()` / `workflow.artifact()` 在脚本里可保持同步写法；worker 会跟踪 pending side effects，并在返回最终结果前 flush 到父进程。
- 外部 abort 或 timeout 会中断父进程 promise，并对 worker 发送 `SIGKILL`。
- 父进程启动 worker 时会设置 Node heap 上限；workflow manifest 的 `timeoutMs` 负责 wall-time 上限。POSIX 平台会通过 `/bin/sh` launcher 设置 `ulimit -t` CPU 秒数上限；不支持的平台会降级为直接 Node 启动。部署环境还可以通过 `MINI_PI_WORKFLOW_WORKER_SANDBOX_ARGV_JSON` 配置外部 sandbox argv，以 Docker/Podman/bwrap/firejail/sandbox-exec 等工具为 worker 叠加 container/cgroup/namespace 级限制；argv 支持 `{command}` 与 `{args}` 占位符，runtime 不通过 shell 拼接该配置。
- worker 文件会作为 runtime asset 打进 npm/electron 包；standalone 构建后由 `scripts/copy-standalone-assets.mjs` 复制到 `.next/standalone/lib/workflows/script-worker-child.cjs`。

## 当前边界

- Runtime 默认使用独立 process worker；worker 内部仍使用 Node `vm` 构造受限全局对象。
- 这比主进程 `vm` 更适合工程隔离；当前已有 wall-time timeout、abort kill、Node heap 上限、POSIX CPU `ulimit -t`，以及可配置外部 sandbox launcher。未配置外部 sandbox 时，它仍不是强安全沙箱；需要强安全边界的部署应启用 container/cgroup 级内存、进程数、文件系统与网络 namespace 限制。
- Workflow run 已有进程内 server-store、SSE 事件、HTTP 查询/取消 API 和聊天流状态卡。
- Workflow run 会持久化到 `~/.mini-pi/workflows/runs/{workflowId}.json`；进程重启或热重载后可重新列出历史 workflow。磁盘格式是带 `schemaVersion` 的 v2 envelope，并兼容旧的裸 `WorkflowRun` JSON 与 v1 envelope 自动迁移。
- Workflow store 有保守历史清理策略：按 parent agent 保留最近的 completed runs，按年龄清理旧 run，并且不会删除 running workflow；可通过 `MINI_PI_WORKFLOW_MAX_RUNS_PER_PARENT` 与 `MINI_PI_WORKFLOW_MAX_RUN_AGE_DAYS` 调整保留策略。
- Workflow store v2 会为持久化 artifact 写入 artifact index；超过 `MINI_PI_WORKFLOW_ARTIFACT_COMPRESSION_BYTES` 阈值的 artifact value 会以 `gzip+base64+json` 压缩写盘，读取时透明解压，runtime 内存中的 artifact shape 不变。Envelope 也会记录 `migrationHistory`，便于后续 schema 演进。
- Workflow API 支持读取单个 workflow 的 resume snapshot：checkpoint names、artifact names、last checkpoint、canResume，以及最近 checkpoint/artifact 的轻量 preview 摘要。
- `run_workflow_script` 支持 `resumeFromWorkflowId` 与可选 `resumeFromCheckpointName`：新 harness 会加载同一 parent agent 下旧 workflow 的 checkpoints/artifacts，并通过 `workflow.resume` 与 `workflow.readArtifact(name)` 继续执行。指定 checkpoint 时，`workflow.resume.lastCheckpoint` 会指向该 checkpoint；未指定时默认使用最新 checkpoint。这里恢复的是 checkpoint/artifact 状态，不恢复任意 JavaScript 调用栈。
- Workflow 状态卡支持 Resume action：从已有 checkpoint/artifact 生成续跑提示并填入 Composer，引导模型用 `resumeFromWorkflowId` 生成新的续跑 harness。
- Workflow history UI 已接入动作菜单：可从当前 agent 的历史 workflow resume snapshot 列表直接选择可恢复 run，并可选择具体 checkpoint，复用同一套 `resumeFromWorkflowId` / `resumeFromCheckpointName` 续跑提示。续跑 prompt 会自动带入选中 checkpoint 以及最近 checkpoint/artifact 的短摘要，减少模型二次查询和误选恢复点。
- `artifact/checkpoint/log` 会实时写入 workflow store，并通过 `workflow_artifact` / `workflow_checkpoint` / `workflow_log` 推到前端。
- Capability manifest 已落地：默认只启用 `spawn_agent` + `read_files`。
- Capability approval broker 已接入现有 approval bubble：`write_files` 会先请求用户确认，确认后才允许 child agent 使用 `edit` / `write` / `apply_patch` 类工具。
- `shell` capability 已有 runtime support：审批通过后，workflow 可以把 `bash` / `shell` 工具名显式下发给 child agent；脚本本身仍不能直接调用 shell。
- `browser` capability 已有 runtime support：审批通过后，workflow 可以把 `browser_*` 工具名显式下发给 child agent；脚本本身仍不能直接操作 browser API。
- `ask_user` capability 已有 runtime support：审批通过后，workflow 可以通过 `workflow.askUser(...)` 复用 host clarification UI 获取用户选择。
- `network` capability 已有 runtime support：审批通过后，workflow 可以通过 host-side `workflow.fetchUrl(...)` 做受限 `http/https` 请求；脚本本身仍没有全局 `fetch`、网络库或 Node API。默认 network policy 会拒绝 localhost/私网 URL，并在 DNS 解析后拒绝指向 localhost/私网地址的目标。每个具体 URL 请求还会通过 `workflow:fetch_url` approval bubble 二次确认；用户勾选"本会话不再问"时，remember scope 会收窄到同一 origin，而不是放行全部 workflow 网络请求。Host runtime 还支持可配置 `networkPolicy`：`allowedOrigins`、`deniedOrigins`、`allowedUrlPatterns`、`deniedUrlPatterns`、`allowedMethods`，deny 规则优先；策略通过 `/api/workflows/network-policy` 持久化到 `~/.mini-pi/workflows/network-policy.json`，并在每次 `run_workflow_script` 时由 parent runtime 注入。Settings 页面已有 Workflow Network Policy 区块，可配置 allow/deny origins、URL patterns 和 allowed methods；同一区块展示可过滤 network audit，支持按 workflowId、origin、outcome/status 和文本检索，并支持从审计条目一键加入 allow origin、deny origin 或 deny path pattern。每次允许、拒绝或失败的网络尝试都会写入 workflow log 和 `~/.mini-pi/workflows/network-audit.json`，作为请求审计轨迹。
- `worktree` capability 已有 runtime support：审批通过后可通过 `workflow.createWorktree()` 创建 git worktree，并把返回的 `path` 作为 implementation subagent 的 `cwd`。
- Worktree diff / merge flow 已有 runtime support：`workflow.diffWorktree()` 会产出 diff artifact；`workflow.mergeWorktree()` 会先生成 diff preview artifact，并通过结构化 `workflow:merge_worktree` approval bubble 展示 branch/path/baseRef、stat 和可展开 diff preview 请求用户确认。确认后才用 `git apply --3way` 把隔离 patch 应用回主工作区，但不会自动 commit。若 patch apply 失败，runtime 会写入 `worktree-merge-failed:<id>` artifact，保留错误、worktree metadata、stat 和 diff preview，便于后续 resume 或手动排查。Workflow 卡片会识别 worktree artifacts，并按 worktree id 聚合成最终状态行，提供 Retry merge / Cleanup 按钮；对应 API 为当前 agent 的 `/api/agent/:id/workflows` `retry_merge_worktree` 与 `cleanup_worktree` 动作。手动操作成功后 API 会写入 `worktree-manual-merge:<id>` 或 `worktree-cleanup:<id>` artifact，前端复用 `workflow_artifact` reducer 即时刷新卡片。卡片操作已有按钮级 loading/disabled 状态，并在成功或失败时显示就地反馈，失败也会同步到全局错误提示。
- `workflow.spawnAgent` 默认只允许 read-only child tools：`read`、`grep`、`find`、`ls`。
- 可运行 `npm run workflow:sandbox:check` 检测本机可用 sandbox 工具，并输出推荐的 `MINI_PI_WORKFLOW_WORKER_SANDBOX_ARGV_JSON`。当前脚本支持 bwrap、firejail 与 macOS sandbox-exec 的即插即用检测；Docker/Podman 仍可通过同一 argv 机制接入，但需要部署侧提供包含 worker runtime 的镜像。

## 部署验收建议

1. 在生产/CI 环境启用外部 sandbox 后，增加一条端到端验收：确认 workflow worker 无法访问网络、无法读写非授权路径，并且超出 CPU/内存/进程数限制时会被终止。
