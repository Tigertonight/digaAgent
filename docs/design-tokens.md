# mini-pi-web ↔ @agegr/pi-web Design Token 对齐表

> 目的：把上游 pi-web（v0.6.12）当前生效的 design token 抽出来，跟 mini-pi-web 现状对照，给视觉对齐提供唯一事实源。
>
> 抽取来源：
> - mini：`app/globals.css`、`tailwind.config.ts`
> - 上游：`node_modules/@agegr/pi-web/.next/static/css/d8436f2994e6e1d7.css`（编译产物，无源码）

---

## 1. 颜色

### 1.1 命名差异（这是最大的偏差）

mini 的命名偏"语义层级"（`bg-app` / `bg-panel` / `bg-panel-2`），上游偏"交互角色"（`bg` / `bg-hover` / `bg-selected`）。**建议统一到上游命名**，未来跟随上游升级零摩擦，并且交互态命名更直接。

| 角色 | mini 当前 | 上游 | 目标值（光） | 目标值（暗） | 说明 |
|---|---|---|---|---|---|
| 页面底色 | `--bg-app` | `--bg` | `#fff` | `#1a1a1a` | mini 暗色用了 `#0a0a0a` 太黑，跟随上游调亮 |
| 面板/卡片 | `--bg-panel` | `--bg-panel` | `#f5f5f5` | `#242424` | mini 暗色 `#171717`，上游 `#242424` 更柔 |
| hover | （无） | `--bg-hover` | `#eee` | `#2e2e2e` | **mini 缺**，要补 |
| 选中态 | （无） | `--bg-selected` | `#e8e8e8` | `#383838` | **mini 缺**，要补 |
| 极淡叠加层 | （无） | `--bg-subtle` | `#00000008` | `#ffffff0a` | **mini 缺**，用于卡片 hover/分组背景 |
| 边框 | `--border` | `--border` | `#e0e0e0` | `#3a3a3a` | mini 暗色 `#404040` 偏重，建议跟随 |
| 软边框 | `--border-soft` | （合并到 `--border`） | — | — | mini 自创，建议删除 |
| 文字主 | `--fg` | `--text` | `#1a1a1a` | `#e8e8e8` | 改名为 `--text` |
| 文字次 | `--fg-muted` | `--text-muted` | `#6b7280` | `#9ca3af` | 改名 |
| 文字弱 | `--fg-faint` | `--text-dim` | `#9ca3af` | `#6b7280` | 改名 |
| 主色 | `--accent` | `--accent` | `#2563eb` | `#60a5fa` | mini 暗色复用了亮色蓝，**上游暗色用浅蓝**视觉舒服得多 |
| 主色 hover | `--accent-hover` | `--accent-hover` | `#1d4ed8` | `#93c5fd` | mini 暗色用深色 hover 是反的，要修 |

### 1.2 角色色（mini 全部缺，需要新增）

这些是上游用来区分"消息来源"和"工具卡"的关键 token：

| 角色 | 上游 light | 上游 dark | 用途 |
|---|---|---|---|
| `--user-bg` | `#eff6ff`（极淡蓝） | `#1e293b`（深蓝灰） | 用户消息气泡底色 |
| `--assistant-bg` | `#fff` | `#1a1a1a` | assistant 消息底色（贴页面底） |
| `--tool-bg` | `#f9fafb` | `#1f2937` | 工具调用卡片底色 |

> mini 现状：用户消息直接用 `bg-blue-600`（Tailwind），assistant 消息没专属 bg。需要切换到这套 token。

### 1.3 推荐新色板（mini 目标值）

```css
:root {
  --bg: #ffffff;
  --bg-panel: #f5f5f5;
  --bg-hover: #eeeeee;
  --bg-selected: #e8e8e8;
  --bg-subtle: rgba(0, 0, 0, 0.03);
  --border: #e0e0e0;
  --text: #1a1a1a;
  --text-muted: #6b7280;
  --text-dim: #9ca3af;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --user-bg: #eff6ff;
  --assistant-bg: #ffffff;
  --tool-bg: #f9fafb;
}

html.dark, :root[data-theme="dark"] {
  --bg: #1a1a1a;
  --bg-panel: #242424;
  --bg-hover: #2e2e2e;
  --bg-selected: #383838;
  --bg-subtle: rgba(255, 255, 255, 0.04);
  --border: #3a3a3a;
  --text: #e8e8e8;
  --text-muted: #9ca3af;
  --text-dim: #6b7280;
  --accent: #60a5fa;
  --accent-hover: #93c5fd;
  --user-bg: #1e293b;
  --assistant-bg: #1a1a1a;
  --tool-bg: #1f2937;
}
```

> 注意：上游同时支持 `prefers-color-scheme` 和 `html.dark` class。mini 现在用 `[data-theme]` attr，**保留即可**，把 selector 写成 `:root[data-theme="dark"]` 兼容上游 token 一一对应。

---

## 2. 字体（最显著的视觉差异）

### 2.1 现状对比

| 维度 | mini | 上游 |
|---|---|---|
| body font | `ui-sans-serif, system-ui, ...` | **`Noto Sans Mono`**（默认全站等宽！） |
| code/pre | 跟随 body（sans） | `--font-noto-mono`、`JetBrains Mono`、`Fira Code`... |
| body font-size | 16px（浏览器默认） | **`14px`** |
| body line-height | 浏览器默认（~1.5） | **`1.7`** |
| 数字 | 比例宽度 | `tabular-nums`（命中数字对齐） |
| `word-break` | 默认 | `break-word`（长字符串自动断行） |

### 2.2 建议（这是最影响"产品感"的一项）

**全局 body 改为等宽字体 + 14px / 1.7**。这一项做完后，从 spacing 到信息密度的观感都会向上游靠拢。

```css
body {
  font-family:
    var(--font-noto-mono),
    "JetBrains Mono",
    "Fira Code",
    ui-monospace,
    SFMono-Regular,
    Menlo,
    "PingFang SC",
    "Microsoft YaHei",
    monospace;
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  font-variant-numeric: tabular-nums;
}
```

> Noto Sans Mono 是 Google Font，建议用 `next/font/google` 自托管避免运行时拉取。
>
> **风险点**：等宽字体下中文字符宽高比会被拉大。上游靠 fallback 到 `PingFang SC` / `Microsoft YaHei` 解决，中文实际还是用系统字体——这套 fallback 链直接抄即可。

### 2.3 排版尺度（上游编译产物里能看到的）

| 用途 | 值 |
|---|---|
| body | 14px / 1.7 |
| 较小内联（`small`、code 内嵌） | `80%`、`75%`（用 em） |
| 标题（h1/h2/h3） | `1.8em` / `1.4em` / `1.15em`（typography 默认） |
| 紧凑信息（侧栏 meta） | 13px |

---

## 3. 圆角

| 用途 | mini 当前 | 上游 | 建议 |
|---|---|---|---|
| 默认按钮/卡片 | Tailwind `rounded`（4px） / `rounded-md`（6px）混用 | `6px` 为主，`3px` 为次 | 统一 **6px** 主、**3px** 次 |
| 圆形（头像/胶囊按钮） | `rounded-full` | `border-radius: 9999px` | 一致 |
| 输入框 | `rounded-md` | `6px` | 一致 |

上游 token 里只见到 `0` / `2px` / `3px` / `6px` / `9999px` 几档，**没有大圆角**。mini 现在大圆角（`rounded-lg`/`rounded-xl`）是要削减的方向。

---

## 4. 间距

上游用 Tailwind 4 的 `--spacing: 0.25rem`（即 `1` = 4px），mini 用 Tailwind 3 默认（也是 4px 步进），**底层一致**。

差异来自**用法**：上游元素之间的 gap 普遍比 mini 紧凑。建议遵循：

| 场景 | mini 现状 | 目标（沿用上游观感） |
|---|---|---|
| 顶栏内边距 | `px-4 py-3` | `px-3 py-2` |
| 侧栏会话条目 | 多行（4 行）`p-3` | 两行 `px-3 py-2` |
| 模态内边距 | `p-6` | `p-4` |
| 表单字段间距 | `space-y-4` | `space-y-3` |

---

## 5. 阴影

上游几乎不用 box-shadow，唯一一处是**侧栏展开态的右侧阴影** `4px 0 20px rgba(0,0,0,0.15)`。

mini 现在的 modal 用了 Tailwind `shadow-xl`，会跟整体扁平风格冲突。建议：
- modal/popover：用 1px border 替代阴影；或者非常轻的 `0 2px 8px rgba(0,0,0,0.08)`
- 侧栏：抄上游那一条

---

## 6. 过渡动画

| token | mini | 上游 |
|---|---|---|
| `--default-transition-duration` | 120ms（globals.css 的 body 上） | **150ms** |
| `--default-transition-timing-function` | `ease` | **`cubic-bezier(.4, 0, .2, 1)`**（也就是 Tailwind 默认） |

建议跟随上游 150ms + Tailwind cubic-bezier。

---

## 7. 图标系统

| | mini | 上游 |
|---|---|---|
| Provider 图标 | emoji（🔑🧠🔧🗂⚙） | `@lobehub/icons`（每个 provider 有专属 SVG brand 图标） |
| 工具按钮 | emoji + 单字符 | 文字 label（`Branches` / `System`）或 icon |
| 主题切换 | `☾` / `☀` 字符 | sun/moon SVG |

上游的 `@lobehub/icons` 提供 OpenAI / Anthropic / Google / MiniMax 等几十个 provider brand。

> 推荐安装：`@lobehub/icons`。它是 ESM-only + tree-shake，按需引入零开销。

---

## 8. Token 改造影响面

下面这些文件会被改动。提前列出来，以便审计：

| 文件 | 改什么 |
|---|---|
| `app/globals.css` | 重写 token 表（命名 + 颜色） |
| `app/layout.tsx` | 引入 `next/font/google` 加载 Noto Sans Mono |
| `tailwind.config.ts` | 把 token 暴露成 Tailwind utility（如 `bg-panel` / `text-muted`） |
| `app/ChatApp.tsx` | 用户/assistant 消息气泡换用 `--user-bg` / `--assistant-bg` |
| `app/components/*.tsx` | 把硬编码的 Tailwind 灰阶（`bg-neutral-900` 等）替换为 token utility |

---

## 9. 不抄的 token

记录下哪些 token 看到了但**故意不抄**：

- 上游的 `prefers-color-scheme: light` 自动切换 — mini 已经有 `[data-theme]` 手动切换，更可控。
- `--font-mono` 和 `--font-sans` 拆开 — 上游全局都用等宽，mini 跟随，不需要 sans/mono 分流。
- 上游用 `oklch()` 写颜色（`--color-red-400: oklch(...)`） — Tailwind 4 才默认带的，mini 还在 v3，先用 hex。
