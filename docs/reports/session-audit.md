# diga-agent 会话功能审核报告

> 审核范围：diga-agent 仓库内"会话(session/conversation/chat)"相关功能（存储/持久化、生命周期：创建/恢复/切换/删除）。
> 本报告综合两份分主题审计材料：
> - 主题 A：会话存储与持久化
> - 主题 B：会话生命周期(创建/恢复/切换/删除)

## 1. 摘要

**总体风险评估：中等偏高（Medium-High）。**

会话功能整体设计已显示出明显的工程自觉：`lib/meta/store.ts` 实现了较严谨的原子写（`open(wx)` + `fsync` + `rename` + `fsyncDir` + 跨进程目录锁），DELETE 路由实现了级联清理 + dispose，SSE 重连使用 ring-buffer + `state_reset`，`workflows/server-store.ts` 提供了带版本号与迁移路径的 schema，`disposeAgent` 对 clarification/approval/goal/progress/runtime-event/evidence/browser/watchdog 各类附属状态的清理也较完整。

但与之并存的是两类系统性短板，使得该模块在异常路径下的鲁棒性显著低于"晴天路径"：

1. **持久化层一致性参差不齐**：除 `meta/store.ts` 外，`progress`、`goal`、`subagents`、`workflows runs`、`tasks`、`mcp registry`、`subagents memory`、`workflow templates/skills` 等 9+ 处持久化点都使用 `${path}.tmp.${pid}.${Date.now()}` 这种"无 UUID、不开 wx、多数无 fsync、部分还是同步 API"的写法，且 IO 错误几乎全部被静默 `catch {}` 吞掉；只有 `workflows/server-store.ts` 显式声明了 schema version。
2. **生命周期入口的安全性与并发去重不对称**：context 接口已经实现了 `resolveTrustedSessionPath`，而 `POST /api/agent/new` 这个真正的 resume 入口却**没有**复用，导致 `sessionPath` 可被任意指向；`createAgent` 在 `Map.set` 之前存在长 await 窗口，并发调用会创建出指向同一 jsonl 的多条 AgentRecord；abort 路径不清 watchdog；`listAllSessions` 200ms 缓存 DELETE 后不 invalidate。

**问题数量按严重度统计（共 13 项）：**

| 严重度 | 数量 | 说明 |
| --- | --- | --- |
| High     | 1 | `POST /api/agent/new` 的 `sessionPath` 路径越权（H1）|
| Medium   | 8 | 原子写不规范 ×3、IO 错误静默吞 ×2、并发/锁缺失 ×3 |
| Low      | 3 | 路径校验白名单、SSE 边界注释、DELETE 部分失败 UX |
| Info     | 4 | meta 序列化 OK、meta JSON 损坏处理 OK、ID 冲突依赖 SDK、listAll 200ms 缓存 |

**最值得立即处理的方向**：(a) 修 H1（安全）；(b) 把 `meta/store.ts` 的"原子写 + per-id 锁"抽成共享 helper 替换其他 8 个 store 的写盘点；(c) 给所有 `catch {}` 静默吞错的位置至少加一行 `console.warn` 让运维感知静默丢盘。

## 2. 关键发现 Top 5

按"修复 ROI / 风险面"跨主题挑选。

### Top 1 — `POST /api/agent/new` 的 `sessionPath` 未做路径白名单（High，安全）

- **位置**：`app/api/agent/new/route.ts:31`、`lib/agent-registry.ts:1081-1113`
- **问题**：`cwd` 已经走 `assertPathAllowed`，`sessionPath` 却被原样透传到 `SessionManager.open(opts.sessionPath)`。`lib/sessions.ts:resolveTrustedSessionPath` 已经为 context 接口实现了"用 `listAll` 可信清单匹配"的反越权策略，但 resume 入口未复用，攻击面：携带 `sessionPath = /Users/...任意 .jsonl` 即可让 AgentSession 写入 / 读取任意文件，并通过 SSE ring buffer 泄漏其内容。
- **建议**：改为先 `listAllSdkSessions()` 取可信清单，再校验 `opts.sessionPath` 命中清单后才允许 createAgent；同时把异常返回从 `e.message/stack` 直返替换为 `internalErrorResponse`。

### Top 2 — 9 处持久化点共用不安全的 tmp 命名与写流程（Medium，跨模块）

- **位置**：`lib/progress/file-store.ts:163-165`、`lib/goal/file-store.ts:154-157`、`lib/subagents/server-store.ts:127-131`、`lib/workflows/server-store.ts:118-130`、`lib/tasks/store.ts:327`、`lib/mcp/registry.ts:81`、`lib/subagents/memory.ts:120`、`lib/workflows/template-store.ts:184`、`lib/workflows/skill-store.ts:214`
- **问题**：tmp 名为 `${fp}.tmp.${pid}.${Date.now()}`，**没有 randomUUID，也未使用 `open(wx)`**，多数无 `fsync`，`subagents/goal/workflows` 还是 `writeFileSync` + `renameSync`。同进程同毫秒并发写（progress 高频）时两次 `writeFile(tmp, ...)` 会互相覆盖，rename 谁后到谁赢，可能搬运被腰斩的 tmp。崩溃时还会出现"目录有 entry、内容 0 字节"的损坏文件。
- **建议**：把 `meta/store.ts` 的 `open(wx)` + UUID + fsync + dir-fsync + per-id Promise chain 抽成共享 helper（如 `lib/storage/atomic.ts`），替换上述 9 处写盘点。

### Top 3 — `createAgent` 并发去重存在长 await 窗口（Medium，数据完整性）

- **位置**：`lib/agent-registry.ts:1076-1087`、`1957-2040`
- **问题**：入口先 `Array.from(reg.agents.values()).find(...)` 检查同 `sessionPath`，**未命中后 await `resourceLoader.reload()` / `loadMcpToolDefinitions` / `createAgentSession`，最后才 `reg.agents.set`**。两次几乎同时到达的 `POST /api/agent/new`（双击、SPA 双 useEffect、网络重发）都会通过 find 检查，最终为同一 sessionFile 创建两条 AgentRecord，触发 SSE 事件重复、jsonl 并发写入。
- **建议**：在 createAgent 入口维护 `Map<sessionPath, Promise<CreateResult>>` in-flight 去重，第二个 caller 直接 await 第一个的 promise。

### Top 4 — 持久化层 IO 错误普遍被静默吞掉（Medium，可观察性）

- **位置**：`lib/progress/file-store.ts:122-127`（read）、`lib/subagents/server-store.ts:124-134`、`lib/goal/file-store.ts:154-160`、`lib/workflows/server-store.ts:131-133`，`lib/meta/store.ts:114-117`（IO 错误也未 warn，仅 JSON parse 错有 warn）
- **问题**：磁盘满 / EACCES / EIO / EISDIR / ENOSPC 一律 `return null` 或 `catch {}`，UI 显示"已保存"，重启后字段静默全丢；运维无任何线索。仓库内只有 workflow store 在持久化失败时打了 `console.error`。
- **建议**：所有非 ENOENT IO 错误至少 `console.warn("[<store>] persist failed", err)`；磁盘满（ENOSPC）应当 throw 给上层让 UI 提示；read 端 corrupt 文件也应统一 warn 一次。

### Top 5 — `abort` 路径未清 finishWatchdog / pendingFinishMessage（Medium，行为正确性）

- **位置**：`app/api/agent/[id]/route.ts:796-810`、`lib/agent-registry.ts:630-645`
- **问题**：abort 把 `rec.isStreaming = false` 并调 `rec.session.abort()`，但**没有 `clearFinishWatchdog(rec)` / `clearToolWatchdog(rec)`**。若 abort 发生在 `message_end → agent_end` 1.5s 窗口内，watchdog 仍会回调 `finishStreamingRun(rec)`，再次走 `maybeContinueGoal` → 再起一轮 prompt，表现为"用户中止后过 1.5s 自动又跑一轮"。
- **建议**：abort 分支在置 `isStreaming=false` 之前先调 `clearFinishWatchdog(rec)` 与 `clearToolWatchdog(rec)`，或抽出 `finalizeAfterAbort(rec)` 统一处理。

## 3. 分主题详细发现

### 3.1 主题 A：会话存储与持久化

本主题精读了 `lib/meta/store.ts`、`lib/meta/types.ts`、`lib/progress/file-store.ts`、`lib/progress/recovery.ts`、`lib/sessions.ts`、`lib/goal/file-store.ts`、`lib/subagents/server-store.ts`、`lib/workflows/server-store.ts`、`app/api/sessions/[id]/route.ts`、`app/api/sessions/[id]/meta/route.ts`、`app/api/sessions/[id]/fork/route.ts`、`lib/agent-registry.ts` 中的 progress 写盘点。SDK 自身的 `~/.pi/sessions/<id>.jsonl` 写入由 pi-coding-agent 负责，未在审计范围内。

#### 3.1.1 序列化格式与版本兼容

- ⚪ **Info — `lib/meta/types.ts`**
  - **位置**：`lib/meta/types.ts` 中的 `SessionMeta` / `sanitize()`
  - **问题描述**：通过白名单 + `sanitize()` 做 forward-compat，老数据自动剔除未知字段；旧版 v0 文件直接可读。
  - **触发条件**：N/A
  - **建议修复**：保持现状，可作为其他 store 的标杆。

- 🟠 **Medium — `lib/progress/file-store.ts:128-150` `sanitizeProgress` 无 schema version**
  - **位置**：`lib/progress/file-store.ts:128-150`
  - **问题描述**：未声明 `version` 字段，`AgentProgress.steps/groups/artifacts` 任一字段类型升级（如 `ProgressStep.status` 增枚举或拆字段）后旧文件会被静默丢成空数组（`Array.isArray ? map.filter(Boolean) : []`）。
  - **触发条件**：未来字段升级 + 用户重启进程读旧 progress 文件。
  - **建议修复**：加 `version` 字段 + 显式迁移；至少在 sanitize 失败时 `console.warn` 一次。

- 🟠 **Medium — `lib/goal/file-store.ts:106-145` envelope 版本号未生效**
  - **位置**：`lib/goal/file-store.ts:106-145`
  - **问题描述**：envelope 有 `version: 1`，但 `sanitizeEnvelope` 完全不看 `version`，只在缺失时回填 `CURRENT_VERSION`；未来 v2 写盘后被 v1 代码读到也只是按 v1 字段挑取，导致旧版本进程把降级后的内容覆盖回去。
  - **触发条件**：版本回滚或多版本并行。
  - **建议修复**：检测到 `version > CURRENT_VERSION` 时拒绝读（或只读不写），避免下个进程把降级内容覆盖回去。

- ⚪ **Info — `lib/workflows/server-store.ts` 标杆**
  - **位置**：`lib/workflows/server-store.ts`
  - **问题描述**：唯一一个有显式 `WORKFLOW_STORE_SCHEMA_VERSION = 2` + v1→v2 迁移路径的 store。
  - **触发条件**：N/A
  - **建议修复**：作为其他 store 的迁移参照。

#### 3.1.2 文件路径与原子写

- ⚪ **Info — `lib/meta/store.ts:172-191` 是仓库内最严谨的写盘实现**
  - **位置**：`lib/meta/store.ts:172-191` 的 `writeMeta`
  - **问题描述**：`open(wx)` 防 tmp 名字撞车 + `handle.sync()` + `rename` + `fsyncDir(dir)`，并在 rename 失败时 `unlink(tmp)`；tmp 名带 `randomUUID()`。
  - **触发条件**：N/A
  - **建议修复**：抽成共享 helper 复用到其他 store。

- 🟠 **Medium — 9 处持久化点 tmp 命名不安全且未使用 `wx`**
  - **位置**：`lib/progress/file-store.ts:163-165`、`lib/goal/file-store.ts:154-157`、`lib/subagents/server-store.ts:127-131`、`lib/workflows/server-store.ts:118-130`、`lib/tasks/store.ts:327`、`lib/mcp/registry.ts:81`、`lib/subagents/memory.ts:120`、`lib/workflows/template-store.ts:184`、`lib/workflows/skill-store.ts:214`
  - **问题描述**：tmp 名 `${fp}.tmp.${pid}.${Date.now()}` 没有 randomUUID 也没用 `wx`。同进程同毫秒并发写同一 key 会让两个写入打到同名 tmp，`writeFile` 默认互相覆盖；后到的 rename 可能搬运被腰斩的 tmp 文件。
  - **触发条件**：progress 等高频写场景（每个 `tool_progress` 事件触发）；多 tool 并发。
  - **建议修复**：统一改用 `meta/store.ts` 的 `open(wx)` + UUID + fsync + dir-fsync 写法。

- 🟠 **Medium — progress 写无 per-id 串行化锁**
  - **位置**：`lib/progress/file-store.ts`、调用方 `lib/agent-registry.ts:1716`
  - **问题描述**：每次 progress 更新 `await writePersistedProgress`，但 SDK 可能并发派发多个 progress 事件（多 tool 并发），两次 `writeFile(tmp,..)` 用同一 tmp 名互相截断；最后 rename 谁后到看以谁为准——内存 progress 与磁盘可能交错出非单调状态。
  - **触发条件**：多 tool 并发 + 高频 progress 派发。
  - **建议修复**：复用 `meta/store.ts` 的 per-id Promise chain（in-flight queue）。

- 🟠 **Medium — subagents/goal/workflows 使用同步 API 且无 fsync**
  - **位置**：`lib/subagents/server-store.ts`、`lib/goal/file-store.ts`、`lib/workflows/server-store.ts`
  - **问题描述**：使用同步 `writeFileSync` + `renameSync`，没有 `fsync`。崩溃时 rename 完成但 inode 未落盘的情况（断电/kernel panic）会出现"目录里有 entry、内容是 0 字节"的损坏文件——sanitize 时被 `JSON.parse` 抛异常→返回 null，整个 batch/goal/workflow run 静默丢失（`hydrateFromDisk` 的 catch 注释 "Ignore corrupt metadata files"）。
  - **触发条件**：异常关机 / kernel panic / 进程在 rename 与 fsync 间 SIGKILL。
  - **建议修复**：至少改为 `openSync(tmp,"wx") + writeSync + fsyncSync + closeSync` 再 rename，并加一行 `console.warn` 让运维感知静默丢盘。

- 🟡 **Low — `assertSafeSessionId` 等路径校验白名单不够严**
  - **位置**：`assertSafeSessionId` / `assertSafeAgentId` / `assertSafeBatchId`
  - **问题描述**：只拒 `/`、`\`、`..`，没拒空白符、控制字符或 NUL。SDK 给的 sessionId 形态可控，影响低。
  - **触发条件**：调用方传入异常字符（理论攻击面，工程影响低）。
  - **建议修复**：用白名单正则一刀切，例如 `^[A-Za-z0-9_\-]{1,128}$`。

#### 3.1.3 失败处理（磁盘满 / JSON 损坏 / 权限）

- 🔴 **High — `lib/progress/file-store.ts:122-127` 静默吞 IO 错误**（注：原审计材料标 High，本报告综合保留）
  - **位置**：`lib/progress/file-store.ts:122-127` `readPersistedProgress`
  - **问题描述**：所有非 ENOENT IO 错误（EACCES、EIO、EISDIR）一律 `return null`，**没有任何 log**。权限被改坏后用户每次重启都丢 progress，且没人能从日志里看出来。
  - **触发条件**：磁盘错误 / 权限被破坏 / 文件被改成目录等。
  - **建议修复**：非 ENOENT 走 `console.warn` 一次（含 errno）。`meta/store.ts:114-117` 同类问题严重度因有 JSON parse warn 降为 Medium。

- 🟠 **Medium — `meta/store.ts:114-117` IO 错误同样静默**
  - **位置**：`lib/meta/store.ts:114-117`
  - **问题描述**：JSON 损坏时有 warn，但 IO 错误（EACCES/EIO 等）依旧静默。
  - **触发条件**：磁盘损坏 / 权限错。
  - **建议修复**：与 progress 端统一加一行 warn。

- 🟠 **Medium — `subagents` / `goal` / `workflows` 持久化失败被静默吞**
  - **位置**：`lib/subagents/server-store.ts:124-134`、`lib/goal/file-store.ts:154-160`、`lib/workflows/server-store.ts:131-133`
  - **问题描述**：`persistBatch` / `persistEnvelope` 把磁盘满、权限错、ENOSPC 全部 `catch {}` 吞掉（goal/subagents 完全无 log，workflow 至少 `console.error`）。UI 显示"已保存"，重启后字段全丢且无任何线索。
  - **触发条件**：磁盘满 / 权限错。
  - **建议修复**：至少 `console.warn("[xxx-store] persist failed", err)`；磁盘满应当 throw 给上层让 UI 提示。

- 🟠 **Medium — DELETE 时 unlink 失败不区分错误类型**
  - **位置**：`app/api/sessions/[id]/route.ts:114-122`
  - **问题描述**：DELETE 时 jsonl unlink 失败立即跳过 meta/progress/batches 清理（合理，防"对话还在但元数据没了"），但**不区分 EACCES（永久错）与 EBUSY（瞬态）**，前端只能看到 207 partial，没有"请稍后重试 vs 修权限"的区分。
  - **触发条件**：jsonl 被另一进程占用 / 文件系统只读。
  - **建议修复**：在 errors 里带上 errno 让 UI 提示更细。

- ⚪ **Info — `lib/meta/store.ts:117-128` JSON 损坏处理合理**
  - **位置**：`lib/meta/store.ts:117-128`
  - **问题描述**：JSON 损坏返回 null + warn，列表不挂；行为合理。
  - **触发条件**：N/A
  - **建议修复**：保持现状。

#### 3.1.4 并发写 / 竞争 / 锁

- 🟠 **Medium — acquireMetaFileLock stale 判定基于 mtime，长事务下可能被抢锁**
  - **位置**：`lib/meta/store.ts:81-110`
  - **问题描述**：用 `mkdir` 做目录锁，stale 30s。stale 判定靠 `mtimeMs`，但目录锁的 mtime 在 macOS APFS 上不会随"持锁中"刷新——长事务（>30s）期间另一进程会清理后抢锁，造成两个进程同时持锁。当前 updateMeta 只有数十毫秒，实际不触发；未来加上"PATCH 触发自动 summary"等慢操作会出 silent override。
  - **触发条件**：未来锁内事务变慢（>30s）。
  - **建议修复**：持锁期间周期性 `utimes(lockDir)` 续期，或锁内放 pid+startTime 文件用于 stale 判定。

- 🟡 **Low — listAll 200ms 缓存多进程不一致**
  - **位置**：`lib/sessions.ts:34-58`
  - **问题描述**：`LIST_ALL_CACHE_MS = 200ms` 内存缓存只在 inflight 失败时清空，成功值不会被清；多 worker 时各自缓存。SDK 是 source of truth，最终一致。
  - **触发条件**：多 worker 部署。
  - **建议修复**：见生命周期主题 M3，DELETE / fork 后需要主动 invalidate。

- 🟠 **Medium — progress / goal / subagents / workflows 无跨进程锁**
  - **位置**：上述各 store
  - **问题描述**：数据存到 `~/.diga-agent/<scope>/<id>.json`，进程间用 `globalThis` 内存缓存做"权威"，多 worker（Next.js 多 worker、Electron+CLI 双开）会出现 last-write-wins，且各自缓存不互通。`meta/store.ts` 是唯一加了文件锁的。
  - **触发条件**：多进程并行运行 diga-agent。
  - **建议修复**：至少给 progress（高频写）也加文件锁，或文档化"diga-agent 只能单进程跑"。

#### 3.1.5 旧文件 / 孤儿 / 残留锁

- 🟠 **Medium — `*.tmp.*` 孤儿文件无启动期清理**
  - **位置**：所有使用 tmp+rename 写法的 store
  - **问题描述**：写流程任何一步失败（process.exit、断电）都会留下 `~/.diga-agent/**/*.tmp.<pid>.<ts>` 孤儿文件；除了 `meta/store.ts:190` 的 rename catch 会清掉本次 tmp，没有任何 store 在启动时扫描清理历史 tmp。长期跑会越攒越多。
  - **触发条件**：进程异常退出。
  - **建议修复**：每个 hydrate 入口扫一次 `*.tmp.*` 并 unlink。

- 🟠 **Medium — meta 目录锁残留可能导致首次启动后 5s 超时**
  - **位置**：`lib/meta/store.ts` 中 `<id>.meta.json.lock`
  - **问题描述**：`acquireMetaFileLock` 会基于 30s mtime 自动清理；但首次启动后立即写（mtime 还很新）+ 进程崩溃→下次启动后该锁会让 updateMeta 等满 5s 后超时抛错。
  - **触发条件**：进程崩溃在 lock 持有期间。
  - **建议修复**：进程启动时主动扫 `<root>/sessions/*.lock`，把超过 30s 的全部 rm。

- 🟠 **Medium — DELETE 级联依赖父链，孤悬子 session 无法清理**
  - **位置**：`app/api/sessions/[id]/route.ts`
  - **问题描述**：级联清理依赖 `parentSessionPath` 链；如果某子 session 已经孤悬（父 jsonl 已被绕过本路由直接 `rm` 掉），它在 `collectSessionDescendants` 里再也找不到根，永远残留。同理 `removeBatchesByParentSessionPath` 只在 jsonl 删除时调用，被外部清掉 jsonl 的 session 仍会留下 subagents/batches、goals、progress、meta。
  - **触发条件**：用户绕过路由直接删 jsonl；或链路中间一节被外部清理。
  - **建议修复**：增加一个"孤儿扫描"维护任务：定期遍历 `~/.diga-agent/**` 中各类 store，反查对应 SDK jsonl 是否还存在；不存在则一并清理（或归档）。

### 3.2 主题 B：会话生命周期(创建/恢复/切换/删除)

本主题精读了 `app/api/agent/new/route.ts`、`app/api/agent/[id]/route.ts`、`app/api/agent/[id]/events/route.ts`、`app/api/sessions/route.ts`、`app/api/sessions/[id]/route.ts`、`app/api/sessions/[id]/fork/route.ts`、`lib/agent-registry.ts`、`lib/sessions.ts`、`lib/meta/store.ts`、`lib/runtime/event-store.ts`。整体生命周期处理已有较多自觉（DELETE 级联 + dispose、SSE state_reset 重连、meta 跨进程目录锁、watchdog 兜底等），但仍存在 1 项 High、3 项 Medium、若干 Low / Info 问题。

#### 3.2.1 创建 / Resume

- 🔴 **High — `POST /api/agent/new` 的 `sessionPath` 未做路径白名单 / 归属校验**
  - **位置**：`app/api/agent/new/route.ts:31`、`lib/agent-registry.ts:1081-1113`
  - **问题描述**：`cwd` 走了 `assertPathAllowed`，但 `sessionPath` 直接透传给 `createAgent`，最终 `SessionManager.open(opts.sessionPath)`。`lib/sessions.ts:resolveTrustedSessionPath` 已经为 context 接口实现了"用 listAll 可信清单匹配"的反越权策略，但 resume 入口没有复用这一保护。
  - **触发条件**：调用方 POST `/api/agent/new` 携带 `sessionPath = /Users/...任意 .jsonl`，AgentSession 会真的把用户输入写到该 jsonl 文件、并在 ring buffer 中泄漏其内容到 SSE。
  - **建议修复**：与 context 路由对齐，先用 `listAllSdkSessions()` 校验 `sessionPath` 命中可信清单，再传入 `createAgent`；同时把异常返回从 `e.message/stack` 直返替换为 `internalErrorResponse`（与其他路由统一脱敏）。

- 🟠 **Medium — `createAgent` 在 await 之前的"复用现有 record"判断存在并发窗口**
  - **位置**：`lib/agent-registry.ts:1076-1087`、`1957-2040`
  - **问题描述**：顶部用 `Array.from(reg.agents.values()).find(...)` 检查同 `sessionPath`；若没有，继续 `await resourceLoader.reload()` / `loadMcpToolDefinitions` / `createAgentSession`，最终才 `reg.agents.set(id, record)`。两次接近同时到达的 `POST /api/agent/new`（多窗口、SPA 双 useEffect、网络重发）都会通过 find 检查，最终为同一 sessionFile 创建两条 AgentRecord，两条 record 各自 subscribe 同一底层 SDK session，轻则 sidebar 出现两条同 sessionFile 的运行实例、SSE 事件重复 push，重则 jsonl 被并发写入。
  - **触发条件**：双击 / 重连 / 多 tab 同时打开同一会话。`recentClientRequests` 只对 prompt 去重，不覆盖 createAgent。
  - **建议修复**：在 createAgent 入口为 `sessionPath`（或 `cwd+无 path` 情况）维护 `Map<sessionPath, Promise<CreateResult>>` 的 in-flight 去重；新进入者直接 await 已存在的 promise。

- ⚪ **Info — ID 冲突与多进程实例**
  - **位置**：`lib/agent-registry.ts:299-307`
  - **问题描述**：`agentId = randomUUID()`，`sessionId` 由 SDK 生成。多窗口 sessionId 同源不会冲突；`globalThis.__digaAgent` 仅防 Next dev hot-reload，不防多 Node 进程。两个进程都会写同一 jsonl（SDK 端保证），但 ring buffer / progress / goal 是 per-process 内存，会出现 "A 进程看到事件、B 进程的 sidebar 看不到"。
  - **触发条件**：多 server 实例同时跑。
  - **建议修复**：文档化单进程约束；或用文件锁标记 jsonl 已被某 pid 接管。

#### 3.2.2 Abort / 切换

- 🟠 **Medium — `abort` 路径未清 finishWatchdog / pendingFinishMessage**
  - **位置**：`app/api/agent/[id]/route.ts:796-810`、`lib/agent-registry.ts:630-645`
  - **问题描述**：abort 把 `rec.isStreaming = false` 并调 `rec.session.abort()`，但没有调用 `clearFinishWatchdog(rec)` / `clearToolWatchdog(rec)`。如果 abort 发生在 `message_end → agent_end` 的 1.5s 窗口里，watchdog 仍会回调 `finishStreamingRun(rec)`，再次走 `maybeContinueGoal` → 再起一轮 prompt（goal active 时），表现为"用户点击中止后过 1.5s 自动又跑一轮"。
  - **触发条件**：goal 处于 active；模型 message_end 之后用户立即点 abort。
  - **建议修复**：abort 分支在置 `isStreaming=false` 之前先调 `clearFinishWatchdog(rec)` 与 `clearToolWatchdog(rec)`，或抽出 `finalizeAfterAbort(rec)`。

#### 3.2.3 删除 / 切换 UX

- 🟠 **Medium — `listAllSessions` 200ms 缓存 + DELETE 不主动 invalidate，删除后短窗回闪**
  - **位置**：`lib/sessions.ts:36-65`、`app/api/sessions/[id]/route.ts:78-160`
  - **问题描述**：`listAllSdkSessions` 维护 200ms 进程内缓存，命中时直接返回旧 `SessionInfo[]`。DELETE 路由删完 jsonl/meta/progress 后没有调用 invalidate。前端在 DELETE 之后立即刷新 sidebar（200ms 内）会从缓存读到刚被删除的 session，点开还会走 `findSessionPathById` 命中 stale path 后 `SessionManager.open` 报错。
  - **触发条件**：用户连点删除后立刻刷新；测试用例中也容易复现。
  - **建议修复**：DELETE 成功后调用 `__clearSessionListCacheForTests`（或导出生产用 `invalidateSessionListCache`）；fork 路由在新建后同样应该 invalidate。

- 🟡 **Low — DELETE 部分失败后内存 record 已 dispose 但磁盘 jsonl 未删**
  - **位置**：`app/api/sessions/[id]/route.ts:101-137`
  - **问题描述**：DELETE 先无条件 `disposeAgent`，再 unlink；若 unlink 失败（权限/被占用）返回 207 Partial。结果是「内存 agent 已死、jsonl 还在」——下次 `listAllSessions` 仍会列出该 session（无 runtime），用户感知会迷惑。
  - **触发条件**：jsonl 被另一进程占用 / 文件系统只读。
  - **建议修复**：在尝试 unlink 之前先 `await fs.access(t.path, W_OK)` 探测；只有可删才 dispose；或失败时返回信息中明确提示"内存 agent 已停止"。

#### 3.2.4 SSE 重连 / Ring buffer

- 🟡 **Low — `getEarliestEventSeq` 边界与 `state_reset` 触发条件注释模糊**
  - **位置**：`lib/agent-registry.ts:2403-2410`、`app/api/agent/[id]/events/route.ts:80-96`
  - **问题描述**：`getEarliestEventSeq` 在 ring buffer 满前返回 0，满后返回 `nextSeq - MAX`。SSE 路由判定 overrun 用 `since < earliest - 1`（含 -1 修正），当 `since === earliest - 1` 时正好是"再老一格"，client 拿不到该 seq；回放循环 `getEventsSince` 使用 `e.seq > sinceSeq`（严格大于）是正确的。逻辑实际正确，但偏移留有一格容忍区，注释不清。
  - **触发条件**：高频运行 5000+ 事件后断线重连。
  - **建议修复**：注释明确 since 半开/闭语义，或把判定改为 `since + 1 < earliest` 与 `getEventsSince` 的"严格大于"对齐。

## 4. 横切问题(共同根因)

跨主题汇总后，至少有 5 条共同根因贯穿存储与生命周期两条线，是后续修复 ROI 最高的杠杆点：

1. **缺失统一的"原子写 + per-id 锁"工具**
   - `meta/store.ts` 已有完整实现（UUID tmp + `open(wx)` + `fsync` + `rename` + `fsyncDir` + 目录锁 + per-id Promise chain），但其余 9+ 处 store 各自实现了简陋版本，tmp 命名碰撞、缺 fsync、缺锁、部分还是同步 API。
   - 体现条目：3.1.2 全部 Medium；3.1.4 progress 无 per-id 锁；3.1.5 孤儿 tmp。
   - 修复方向：抽 `lib/storage/atomic.ts` 单点实现，强制所有 store 走它。

2. **错误被静默吞，无可观察性**
   - 多个 store 的读写路径用 `catch {}` / `return null` 直接吞掉非 ENOENT 错误，UI 还显示"已保存"，运维无任何线索；触发后用户感知"重启后字段凭空消失"。
   - 体现条目：3.1.3 progress / meta / subagents / goal / workflows 全部相关 finding；DELETE 207 不带 errno（3.1.3）。
   - 修复方向：建立"持久化错误必 warn / 关键错误必 throw"原则，并按 errno 分类（ENOSPC throw、EACCES warn+UI 提示、EIO warn）。

3. **Schema 版本与迁移策略不对称**
   - `workflows/server-store.ts` 是唯一显式带 `WORKFLOW_STORE_SCHEMA_VERSION` 与 v1→v2 迁移的 store；`progress` 完全没有 version；`goal` 写了 version 但读端不看。任何字段升级都会导致旧数据被静默丢字段或丢成空数组。
   - 体现条目：3.1.1 progress / goal 两条 Medium。
   - 修复方向：制定 schema 演进规范——所有 envelope 必须有 `version`；读端必须做 `version > CURRENT` / `< CURRENT` 双向处理。

4. **生命周期入口的安全策略不对称**
   - `context` 接口已用 `resolveTrustedSessionPath` 做白名单匹配；resume 入口 `POST /api/agent/new` 却原样透传 `sessionPath`。同类问题还体现在异常返回脱敏不一致（一处 internalErrorResponse、一处 e.message/stack 直返）。
   - 体现条目：H1（Top 1）。
   - 修复方向：抽出 `assertTrustedSessionPath()` 并在所有以 sessionPath 为入参的路由统一调用；异常返回统一走 `internalErrorResponse`。

5. **并发去重 / 缓存失效机制不到位**
   - `createAgent` 的"找现有 record"判断与 `Map.set` 之间存在长 await；`listAllSessions` 200ms 缓存在 DELETE / fork 后未 invalidate；progress 无 per-id 串行；`abort` 不清 watchdog 导致状态机非对称（启动有 watchdog、停止不清）。
   - 体现条目：M1（createAgent 并发）、M2（abort 不清 watchdog）、M3（listAll 缓存）、3.1.4 progress 无 per-id 锁。
   - 修复方向：建立"开-关状态对称"原则——任何"开"动作（subscribe / setTimeout / 持锁 / 缓存）必须有对应"关"动作清单，且在 abort/dispose/DELETE 路径上集中调用；增加 `invalidateSessionListCache` 公共 API。

## 5. 修复优先级建议

### P0（立即修，下一个发版前）

| 编号 | 工作量 | 描述 |
| --- | --- | --- |
| **P0-1** (H1) | **S** | 修 `POST /api/agent/new` 的 `sessionPath` 越权：复用 `resolveTrustedSessionPath` / `listAllSdkSessions()` 校验后再 `createAgent`。同步把异常返回换成 `internalErrorResponse`。 |
| **P0-2** (Top 4 / 3.1.3) | **S** | 给 `progress / meta / subagents / goal / workflows` 的 IO 错误 catch 加 `console.warn(errno)`；给 ENOSPC 改为 throw。无功能改动，纯可观察性补丁。 |
| **P0-3** (M2 / 3.2.2) | **S** | abort 路径在置 `isStreaming=false` 之前 `clearFinishWatchdog(rec)` + `clearToolWatchdog(rec)`。补 1 条单测：goal active 下 message_end 后立即 abort，1.5s 内不应再触发新一轮 prompt。 |
| **P0-4** (M3 / 3.2.3) | **S** | 导出 `invalidateSessionListCache()`，DELETE / fork 路由成功后调用；前端 sidebar refresh 行为不变。 |

### P1（近期排期）

| 编号 | 工作量 | 描述 |
| --- | --- | --- |
| **P1-1** (横切根因 1 / Top 2 / 3.1.2) | **L** | 抽 `lib/storage/atomic.ts` 共享 helper（UUID tmp + `open(wx)` + fsync + `rename` + `fsyncDir` + per-id Promise chain），替换 9 处 store 的写盘点；把同步 `writeFileSync` 全部异步化。 |
| **P1-2** (M1 / 3.2.1) | **M** | 在 `createAgent` 入口加 `Map<sessionPath, Promise<CreateResult>>` in-flight 去重；处理 promise reject 时清理 map 项。补单测：并发 N 次创建同 sessionPath 应只产生 1 条 AgentRecord。 |
| **P1-3** (3.1.1 progress 版本) | **M** | 给 `progress/file-store.ts` 加 `version` 字段 + 显式 sanitize/迁移；将 goal `sanitizeEnvelope` 改为遵循 envelope 内 `version`，对 `version > CURRENT` 拒读或只读不写。 |
| **P1-4** (3.1.5 孤儿 tmp / 残留锁) | **S** | 每个 hydrate 入口扫一次 `*.tmp.*` 并 unlink；进程启动时扫 `<root>/sessions/*.lock`，超过 30s 全部清理。 |
| **P1-5** (3.1.3 DELETE errno) | **S** | DELETE 路由的 207 partial 响应中带上 errno，让前端区分 EBUSY / EACCES。 |

### P2（长期/可观察性改进）

| 编号 | 工作量 | 描述 |
| --- | --- | --- |
| **P2-1** (3.1.4 跨进程锁) | **L** | 给 progress（高频写）加文件锁；或在 README / 部署文档明确"diga-agent 当前仅支持单进程跑"，并在启动时检测 `.pi`/`.diga-agent` 目录的进程标记文件加以警告。 |
| **P2-2** (3.1.4 meta 锁续期) | **M** | `acquireMetaFileLock` 增加持锁期 `utimes` 续期，或锁内放 pid+startTime；为未来"PATCH 触发自动 summary"等慢事务铺路。 |
| **P2-3** (3.1.5 孤悬 session 清理) | **M** | 增加"孤儿扫描"维护任务：定期遍历 `~/.diga-agent/**`，反查对应 SDK jsonl 是否存在，不存在则归档/清理。 |
| **P2-4** (3.1.2 路径校验) | **S** | 把 `assertSafeSessionId/AgentId/BatchId` 改为白名单正则 `^[A-Za-z0-9_\-]{1,128}$`。 |
| **P2-5** (3.2.4 SSE 边界) | **S** | 重写 `getEarliestEventSeq` 与 SSE overrun 判定的注释，让 since 半开/闭语义显式化；判定条件改为 `since + 1 < earliest` 与 `getEventsSince` 严格大于对齐。 |
| **P2-6** (横切根因 2) | **M** | 建立"持久化错误处理规范"内部文档，列明 ENOSPC/EACCES/EIO/EBUSY 分别如何处理；在 PR review checklist 中加入"新增 store 是否使用 atomic helper、是否声明 version、错误是否 warn 而非吞"。 |

## 6. 附录

### 6.1 审计范围（已覆盖文件）

本次综合审计实际精读以下文件（按主题归类）：

**主题 A — 会话存储与持久化**
- `lib/meta/store.ts`、`lib/meta/types.ts`
- `lib/progress/file-store.ts`、`lib/progress/recovery.ts`
- `lib/sessions.ts`
- `lib/goal/file-store.ts`
- `lib/subagents/server-store.ts`、`lib/subagents/memory.ts`
- `lib/workflows/server-store.ts`、`lib/workflows/template-store.ts`、`lib/workflows/skill-store.ts`
- `lib/tasks/store.ts`、`lib/mcp/registry.ts`
- `app/api/sessions/[id]/route.ts`、`app/api/sessions/[id]/meta/route.ts`、`app/api/sessions/[id]/fork/route.ts`
- `lib/agent-registry.ts` 中的 progress 写盘点

**主题 B — 会话生命周期(创建/恢复/切换/删除)**
- `app/api/agent/new/route.ts`
- `app/api/agent/[id]/route.ts`、`app/api/agent/[id]/events/route.ts`
- `app/api/sessions/route.ts`、`app/api/sessions/[id]/route.ts`、`app/api/sessions/[id]/fork/route.ts`
- `lib/agent-registry.ts`、`lib/sessions.ts`、`lib/meta/store.ts`、`lib/runtime/event-store.ts`

### 6.2 未覆盖项 / 已知盲点

- **SDK 层 jsonl 写入**：pi-coding-agent 自身的 `~/.pi/sessions/<id>.jsonl` 写入由 SDK 负责，diga-agent 仓库不可见，未审。该路径下的并发写、原子性、崩溃恢复需要单独审计（建议下一轮）。
- **前端会话切换 UX**：本审计聚焦后端路由 / 持久化 / 注册表，未深入 React 组件层切换会话时的 race（如旧 SSE 未 unsubscribe）。
- **Browser / clarification / approval 等附属状态的持久化**：仅审了 `disposeAgent` 的清理路径，未审它们各自 store 的写盘原子性与 schema 兼容（看起来同样使用了不安全的 tmp 写法，建议纳入下一轮）。
- **Workflows runs / templates / skills / tasks / mcp / subagents memory** 的业务行为（仅审了写盘相关代码）。
- **Web 鉴权层 / 多租户**：本审计假设 diga-agent 在受信端运行；多租户场景下 H1 等问题影响面会进一步放大。

### 6.3 后续建议（测试 / 监控 / 回归用例）

**测试用例**
1. **并发 createAgent**：并发 N=10 次 `POST /api/agent/new` 携带同一 `sessionPath`，断言 `reg.agents.size` 只增 1。
2. **abort 后 watchdog**：goal active 下，模型 message_end 后立即 abort，等待 2s，断言不再触发新一轮 prompt。
3. **DELETE 后 200ms 窗口刷新**：DELETE 一条会话后 50ms 内 GET `/api/sessions`，断言列表不含该 session。
4. **越权 sessionPath**：POST `/api/agent/new` 携带 `sessionPath = /etc/hosts`（或 `~/.zshrc`），断言 4xx。
5. **持久化错误注入**：mock `fs.writeFile` 抛 ENOSPC / EACCES，断言相应 store 至少 warn 一次；ENOSPC 应该把错误传到上层。
6. **崩溃恢复**：在 tmp 文件已存在但 rename 未完成时启动进程，断言 hydrate 路径不会读到半截 tmp 且会清理孤儿。
7. **schema 升级**：写一份 progress v0 文件再用当前代码读，断言不被静默丢成空数组（要么迁移要么 warn）。
8. **SSE 重连 overrun**：人为造 5000+ 事件后 since 落到 earliest-1，断言 client 收到 `state_reset` 而非半个事件流。

**监控建议**
- 给 `[meta-store] / [progress-store] / [goal-store] / [subagent-store] / [workflow-store]` 五类 warn 配独立 metric，用以发现"重启后字段丢失"类静默故障。
- 上报 createAgent 入口 in-flight 命中率（去重生效次数），观察前端是否仍在双触发。
- 上报 DELETE 207 partial 的 errno 分布，定位环境/权限问题。
- 上报 SSE state_reset 触发频率与 ring buffer 满次数，作为 overrun 容量调参依据。

**回归用例**
- 把 P0-1 ~ P0-4 的修复都封装成 e2e 用例（基于 supertest + 真实 fs 临时目录），加入 CI 的 smoke 套件，确保以后回归。
- 新增 store 时 PR review checklist 强制项："是否使用 atomic helper / 是否声明 version / 错误是否 warn 而非吞 / 是否有崩溃恢复测试"。
