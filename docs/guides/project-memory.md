# 项目级记忆指南（Project Memory）

> 让 Diga Agent 在你这个项目里"记住"约定、偏好、技术栈细节，跨 session 复用。

---

## TL;DR

在你的项目根目录创建一个 `AGENTS.md` 文件，写上想让 agent 知道的项目级约定。每次在该目录下新建 session，这个文件的内容会自动追加到 agent 的 system prompt 里。

```bash
# 在你的项目根
cat > AGENTS.md <<'EOF'
# 项目约定

- 用 React 18 + TypeScript strict
- 测试用 vitest，不要用 jest
- 不要修改 .env 文件
- 提交前必须跑 `pnpm lint && pnpm test`
EOF
```

刷新 diga-agent，下一次新建 session 时，agent 已经"知道"上述约定，不需要每次复制粘贴重申。

---

## 1. 这是什么 / 解决什么问题

不带项目记忆的痛点：

- 每开一个新 session 都要重新交代项目用什么栈、什么风格、哪些目录不能动
- 团队里换人时，新人启动 agent 的体验是"白板"，agent 不知道任何项目细节
- 重要的决策（"这个项目敏感数据不能写日志"）记在脑子里 → 哪天忘了 → agent 出错

**项目级记忆**就是把这些约定固化成一个 markdown 文件，让 agent **每次都自动加载**。

---

## 2. 怎么用：3 个文件位置

Diga Agent 底层的 SDK（`@earendil-works/pi-coding-agent`）在每次创建 / 恢复 session 时，会按下面顺序自动扫描：

### 2.1 全局记忆（跨所有项目）

`~/.config/diga-agent/AGENTS.md`（或 `~/.config/diga-agent/CLAUDE.md`，二选一）

- 写你**所有项目都适用**的偏好，例：
  ```markdown
  - 写 commit message 用 conventional commits 格式
  - 解释代码前先简述意图，再贴具体行
  - 中文回答，代码注释保留英文
  ```

### 2.2 项目记忆（本项目）

`<项目根>/AGENTS.md`（或 `<项目根>/CLAUDE.md`）

- 写**这个项目特有**的约定，例：
  ```markdown
  - 这是 Next.js App Router 项目，不要给我 Pages Router 的代码
  - 数据库是 PostgreSQL + Drizzle ORM
  - UI 一律用 tailwind + shadcn/ui
  - 不要碰 `legacy/` 目录
  ```
- **建议 commit 进 git**，让团队共享

### 2.3 父目录链（monorepo 友好）

如果你的 cwd 在 `~/work/monorepo/packages/web`，SDK 会从 cwd **一路向上扫到 `/`**，凡是经过的目录里有 `AGENTS.md` / `CLAUDE.md` 都会加载。

例如：
```
~/work/monorepo/AGENTS.md           ← monorepo 通用约定
~/work/monorepo/packages/web/AGENTS.md  ← web 包特有约定
```

两个都会被加载，**root 在前、cwd 在后**（cwd 优先级更高，因为后写入 system prompt）。

---

## 3. 加载顺序与去重规则

确切的加载顺序（来自 SDK `loadProjectContextFiles`）：

1. **全局**：`~/.config/diga-agent/AGENTS.md`（或 `CLAUDE.md`）
2. **祖先链（root → cwd）**：从 `/` 一路扫到 cwd，凡是该目录下有 `AGENTS.md` 的都收集
3. **去重**：路径相同的文件只加载一次（防止 cwd 和 agentDir 是同一目录时双加载）
4. **单目录单文件**：一个目录里**只取第一个匹配**，候选顺序是 `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`。**不会**同时加载 AGENTS.md 和 CLAUDE.md。

---

## 4. 常见场景模板

### 4.1 Next.js + TS 项目

```markdown
# 项目约定

## 技术栈
- Next.js 15 App Router
- TypeScript strict mode
- Tailwind CSS + shadcn/ui
- vitest 单测（不是 jest）
- Playwright e2e

## 风格
- 服务端组件优先，'use client' 显式标注
- 数据获取用 fetch + Next cache，不要用 SWR / react-query
- 表单用 react-hook-form + zod

## 红线
- 不要改 `next.config.ts` 的实验性 flag
- 不要在 `app/` 下创建 `pages/` 目录
- 不要从 SDK 改任何东西
```

### 4.2 Python 数据项目

```markdown
# 项目约定

- Python 3.11，依赖管理用 uv
- 数据处理用 polars，不要用 pandas
- 类型注解强制，跑 `uv run mypy`
- 数据集很大（10GB+），不要 print 全量，最多 head(5)
- 不要写到 `data/raw/` 目录，那是只读
```

### 4.3 团队共享 + 个人偏好分离

- `<项目根>/AGENTS.md` → commit 进 git，团队共享
- `~/.config/diga-agent/AGENTS.md` → 个人偏好（如"中文回答""不要解释太多"），不进 git

---

## 5. 验证：怎么确认 agent 真的读到了？

方法 1 — 直接问 agent：

> 你刚才加载了哪些 AGENTS.md / CLAUDE.md 文件？请列出每个文件的路径和前 3 行内容。

方法 2 — 写一条**特征明显**的约定，看 agent 行为是否改变：

```markdown
# 项目约定

- 每次回答前必须以 "🎯" 开头（仅用于测试加载是否生效）
```

新建 session 后，agent 的回复如果第一个字符是 🎯，说明读到了。**测完记得删掉这条**。

方法 3 — 看 diga-agent server 日志（如果 SDK 有 verbose 模式）

---

## 6. 注意事项

### 6.1 不要写敏感信息

`AGENTS.md` 会被发给 LLM。**不要**在里面写：
- API key / token
- 数据库连接字符串（含密码）
- 用户数据 / 内部财务数字

如果 commit 进 git，更要小心。

### 6.2 不要写太长

- agent 的 context window 是有限的，每次 session 这些内容都要"占位"
- 推荐 **< 200 行**（约 8KB）
- 真的有很多约定 → 抽成多个文件按目录分布（monorepo 模式）

### 6.3 不要重复说同一件事

如果 global 已经写了 "中文回答"，项目 AGENTS.md 就不用再写一遍。重复内容白白占 context。

### 6.4 命名大小写

SDK 候选名是固定的 4 个：`AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`。

- 推荐用 `AGENTS.md`（行业事实标准，Claude Code / Cursor / Aider 都认）
- 不要写成 `Agents.md` / `agents.md` —— **不会被加载**

### 6.5 `.gitignore` 建议

如果你的 `AGENTS.md` 写了纯个人偏好（不适合团队共享），加进 `.gitignore`：

```gitignore
# Diga Agent 项目记忆 - 个人偏好版本
/AGENTS.md
```

或者反过来：项目共享版本 commit，个人覆盖单独建一个 `~/.config/diga-agent/AGENTS.md`。

---

## 7. 与其他工具的兼容性

`AGENTS.md` / `CLAUDE.md` 是社区事实标准，以下工具都识别：

| 工具 | AGENTS.md | CLAUDE.md |
|------|-----------|-----------|
| Claude Code | ✅ | ✅ |
| Cursor | ✅ | — |
| Aider | ✅ | — |
| Diga Agent（本项目） | ✅ | ✅ |

→ **如果你已经在用 Claude Code 等工具**，原有的 `AGENTS.md` 直接复用，不用重写。

---

## 8. 路线图（未来可能）

当前 v0 实现：**只读 + 手动编辑**。

后续可能加（待用户反馈再决定）：

- **UI 编辑面板**：在 diga-agent settings 里直接编辑（不用切到编辑器）
- **session → memory 抽取**：右键某条 message → "加入 memory.md"
- **AI 自动学习**：agent 发现"用户反复纠正同一件事" → 提议加入 memory
- **`.diga-agent/` 命名空间**：如果 `AGENTS.md` 在项目根太"显眼"，提供 `.diga-agent/agents.md` 作为可选位置

这些都不在 v0 范围内。当前 v0 = "教用户用 SDK 已经内建的能力"。

---

## 9. 故障排查

### Q1：我创建了 `AGENTS.md` 但 agent 好像没读到

- **新建 session**，不是 resume 旧 session（旧 session 启动时的 system prompt 已经固化）
  - 不过 SDK 也会在 resume 时重新加载，理论上应该生效
- 检查文件名大小写（`AGENTS.md` 不是 `Agents.md`）
- 检查文件路径是不是在你 diga-agent 选定的 cwd 下
- 用第 5 节方法 2 写一条特征约定验证

### Q2：怎么知道我现在的 cwd 是哪个？

- diga-agent 顶部状态栏 / settings 页应该有显示
- 或者新建 session 后直接问 agent：「pwd」

### Q3：我在 monorepo 父目录写了 AGENTS.md，子包没生效？

- 检查从子包 cwd 一路向上到那个父目录中间有没有别的 `AGENTS.md` —— 如果有也会被加载（**不会**互相覆盖，是叠加）
- 检查 cwd 是不是真的在那个子包下

### Q4：能不能动态切换不同的 AGENTS.md？

不能。SDK 在 session 创建时固定扫描一次。想换约定 → 改文件 + 新建 session。

---

## 10. 相关文档

- RFC-3 主文：`docs/plans/2026-06-02-rfc-3-session-as-knowledge.md` 第 3.2.4 节
- Phase C 回顾：`docs/plans/2026-06-02-rfc-3-phase-c-retrospective.md`
- SDK 实现参考：`node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js`
