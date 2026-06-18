# Codex 简单模式 vs 复杂模式 调研

调研对象：OpenAI Codex CLI（github.com/openai/codex，Rust 重写版 `codex-rs`），兼提一句云端 Codex（chatgpt.com/codex）。
调研时间：2026-06-18
调研方式：两路联网 subagent（modes-source / ui）+ 已有 codex 公开知识；执行/prompt 那一路超时，prompt 部分以"已知信息 + 未现场核验"标注。

---

## 一句话先把命名理清

Codex 官方**没有**"简单模式 / 复杂模式"这两个词。用户口语里说的"简单 vs 复杂"，落到 Codex 里其实是 **三个独立维度** 的组合，互相不一样：

1. **approval policy**（审批策略）—— 要不要每次问你
   `untrusted` / `on-failure` / `on-request` / `never`
2. **sandbox mode**（沙盒等级）—— 它能动多大权限
   `read-only` / `workspace-write` / `danger-full-access`
3. **reasoning effort**（推理强度）—— 模型想多深
   `minimal` / `low` / `medium` / `high`

CLI 里的 `--full-auto`、`--dangerously-bypass-approvals-and-sandbox`（旧名 `--yolo`）这些是把上面前两项打包的"快捷键"。
真正能把三个维度统一打包成一份预设的，是 `~/.codex/config.toml` 里的 **profile**。

> 所以以后跟用户对话时，先确认他指的是"它会不会乱动我电脑"（=审批+沙盒）还是"它想得深不深"（=reasoning effort），再回答。

---

## 三栏对比

### A. 执行逻辑

| 维度 | 简单 / 安全那一档 | 复杂 / 全自动那一档 |
|---|---|---|
| approval | `untrusted` 或 `on-request`：模型每次想跑命令、写文件，要么默认弹审批，要么模型自己请求升权才弹 | `never`：从不弹，模型直接跑 |
| sandbox | `read-only`：只能读，不能写文件、不能联网 | `danger-full-access`：直接跑在你真实环境里，没沙盒 |
| 失败处理 | 命令被沙盒拒 → 走审批升权 / 直接告知用户失败 | 命令直接生效，错就错了 |
| reasoning effort | 通常 `low` / `medium` 即可 | `high` / GPT-5 系列才打开完整 reasoning 预算 |
| 适合场景 | 别人代码、生产环境、第一次用 | 自己 sandbox 仓库、CI、可回滚环境 |

落到代码上（路径基于 codex-rs 仓库结构，commit 漂移以 main 为准）：
- `codex-rs/core/src/protocol.rs`：`enum AskForApproval`、`enum SandboxPolicy`
- `codex-rs/core/src/exec.rs` + `linux-sandbox/`：sandbox 实际执行
- `codex-rs/core/src/seatbelt.rs` + `seatbelt_base_policy.sbpl`：macOS 沙箱
- `codex-rs/cli/src/main.rs`：`exec` / `cloud` / `mcp` 子命令分发

### B. Prompt 差异（**未现场核源码，标注为推断**）

Codex 的 system prompt 不是一份静态 markdown，而是按运行时配置拼起来的。已知会进入 prompt 的因素：

1. **AGENTS.md / 项目 doc**：进 working directory 时若存在 `AGENTS.md`、`.codex/instructions.md`，会被读进 system prompt 顶部。
2. **可用工具集**：sandbox=read-only 时，模型被告知不要尝试写文件 / 网络（实际工具仍可调，但失败率高）；workspace-write 才会注明可以 `apply_patch`、可以 `shell` 写当前目录。
3. **审批语气**：`untrusted` / `on-request` 模式下 prompt 会鼓励模型"先解释再申请升权"；`never` 模式下不需要这套，prompt 会更简短直给。
4. **reasoning effort**：低 effort 时 prompt 会偏向"直接给结论"；高 effort 时偏向"先 outline / plan，再分步执行"。
5. **是否在 cloud Codex**：云端把 sandbox/审批整套去掉，prompt 假定容器内可任意操作，重点切到"产出 PR + 写 commit message"。

> ⚠️ 上述拆分来自历史 release notes 与社区观察，**没有当场把 main 分支的 prompt 拼装代码贴出来**。如果要写到正式文档，建议拿
> `rg -n "system_prompt|build_prompt|instructions" codex-rs/core/src` 现场核一遍。

### C. 用户看到的展示差异

这是被验证最清楚的一块。结论：**Codex 的设计是"展示密度恒定，模式只决定要不要打断你"**，跟 Claude Code 那种 Plan/Auto 双面板不一样。

| 模式 | 命令气泡 | diff 气泡 | 审批弹窗 | 思考过程 |
|---|---|---|---|---|
| `untrusted` | 全显示 | 全显示 | 每次都弹 | 按 reasoning effort 显示 |
| `on-failure` | 全显示 | 全显示 | 命令失败/被拒时弹一次 | 同上 |
| `on-request` (默认) | 全显示 | 全显示 | 模型自己申请升权才弹 | 同上 |
| `never` (yolo) | 全显示 | 全显示 | 不弹 | 同上 |

要点：
- 不管哪档，`$ cmd` + stdout/stderr + diff 都进历史；折叠只跟"输出长度"有关，不跟模式有关。
- TUI 顶部 status line 会以 `approval: xxx` / `sandbox: xxx` 文本行显示当前模式；`danger-full-access` 启动时有红色警告横幅；不是方括号彩色 tag 风格。
- reasoning effort 高的时候，会多出灰色斜体的 "Thinking..." 折叠块，里面是分段的 reasoning summary；低的时候 API 经常根本不返回 summary，TUI 就只一个 spinner。
- 没有独立的 Plan 面板，所谓 plan 是 reasoning summary 的一部分。
- 云端 Codex 完全是另一套 UI：左侧任务列表、阶段化进度节点（Setup → Working → Tests → Done）、GitHub 风格分屏 diff、一键 Open PR；模式被后端固定为容器内 full-auto，用户基本看不到 approval/sandbox 这层概念。

源码定位（codex-rs/tui）：
- `tui/src/history_cell.rs`：所有"用户能看到的单元格"枚举
- `tui/src/bottom_pane/`：状态行、审批弹窗、composer
- `tui/src/diff_render.rs`：diff 渲染
- 启动横幅 / status line 在 `app.rs` 或 `session_header.rs` 渲染

---

## 如果想在自己 agent 里区分"代码模式"和"日常工作模式"

基于上面 Codex 的做法，能直接借鉴的几条：

1. **不要把"模式"做成一个枚举**。拆成两到三个独立维度（权限 / 推理强度 / 工具集），让用户/profile 自由组合。Codex 的 `approval × sandbox × reasoning_effort` 就是这个思路——每条维度都正交，不互相绑死。

2. **代码模式 vs 日常工作模式的分水岭，主要在"工具集 + system prompt 顶部那段身份描述"**：
   - 代码模式：开 `apply_patch` / `shell` / `read_files`，prompt 强调"先看代码再改、改完跑测试、用 diff 输出"。
   - 日常工作模式：默认只开 `read_files` + `web_search` + `note/write`，prompt 强调"先把结论说人话，技术细节按需展开"。
   pi 现在这套 `Communication mode: Daily work` 的 context aside 已经做了一半，往这个方向再走一点就够。

3. **展示密度跟着工具集走，而不是跟着模式走**。Codex 的经验是：模式切换不应该让用户"突然看不到中间过程"，否则一旦出错没法 debug。代码模式可以多展示 diff/命令，日常模式可以折叠工具调用、只露最终回答，但折叠原因要明示（"3 步检索已完成，点开看详情"）而不是静默隐藏。

4. **审批策略单独抽出来**。无论代码还是日常模式，都给一个 `ask_before_writes` 之类的开关，避免"日常模式 = 自动跑"这种隐含语义把用户绕进去。Codex 把 `--full-auto` 单独命名就是这个用意。

5. **有 profile 概念再做组合预设**。底层维度独立 → 顶层提供 "code-review"、"daily-research"、"yolo-refactor" 之类的命名 profile。这样用户面对面是一句话切换，背后仍是组合配置，两边都不亏。

---

## 没核到位的点（坦白）

- Codex main 分支当前的 prompt 拼装顺序，**没有现场拉源码核验**，上面那一节是推断 + 历史 release notes，引用前请 `rg` 一遍。
- TUI 状态行的具体字段格式（是不是 `model: gpt-5-codex (reasoning: high)` 这种写法）记忆来自 2025 年中，2026 年 main 分支可能改过。
- 云端 Codex 当前是否对外暴露 reasoning effort 切换 UI，未验证（个人记忆是后端固定 high）。

---

## 引用

- 仓库：https://github.com/openai/codex
- 文档：`docs/config.md`、`docs/sandbox.md`、`docs/getting-started.md`（仓库内，也镜像到 https://developers.openai.com/codex/cli ）
- 关键源码路径：见上方各节
