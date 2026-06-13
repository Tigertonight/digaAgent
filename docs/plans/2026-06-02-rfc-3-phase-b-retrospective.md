# RFC-3 Phase B：Session 全文检索（F2）执行回顾

> **状态**：✅ 已完成（2026-06-02）
> **作者**：Diga Agent 团队（含 AI 辅助）
> **创建**：2026-06-02
> **完成**：2026-06-02（当日）
> **实际工期**：约半天（连续推进，与 Phase A 同日）
> **关联**：[RFC-3 主文](./2026-06-02-rfc-3-session-as-knowledge.md) §F2、[Phase A 回顾](./2026-06-02-rfc-3-phase-a-retrospective.md)
> **commits**：`b204834` → `81ee345`（共 4 个）

---

## 0. TL;DR

让 Sidebar 不再是"日期堆"之后，再让 Sidebar 不再是"只能日期堆"：用户可以在搜索框输入任意关键词，跨所有本地 session 搜全文（user/assistant 文本、bash 命令&输出、compaction summary、branch summary、session name），命中结果直接在 Sidebar 替换列表显示，点击跳到对应 session。完成 RFC-3 F2 v0；全程 0 行为退化、0 lint 漂移、0 新依赖（自写 tokenizer + BM25-lite）。

**实际成果**：

| 指标 | Before (Phase A 完成时) | After | Δ |
|---|---|---|---|
| 新增 lib 代码 | — | `lib/search/` 共 ~720 行（含 44 单测） | +720 |
| 新增 hook | — | useSearch（160 行，带 state + debounce + race 防护） | +1 |
| 新增 API 路由 | — | `POST /api/search`（+ 内部 cache.ts） | +1 |
| 新增 UI 组件 | — | SidebarSearch（176 行，含高亮） | +1 |
| Sidebar 改造 | meta.title + Pin | + 搜索框 + searchView 插槽守门 | UI ↑ |
| ChatApp 接线 | useSessionMeta | + useSearch + sessionLookup memo | +15 行 |
| 持久化 | session.jsonl + `{id}.meta.json` | （索引内存，进程生命周期 cache） | 0 新增文件 |
| 索引策略 | — | 懒构建 + (maxModified, sessionCount) 指纹 invalidate | new |
| 单测 cases | 108 | **152（+44：14 tokenize + 13 index + 17 extract）** | +44 |
| e2e | 6/6 ✓ | 6/6 ✓ | 持平 |
| lint warnings | 91 | **91** | 持平 |
| lint errors | 20 | **20** | 持平 |
| TS 严格通过 | ✓ | ✓ | 持平 |
| build | ✓ | ✓（含 `/api/search`）| 持平 |
| 新依赖 | — | **0** | — |

**关键判断**：Phase B 走「自底向上 4 子阶段」节奏。B1（纯函数 lib：types + tokenize + index，零 IO 零 server-only）→ B2（接 SDK 抽文本 + IO 层 build-index，纯函数与 IO 严格分离）→ B3（API 路由 + 内存 cache，发现 Next route export 限制后拆 cache.ts）→ B4（hook + UI，state hook 处理 set-state-in-effect 难点）。这种节奏让单测从纯函数一路覆盖到 IO 入口，UI 落地时没有任何 lib 层不确定性。

**未做（留给下一轮）**：

- F3：自动摘要（每 N 轮 LLM 摘要写回 meta）—— 切走独立推进，理由：F3 涉及 LLM provider + 成本预算 + prompt 工程，与 F2 工期差太多
- 索引持久化（v0 内存 only，进程重启冷构建）
- 索引增量更新（v0 fingerprint mismatch 即全量重建）
- in-flight promise dedup（v0 用户量小，并发冷构建不浪费太多）
- 跳转到 entry 锚点（v0 只跳 session）
- Sidebar 命中时不点击就预览的 hover 卡片
- Cmd+K 全局唤起（v0 直接在 Sidebar 内嵌输入框）

---

## 1. 背景：为什么 Phase B 选 F2 而切走 F3

### 1.1 RFC-3 主文范围

RFC-3 主文把 Phase B 定义为「F2 全文检索 + F3 自动摘要」。实际推进时再做了一次范围收敛：

| RFC 主文原 Phase B | 实际 Phase B | 原因 |
|---|---|---|
| F2 搜索 + F3 摘要一起做 | 只做 F2 | F3 需要选 LLM provider（用户的 default 还是另启）+ 决定触发节奏 + prompt 工程 + 成本预算审计；与 F2 的工程量完全不在一个数量级 |
| F2 含 Cmd+K 全局唤起 | v0 嵌 Sidebar 内的输入框 | Cmd+K 需要 portal + 全局快捷键管理，与 Sidebar 内嵌入口价值重叠；先嵌 Sidebar 验证检索质量，Cmd+K 留后续 |
| 索引可能用 sqlite / lunr / minisearch | 自写 tokenizer + 内存倒排 | 9~100 session 量级下复杂度过剩；自写零依赖 ~300 行可控；将来真扛不住再换 |

→ **F2 是给 Phase A 攒下的 meta 装上"找回去的路"**：Phase A 让用户可以 pin/title 重要 session，但找不到一周前的某个对话依然要靠日期翻；F2 把所有 session 文本变成可搜索的，pin/title 才真正发挥导航价值。

### 1.2 用户决策

经过架构讨论，用户拍板：

- 按 B1（lib） → B2（IO 接 SDK） → B3（API） → B4（UI） → B5（回顾）的 5 子阶段推进
- 不切碎成多个 PR，连续推进，每子阶段独立 commit
- v0 内存索引（不持久化），进程重启冷构建可接受
- 自写 tokenizer：英文 lowercase + 整词、CJK 单字 + bigram、零依赖
- 评分 BM25-lite：distinct token IDF + hit count log 封顶 10
- Snippet 命中位置前后各 40 字符，过长加 `…`
- UI 直接占 Sidebar 列表位置（searchView 非 null 时完全替代普通 sessions 列表）
- v0 不做 Cmd+K / 不做 entry 锚点 / 不做 hover 预览

执行约定（继承 RFC-2 / RFC-3 Phase A 形成的工作流）：

- 不再每步等确认，连续推进
- 每个阶段必须 `tsc + lint(91w·20e 持平) + vitest + build + e2e 6/6` 全绿才 commit
- commit message 含中文 → `git commit -F /tmp/commit-msg.txt`
- 重写 `/tmp/commit-msg.txt` 前必须先 read 一次
- commit 前 `git checkout -- next-env.d.ts`
- 抽出/新增代码必须读源码确认类型签名，不凭印象
- vitest 跑不到 server-only：纯函数与 IO 严格分离

---

## 2. Phase B：4 阶段执行回顾

### 2.1 阶段成果一览

| 阶段 | commit | 新增文件 | 修改文件 | 关键产物 |
|---|---|---|---|---|
| B1 | `b204834` | `lib/search/{types,tokenize,tokenize.test,index,index.test}.ts` | — | SearchDoc/Hit/Index 类型 + tokenizer + BM25-lite 索引 + 27 单测 |
| B2 | `571a4cf` | `lib/search/{extract,extract.test,build-index}.ts` | — | 接 SDK `AgentMessage` union 抽文本 + IO 入口 + 17 单测 |
| B3 | `d45c71a` | `app/api/search/{route,cache}.ts` | — | POST 路由 + 内存懒构建 + fingerprint invalidate |
| B4 | `81ee345` | `app/hooks/useSearch.ts` + `app/components/SidebarSearch.tsx` | `app/components/Sidebar.tsx` + `app/ChatApp.tsx` | useSearch hook + 搜索结果视图 + Sidebar 搜索框接入 |

### 2.2 阶段 B1：lib/search 骨架（纯函数）

**目标**：在零 IO、零 server-only、零 SDK 依赖的前提下，跑通 tokenize + build + search 的核心算法，单测覆盖所有边界。

**产物**：

- `lib/search/types.ts`（~85 行）：
  - `SearchDoc`：sessionId + cwd + name? + builtAt + entries[]
  - `SearchEntry`：entryId + kind（`user|assistant|bash|summary|name`）+ text
  - `SearchHit`：entryId + kind + snippet + matchedTokens + score
  - `SearchResult`：sessionId + cwd + name? + score + hits[]
  - `SearchIndex`：tokens Map + docs Map + builtAt + fingerprint
  - `SearchResponse`：results[] + totalDocs + builtAt + durationMs

- `lib/search/tokenize.ts`（~85 行）：
  - `tokenize(text)`：英文 `[a-z0-9]+` 整词 + CJK `[\u4e00-\u9fff]` 单字 & 相邻 bigram
  - `tokenizeQuery(query)`：同上 + dedupe
  - 完全零依赖

- `lib/search/index.ts`（~155 行）：
  - `buildIndex(docs)`：倒排索引（token → Set<entryRef>）
  - `search(index, query, limit)`：BM25-lite 评分（distinct token IDF 加权 + hit count log 封顶 10）+ snippet 前后 40 字符

**单测覆盖**（27 cases）：
- tokenize：14 cases（英文/中文/混合/标点/控制符/CJK bigram/超长 token）
- index：13 cases（空 corpus/单 doc/多 doc/中文 bigram 命中/snippet 边界/score 排序）

**关键设计取舍**：

| 决策 | 取舍 |
|---|---|
| 自写 tokenizer，不用 lunr/minisearch | 减少 bundle 和 RAM；CJK 单字+bigram 模式更可控 |
| BM25-lite 而非完整 BM25 | distinct token IDF + hit count log 即够区分度；省 doc length normalization |
| Snippet 前后各 40 字符 | 移动端友好；命中位置过长加 `…` 减少视觉噪音 |
| 评分 hit count 封顶 10 | 防止单 entry 大量重复词把短句压下去 |

**门禁**：tsc clean / lint 91w·20e 持平 / vitest 135/135 / build clean / e2e 6/6（9.0s）

### 2.3 阶段 B2：接 SDK 抽文本 + IO 层

**目标**：把 SDK 的 `AgentMessage`（`Message` from pi-ai + 4 个 custom role from pi-coding-agent）按 entry 类型抽成搜索文本；与 IO 层（`listAllSessions` + `getSessionDetail`）严格分离，让 extract 纯函数可被 vitest 跑。

**产物**：

- `lib/search/extract.ts`（~160 行，纯函数）：
  - `extractTextFromEntry(entry)`：按 `entry.type` 分发
    - `message`：按 `role` 分（user / assistant 取 text/content，跳过 thinking/toolCall/toolResult/image）
    - `bashExecution`：command + output 截 2000 字
    - `compactionSummary` / `branchSummary`：summary 文本
    - 跳过：toolCall/toolResult/thinking_level_change/model_change/custom/label/custom_message
  - `buildSearchDocFromSession(session, ctx)`：把上述抽完，加入 session_info name
  - **只 import type** 自 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai`，确保零运行时 SDK 依赖
  - **不 import `lib/sessions`**（含 server-only），保证 vitest node env 能跑

- `lib/search/build-index.ts`（~35 行，IO 层）：
  - `buildSearchIndexFromAllSessions()`：listAll → for each session → getSessionDetail → buildSearchDocFromSession → buildIndex
  - 这一层就是 server-only 的（间接 import `lib/sessions`）

**单测覆盖**（17 cases）：
- 各种 entry type / message role / 跳过类型
- thinking entry / toolCall entry / image content / label / custom message 全跳过
- bash command 取，output 截断 2000 字符
- compactionSummary / branchSummary 取
- session_info name 入索引

**关键设计取舍**：

| 决策 | 取舍 |
|---|---|
| 纯函数 / IO 严格分离 | 解决 vitest 不能跑 server-only 文件的根本问题；以后增量索引同样吃到这个分层 |
| `import type` 拿 SDK 类型 | 零运行时依赖，bundle 不胖 |
| bash output 截 2000 字符 | 真实场景下 `find /` 这类输出可能数 MB，无截断会爆 RAM |
| 跳过 thinking | 思维链文本对"我在找什么"没价值，且占索引很大 |
| 跳过 toolCall args / toolResult | args/result 是 JSON 结构噪音多，bash command 单独抽更准 |

**门禁**：tsc clean / lint 91w·20e 持平（顺手清掉一条多余 eslint-disable）/ vitest 152/152 / build clean / e2e 6/6（8.3s）

### 2.4 阶段 B3：POST /api/search 路由 + 内存懒构建

**目标**：暴露 HTTP 入口，让 client 不用管索引构建/失效；用 fingerprint 控制重建时机。

**产物**：

- `app/api/search/route.ts`（~65 行）：
  - POST `{ query, limit? }` → `SearchResponse`
  - 空 query → 400 `"query is required"`
  - limit 钳到 [1, 200]，默认 50
  - 错误统一 500 `{ error }`
  - **不导出 cache helper**（Next route 不允许 HTTP 方法之外的 export）

- `app/api/search/cache.ts`（~55 行，路由内部辅助）：
  - module-level cache 单例
  - `getSearchIndex()`：按 session list 指纹决定 cache hit 还是重建
  - fingerprint = `(max(session.modified) ms, sessionCount)`
    → 新建/删除/任一 session 内容变更（modified 更新）都触发 invalidate
  - `__invalidateSearchCache()` 供测试 / dev
  - 不做 in-flight promise dedup（v0 用户量小，并发冷构建无所谓）

**为何拆 `cache.ts`**：第一版把 `__invalidateSearchCache` 直接 export 在 `route.ts`，Next build 报 `__invalidateSearchCache is not a valid Route export field`。拆出独立文件后路由保持纯 HTTP 方法导出。

**手工烟测**（dev server :3000，本地 9 个 session）：

| case | 结果 |
|---|---|
| 首次 POST `{query:"采购"}` | 376ms 冷构建 + 命中 1 session 5 hits |
| 第二次同 query | cache hit 即时返回（<10ms）|
| POST `{}` 空 query | 400 `"query is required"` |
| Snippet 含 `…前后省略号` | ✓（命中处前后超 40 字加省略号） |

**关键设计取舍**：

| 决策 | 取舍 |
|---|---|
| 单例 cache 而非每请求构建 | 9 session ~400ms / 100 session 估算 ~4s，每请求重建不可接受 |
| fingerprint 用 modified 而非 hash | 修改 session 内容时 SDK 会更新 modified；零计算成本 |
| sessionCount 也入指纹 | 防止删了 session 但 max(modified) 不变（极端情况）|
| invalidate 即全量重建 | v0 用户量小可接受；增量 patch 留后续 |

**门禁**：vitest 152/152 持平 / lint 91w·20e 持平 / tsc clean / build clean（路由表新增 `/api/search`）/ e2e 6/6（10.2s）

### 2.5 阶段 B4：useSearch hook + Sidebar 搜索 UI

**目标**：让 Sidebar 接入搜索；最小入侵 Sidebar 与 ChatApp；hook 自带 state 又不触发 `react-hooks/set-state-in-effect`。

**产物**：

- `app/hooks/useSearch.ts`（~160 行）：
  - 自带 state：`query` / `status('idle'|'loading'|'ready'|'error')` / `results[]` / `builtAt` / `totalDocs` / `durationMs` / `error`
  - 与 useSessionMeta 不同：必须带 state，没有上层数据源可聚合
  - debounce 200ms：useEffect 起 setTimeout，setState 都在异步回调里 → 避开 `react-hooks/set-state-in-effect`
  - 空 query 清结果：`queueMicrotask` 包裹 setState（异步边界外）
  - `latestQueryRef` race 防护：用户改 query 后过期请求结果丢弃
  - 暴露 `isActive = query.trim().length > 0` 给 UI 决定是否替换列表

- `app/components/SidebarSearch.tsx`（~175 行）：
  - 受控：query / status / results / sessionLookup 全 props 传入
  - `highlight()`：按 matchedTokens 大小写不敏感包裹 `<mark>`，长 token 优先排序避免短 token 抢占
  - 顶部状态行：搜索中… / N 命中·M 索引 / 错误 + 右侧 durationMs
  - 每条命中：title + 短 cwd + 前 3 个 hit snippet + "+N 处更多"
  - 不调任何 API / 不管 cache / 不引入业务

- `app/components/Sidebar.tsx`（+ 73 行）：
  - 3 个可选 prop：`searchQuery?` / `onSearchQueryChange?` / `searchView?`
  - cwd 下方插搜索框（lucide `Search` 图标 + 受控 input + `X` 清除按钮）
    - `onSearchQueryChange` 未传时不渲染搜索框（向后兼容）
  - sessions 列表外层加 `{!searchView && (...)}` 守门
  - searchView 非 null 时完全替代普通列表

- `app/ChatApp.tsx`（+ 36 行）：
  - 实例化 `useSearch` hook
  - `sessionLookup` = `useMemo(Map<id, {cwd, title}>)`，title = `meta.title || name`
  - 给 Sidebar 传三个新 prop；isActive 时挂 `<SidebarSearch>`
  - `onSelect` 实现：`searchHook.clear() + setSelectedId(id)`
    → 选中后退出搜索态，回到普通列表（高亮目标 session）

**关键设计取舍**：

| 决策 | 取舍 |
|---|---|
| Sidebar 3 个可选 prop（不传时向后兼容）| Sidebar 还有其他调用点的话不强制改造 |
| searchView 是 `ReactNode \| null` 而非 boolean | Sidebar 不参与组件实例化，避免 props 爆炸 |
| 选中结果后 clear + setSelectedId | 用户预期：搜索是"找到再回到正常工作流"，不该停在搜索态 |
| highlight() 长 token 优先 | 避免子串问题：搜 `"hello world"` 时 `world` 不应被 `wo` 抢占 |
| 不做 entry 锚点跳转 | v0 用户量小；点 session 后 ChatApp 已有 cmd+f 兜底；锚点要 ChatApp 引入新的 scrollToEntryId 协议 |

**门禁**：tsc clean / lint 91w·20e 持平 / vitest 152/152 / build clean / e2e 6/6（7.2s）

---

## 3. 整体数据流图

```
        ┌──────────────────────────────────┐
        │ ~/.diga-agent-sessions/             │
        │   <jsonl session files>          │  ← SDK 写
        │ ~/.diga-agent/sessions/             │
        │   {id}.meta.json                 │  ← Phase A 写
        └─────────────────┬────────────────┘
                          │ listAll + getSessionDetail
                          ▼
              ┌──────────────────────┐
              │ lib/sessions.ts      │   (server-only)
              └─────────┬────────────┘
                        │ SessionInfo[] + ContextEntry[]
                        ▼
              ┌──────────────────────┐
              │ lib/search/          │   B2: 接 SDK union 抽文本
              │   build-index.ts     │
              └─────────┬────────────┘
                        │ buildSearchDocFromSession (per session)
                        ▼
              ┌──────────────────────┐
              │ lib/search/          │   B1: 纯函数
              │   extract.ts         │   按 entry.type / message.role 分发
              │   (pure)             │   bash 截 2000 / 跳 thinking / 跳 image
              └─────────┬────────────┘
                        │ SearchDoc { entries[] }
                        ▼
              ┌──────────────────────┐
              │ lib/search/          │   B1: 纯函数
              │   index.ts           │   tokenize → 倒排 → BM25-lite + snippet
              │   (pure)             │
              └─────────┬────────────┘
                        │ SearchIndex { tokens, docs, fingerprint }
                        ▼
              ┌──────────────────────┐
              │ app/api/search/      │   B3: 单例 cache，fingerprint invalidate
              │   cache.ts           │
              └─────────┬────────────┘
                        │ getSearchIndex()
                        ▼
              ┌──────────────────────┐
              │ app/api/search/      │   B3: POST {query, limit?} →
              │   route.ts           │       search(index, query, limit)
              └─────────┬────────────┘
                        │ SearchResponse
                        ▼
              ┌──────────────────────┐
              │ app/hooks/           │   B4: state + debounce + race
              │   useSearch.ts       │
              └─────────┬────────────┘
                        │ {query, results, status, ...}
            ┌───────────┴───────────────┐
            ▼                           ▼
   ┌──────────────────┐        ┌──────────────────────┐
   │ Sidebar          │        │ SidebarSearch        │  B4
   │  (受控搜索框)    │        │  (受控视图 + 高亮)   │
   │  searchView 挂载 │◀───────│                      │
   └──────────────────┘        └──────────────────────┘
```

数据流的关键时序（用户输入 `采购`）：

| 事件 | useSearch state | server | UI |
|---|---|---|---|
| keystroke `采` | query=`采` 立刻入 state | — | 搜索框显示 `采` |
| 200ms debounce timer 起 | — | — | — |
| keystroke `购`（150ms 后） | query=`采购`，旧 timer 清掉 | — | 搜索框显示 `采购` |
| 200ms 到期 | status=loading | — | SidebarSearch 顶 "搜索中…" |
| fetch POST `/api/search` | — | cache.fingerprint 比对：first call → 冷构建 376ms | — |
| 200 + SearchResponse | status=ready, results=[...] | — | SidebarSearch 列出命中 + 高亮 |
| 用户点结果 | clear() → query="" | — | searchView=null → 回到普通列表，目标 session 高亮 |

---

## 4. 接缝清单（Phase C / F3 可复用）

Phase B 留下 7 个干净接缝：

| 接缝 | 用途 | 示例扩展 |
|---|---|---|
| `lib/search/types.ts` `SearchEntry.kind` | entry 分类 | F3 加 `kind:"summary"` 把自动摘要也入索引 |
| `lib/search/extract.ts` pure | 抽取层 | F4 项目级记忆来后，per-cwd 索引可复用同一抽取 |
| `lib/search/build-index.ts` IO 层 | 索引入口 | 加增量更新只改这层（per-session diff）|
| `app/api/search/cache.ts` fingerprint | invalidate 触发 | 替换 fingerprint 函数即可换策略（per-cwd / etag）|
| `useSearch` hook | client state | Cmd+K portal 复用，只是输入框迁到全局 |
| `Sidebar.searchView` prop | UI 插槽 | searchView 可替换为别的"侧栏视图"（如未来 "活动" 视图） |
| `sessionLookup` Map | client 端 session 元信息 | F3 命中项展示 summary 时直接 lookup |

---

## 5. 未做的 / 留给下一轮

### 5.1 已显式 out-of-scope

| 项 | 留给 | 原因 |
|---|---|---|
| F3 自动摘要 | 独立 phase | 涉及 LLM provider 选择 + 成本预算 + prompt 工程，规模与 F2 不在一个量级 |
| 索引持久化 | 后续 | v0 进程内存；100 session 冷构建 ~4s 用户能接受；持久化需要决定 schema + invalidate 协议 |
| 索引增量更新 | 后续 | v0 fingerprint mismatch 即全量重建；增量要 per-session diff，节奏更复杂 |
| in-flight promise dedup | 后续 | v0 用户量小，并发冷构建多耗几百 ms 无感 |
| Cmd+K 全局唤起 | 后续 | 需要 portal + 全局快捷键管理；先嵌 Sidebar 验证检索质量 |
| 跳转到 entry 锚点 | 后续 | 需要 ChatApp 引入 scrollToEntryId 协议 + Anchor 渲染 |
| 命中 hover 预览 | 后续 | 视觉决策待定，且需要把更多文本传到 client |
| Settings 改索引参数 | 后续 | v0 参数固定（200ms debounce、50 limit、2000 字 bash 截断）|

### 5.2 已知 sharp edges

1. **冷构建期 UI 假死风险**：第一次搜索时 server 在 fingerprint miss 后 sync 重建索引，期间 `/api/search` 占住一个 worker。100 session 估算 ~4s，1000 session 可能 40s。用户量小可接受，但 client 端没有 timeout 提示。后续应加 server-side timeout + client 端 "索引构建中…" 文案。
2. **fingerprint 假阴性场景**：如果用户外部直接 `touch` 一个 jsonl 但不改内容，`modified` 变了 → 触发重建。无害但多耗算力。理论可换成 content-hash，但 listAll 时算 hash 成本高。
3. **bash output 截 2000 字符可能漏命中**：如果命中词在 bash output 第 2001 字符之后会漏。v0 用户场景下罕见，但需要 docs 提示。
4. **tokenizer 不分词中文短语**：搜 `"大语言模型"` 实际拆成 `大语 语言 言模 模型` 4 bigram + 5 单字，无法整体匹配。如果需要短语精确，将来加 phrase mode。
5. **score 没归一化**：BM25-lite 的 raw score 不在 [0, 1]，client 拿到也只用排序。如果 UI 要显示 "相关度 80%" 进度条，要二次归一。
6. **没做 e2e 覆盖搜索**：6/6 e2e 全是 RFC-1 时代的 multi-session 用例，没加 "输入 query → SidebarSearch 渲染 → 点击跳转" 的 end-to-end 测试。是欠账，留给下一轮 Phase 收尾时补一条。
7. **searchHook 离开当前 Sidebar 后不会卸载**：用户搜完点结果，state 是 INITIAL（clear），但 hook instance 留着。无 leak 但 dev tools 看着多一个 useState。

---

## 6. 复盘：本轮做对的 5 件事

1. **B1 完全无 IO、无 SDK、无 server-only**：纯函数层（types + tokenize + index）一上来就 27 个单测覆盖所有边界，后面 B2 接 SDK / B3 接 API / B4 接 UI 时算法层零不确定性。任何 search 结果不对都能锁定到 extract 或 cache，不会再怀疑评分函数。
2. **B2 纯函数 / IO 严格分离**：发现 `lib/sessions.ts` 含 `server-only` 后果断把 extract（纯函数）和 build-index（IO）分两个文件，前者 vitest 跑 17 cases，后者只在 server 跑。这个分层让以后增量索引 / per-cwd 索引可以复用 extract 而不动 IO。
3. **B3 fingerprint 设计**：`(maxModified, sessionCount)` 二元组够区分所有"用户能感知的变化"，零计算成本，且 SDK 写 session 时 modified 自动更新——完全不用我们额外打 hook。比 etag/content-hash 简单一个数量级。
4. **B4 直接接 Sidebar 而非 Cmd+K**：用户预期是 "在哪里找 session 就在哪里搜"，Sidebar 已经是 session 列表的家，搜索框塞进去最直觉。Cmd+K portal 需要全局快捷键 + 浮层，价值重叠先不做。
5. **commit message 含取舍 + 烟测**：每个 commit message 写"为什么这么选 / 拒了什么方案 / 手工烟测了什么"，特别是 B3 的烟测（376ms 冷构建、中文 "采购" 5 hits）半年后回看还能 instantly 重现当时的判断依据。

---

## 7. 复盘：本轮可以更好的 3 件事

1. **B3 cache.ts 拆分被 build 教育**：第一版把 `__invalidateSearchCache` 直接 export 在 `route.ts`，Next build 报 `not a valid Route export field`。这个限制在 Next 13+ 的 app router 文档里写了但没默念过。教训：**Next route 文件只能 export HTTP 方法**，下次写 route 前先 mental check 这一条；任何辅助函数立刻拆 sibling 文件。
2. **B4 useSearch 的 react-hooks 规则规避手法不优雅**：`queueMicrotask` 包 setState、`setTimeout` 异步回调里 setState 都是为了绕开 `react-hooks/set-state-in-effect`，本质是在和 lint 规则斗智。规则不允许是有道理的（这类 setState 容易让 effect 二次触发），更干净的方案可能是 `useDeferredValue(query)` 或 React 19 的 `useActionState`。下次重写时该试。
3. **没补 e2e**：跟 Phase A 一样，新功能的 end-to-end 没加 playwright case。6/6 全是 RFC-1 用例，搜索这条路径没有自动回归保护。下一轮 F3/F4 收尾时一并补 `e2e/02-search.spec.ts`。

---

## 附录 A：commit 清单

```
81ee345 feat(search): Sidebar 接入全文检索 UI（RFC-3 Phase B4）
d45c71a feat(search): 新增 POST /api/search 路由 + 内存索引懒构建（RFC-3 Phase B3）
571a4cf feat(search): 接入 SDK 抽取 session 文本 + 全量索引 IO 层（RFC-3 Phase B2）
b204834 feat(search): 新增 lib/search 类型 + tokenizer + 内存倒排索引（RFC-3 Phase B1）
```

## 附录 B：新增 / 修改文件清单（B1 → B4 累计）

**新增**：

```
lib/search/types.ts                ~85   SearchDoc/Entry/Hit/Result/Index/Response 类型
lib/search/tokenize.ts             ~85   tokenize() + tokenizeQuery()
lib/search/tokenize.test.ts       ~115   14 cases
lib/search/index.ts               ~155   buildIndex() + search() (BM25-lite + snippet)
lib/search/index.test.ts          ~140   13 cases
lib/search/extract.ts             ~160   按 entry.type / message.role 抽文本（纯函数）
lib/search/extract.test.ts        ~300   17 cases
lib/search/build-index.ts          ~35   IO 入口：listAll → for each → buildSearchDocFromSession → buildIndex
app/api/search/route.ts            ~65   POST {query, limit?} → SearchResponse
app/api/search/cache.ts            ~55   单例 cache + fingerprint invalidate
app/hooks/useSearch.ts            ~160   state + debounce + race 防护
app/components/SidebarSearch.tsx  ~175   受控视图 + highlight()
                                  -----
                                 ~1530    总
```

**修改**：

```
app/components/Sidebar.tsx        ~+73   +searchQuery/onSearchQueryChange/searchView 3 prop
                                          + cwd 下方搜索框 + sessions 守门
app/ChatApp.tsx                   ~+36   useSearch + sessionLookup memo + Sidebar 三 prop 接入
```

## 附录 C：与 RFC-2 / RFC-3 的关系

```
RFC-1（已完成）
  └─ RFC-1.5 / RFC-test-infra（已完成）
      └─ RFC-2 Phase A（已完成）—— 会话级 Budget MVP
          └─ RFC-2 Phase B（已完成）—— 工具审批
              └─ RFC-2 Phase C（未启动）—— 意图预览 + Edit + Deny remember
                  └─ pet 形态弹窗集成（已规划）
              └─ RFC-3 Phase A（已完成）—— Session 元数据 (F1)
                  └─ RFC-3 Phase B（本文，已完成）—— 全文检索 (F2)
                      ↑
                      └─ Phase A 的 meta.title 在 Phase B 的 sessionLookup 里作为 title 来源
                      └─ Phase A 的 SessionInfoLite.meta? 让命中结果可以直接显示 title
                  └─ F3 自动摘要（独立 phase，未启动）
                  └─ RFC-3 Phase C（未启动）—— 项目级记忆 (F4)
                      ↑
                      └─ 可复用 Phase B 的 extract.ts 做 per-cwd 索引
                      └─ 可复用 Phase A 的 ~/.diga-agent/ 路径约定
```

---

**本回顾写完 = Phase B 全部收尾。下一轮启动 F3 时，建议从 "选 LLM provider + 摘要 prompt 工程 + 触发节奏（每 N 轮 / 主动 / cron）" 三个独立决策开始。**
