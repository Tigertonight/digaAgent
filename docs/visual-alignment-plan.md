# diga-agent 视觉对齐 plan（v1）

> 目标：把 diga-agent 的视觉/布局，向上游 `@agegr/pi-web` 0.6.12 拉齐到"看起来同一家产品"的程度，但**不引入上游已知的坑**（独立 page 路由 prod 加载失败、文件树过度展开等）。
>
> 前置：[`docs/design-tokens.md`](./design-tokens.md) 是本 plan 的事实源。所有颜色/字号引用以那份为准。

---

## 范围与不在范围

**做**：颜色/字体/圆角/间距/图标系统、首屏 hero、输入区控件改造、文件树侧栏化、token meter。
**不做**：Branches/System 顶部 tab（业务必要性未验证）、Tailwind 4 升级（体力活无新能力）、上游 `~` 全局 explorer（反例）。

---

## 阶段划分

```
P0  视觉地基（token + 字体 + 主题）        ── 一次合并、影响全局
P1  控件级 UI 替换（按钮/输入区/侧栏）      ── 可拆开多个 PR
P2  布局级改造（hero / 文件树侧栏 / meter）  ── 需要交互验证
```

每个阶段结束都应该能跑、能截图，作为对比节点。

---

# P0：视觉地基

## P0-1：写新 token（globals.css 改造）

**改的文件**：`app/globals.css`

**改动**：
- 把 `--bg-app` / `--bg-panel` / `--bg-panel-2` / `--border-soft` / `--fg` / `--fg-muted` / `--fg-faint` 全部更名 + 调值，对齐 `docs/design-tokens.md` §1.3
- 新增 `--bg-hover` / `--bg-selected` / `--bg-subtle` / `--user-bg` / `--assistant-bg` / `--tool-bg`
- `--default-transition-duration` 改 150ms

**风险**：组件里大量 `var(--bg-app)` `var(--fg)` 直接引用旧名，会全失效。

**对策**：先在 globals.css 里**保留旧名作为 alias**（指向新值），新组件用新名，逐步迁移。

```css
/* 旧名 alias，迁移完一处删一处 */
--bg-app: var(--bg);
--fg: var(--text);
--fg-muted: var(--text-muted);
--fg-faint: var(--text-dim);
--bg-panel-2: var(--bg-selected);
--border-soft: var(--border);
```

**验证**：跑 `npm run dev`，肉眼对比首页/聊天/各模态前后，颜色不能错乱。

**预计**：30 min

---

## P0-2：默认浅色主题

**改的文件**：`app/layout.tsx`

**改动**：
- `<html data-theme="dark">` 改为 `data-theme="light"`
- `themeBootstrap` 里的 fallback 从 `"dark"` 改 `"light"`

**理由**：上游默认浅色，浅色对中文长文本和代码可读性更好。dark 仍可手动切。

**风险**：现有用户 localStorage 里没存过 `pi-theme` 的会突然变浅色，是否会反感。

**对策**：写一行 release note 即可。这是单机 self-host 工具，影响面小。

**预计**：5 min

---

## P0-3：上等宽字体

**改的文件**：`app/layout.tsx`、`app/globals.css`

**改动**：
- `app/layout.tsx` 用 `next/font/google` 引入 `Noto_Sans_Mono`，导出 CSS 变量 `--font-noto-mono`
- `globals.css` 的 `body` font-family 改成 mono fallback 链，font-size 14px，line-height 1.7，加 `font-variant-numeric: tabular-nums`

```tsx
// layout.tsx
import { Noto_Sans_Mono } from "next/font/google";
const notoMono = Noto_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-noto-mono",
  display: "swap",
});
// <html className={notoMono.variable}>
```

**风险**：
1. **中文显示**：等宽字体下中文字符会被拉宽。靠 fallback 到 `PingFang SC` / `Microsoft YaHei` 解决（中文实际由系统字体渲染）。
2. **既有 `text-xs` `text-sm` 的视觉权重**：14px 基线变了，所有 Tailwind 字号映射会偏移。需要全站快速过一遍，重点是 `text-xs`（变 12px，会更小）。
3. **Electron 离线场景**：Google Fonts 拉不下来。`next/font` 已经把字体打进构建产物，**离线也能用**，无需担心。

**验证**：在中文/英文混排的会话里看显示，对比 `/tmp/pi-compare/upstream-chat.png`。

**预计**：30 min（含字号 regression 修复）

---

## P0-4：把 token 暴露成 Tailwind utility

**改的文件**：`tailwind.config.ts`

**改动**：把 token 接到 `theme.extend.colors`，让组件能写 `bg-panel` `text-muted` 而不是 `style={{ background: "var(--bg-panel)" }}`。

```ts
theme: {
  extend: {
    colors: {
      bg: "var(--bg)",
      panel: "var(--bg-panel)",
      hover: "var(--bg-hover)",
      selected: "var(--bg-selected)",
      subtle: "var(--bg-subtle)",
      border: "var(--border)",
      text: "var(--text)",
      muted: "var(--text-muted)",
      dim: "var(--text-dim)",
      accent: "var(--accent)",
      "accent-hover": "var(--accent-hover)",
      "user-bg": "var(--user-bg)",
      "assistant-bg": "var(--assistant-bg)",
      "tool-bg": "var(--tool-bg)",
    },
  },
}
```

**风险**：Tailwind 内置 `bg-` `text-` 命名冲突。`bg-panel`、`text-muted` 这种**复合名**不会冲突，安全。

**验证**：build 不报 class 警告，组件改写时 IntelliSense 能补全。

**预计**：15 min

---

## P0 验收

跑 `npm run dev`，截图与 `/tmp/pi-compare/upstream-*.png` 对比：
- [ ] 默认浅色，整体接近上游灰白调
- [ ] 全站 mono 字体生效（标题、正文、按钮文字）
- [ ] 切换 dark 时，bg/text/accent 三组颜色都跟着切（不再有"只切了一半"）
- [ ] 旧组件 token alias 仍工作，没断电

---

# P1：控件级 UI 替换

每一项是独立 PR。`P1-x → P1-y` 之间无依赖，可并行。

## P1-1：引入 `@lobehub/icons`，替换 emoji

**改的文件**：
- `package.json` 加依赖
- `app/ChatApp.tsx`（toolbar 5 个 emoji，line 1139/1152/1172/1184/1196）
- `app/components/AuthPanel.tsx`（每个 provider 卡左侧 emoji 占位）
- `app/components/SkillsPanel.tsx`、`ModelsConfigPanel.tsx`（标题 emoji）

**改法**：
- toolbar 5 个按钮改成 lucide-style icon（`@lobehub/icons` 自带通用 icon），并加 `title` tooltip
- provider 卡左侧的圆点占位换成 `@lobehub/icons` 的 brand icon（OpenAI/Anthropic/Google/MiniMax 都有）

```tsx
import { OpenAI, Anthropic, Google, MiniMax } from "@lobehub/icons";
// ...
<OpenAI.Avatar size={20} />
```

**风险**：包体积。`@lobehub/icons` 是按需引入（ESM tree-shake），实测主包 +20~50KB 内。

**预计**：1.5h（含一遍 provider 列表对照）

---

## P1-2：toolbar 重构

**改的文件**：`app/ChatApp.tsx`（line ~1130-1200）

**现状**：顶栏右侧塞了一排 emoji（🗂🧠🔧🔑⚙），无 label，新用户看不懂。

**目标**：
- 5 个按钮改成 icon + 隐藏 label 的胶囊按钮
- 加 `title` 和 `aria-label`
- 间距收紧（参考 `docs/design-tokens.md` §4）

**预计**：30 min

---

## P1-3：会话条目压缩到 2 行

**改的文件**：`app/ChatApp.tsx`（line ~874-940）

**现状**：每条 4 行（时间 / 标题 / cwd / 行号），密度太高。

**目标**：参考上游，两行：
- line 1：标题（最多 1 行截断）
- line 2：`Xh ago · N msgs`（cwd 改成 hover tooltip）

**风险**：cwd 信息从可见变成 hover，长 cwd 用户找会话变难。

**对策**：会话条目上加 `title={cwd}`，鼠标停 1 秒可见。

**预计**：30 min

---

## P1-4：输入区下方控件改胶囊按钮

**改的文件**：`app/ChatApp.tsx` 输入区底部（auth/model/thinking/show all 四个 select）

**现状**：4 个 native `<select>` 灰下拉。

**目标**：参考上游 `auto` `default` `Compact` 三个胶囊按钮——点击弹层选择。

**改法**：
- 写一个轻量 `<PillSelect>` 组件（`button + popover + 选项列表`），不引入新依赖
- 保留 `<select>` 作为 a11y fallback（`<select>` 设 `sr-only`）

**风险**：自己写 popover 涉及 outside-click、ESC 关闭、键盘上下选择——容易踩坑。

**对策**：用 `useRef` + `useEffect` 监听 `mousedown` outside；先不做键盘导航，列入 P2。

**预计**：2h

---

## P1-5：模态去阴影 + 收圆角

**改的文件**：`app/ChatApp.tsx` modal、`AuthPanel.tsx` / `SkillsPanel.tsx` / `ModelsConfigPanel.tsx` / `ToolsPanel.tsx`

**改动**：
- `rounded-lg` → `rounded-md`（6px）
- `shadow-xl` → 移除，改用 1px border
- `p-6` → `p-4`

**预计**：30 min

---

## P1 验收

- [ ] 视觉密度接近上游（截图叠图差异 < 30%）
- [ ] 没有可见的 emoji 在 toolbar/标题上
- [ ] dark/light 切换无残留色

---

# P2：布局级改造

风险更高，建议每项单独验证。

## P2-1：首页 hero（仅在没选会话时显示）

**改的文件**：`app/ChatApp.tsx` 主区（`grid` 中间列）

**目标**：当 `selectedId === null` 时主区居中显示：
```
π diga-agent
self-hosted UI for pi-coding-agent

[ 输入框 居中 ]
```

**改法**：
- 主区增加 `selectedId` 分支：无选中 → render `<EmptyHero>`；有选中 → render 现有消息列表
- `<EmptyHero>` 用 flex center，把现有的输入框组件复用过来（复用而不是复制——参数化"位置：bottom | center"）

**风险**：输入框是个大组件（model 选择/cwd/upload 全在里面），抽离参数化容易把现有逻辑搞坏。

**对策**：先做最小版——只把 `textarea` + Send 按钮居中，下方 model 选择仍在底部。等结构稳定再考虑统一。

**预计**：1.5h

---

## P2-2：文件树常驻侧栏（替代浮层模态）

**改的文件**：`app/ChatApp.tsx` 主 grid、`app/components/FileBrowser.tsx`

**目标**：左侧栏从单列（会话列表）变两段——上半会话、下半 EXPLORER（带折叠按钮）。

**改法**：
- 左侧 `<aside>` 变成上下两段 flex 布局
- 加可拖拽的高度分割（先用固定 60/40 比例，分割条 P3 再做）
- 顶栏的 🗂 按钮从"打开模态"改成"展开/折叠 EXPLORER 段"

**风险**：
1. 上游就是 EXPLORER 默认全展开 `~` → 性能炸。需要默认只展开 cwd 一层，懒加载子目录。
2. 会话很多时上半部分滚动会和文件树滚动冲突。

**对策**：
- 默认只展开 cwd 当前目录
- 两段各自独立 `overflow-y: auto`
- FileBrowser 已经支持懒加载，复用即可

**预计**：3h

---

## P2-3：Token / Cost meter

**改的文件**：`app/ChatApp.tsx` 主区顶栏 / chat 头部

**目标**：上游右上角 `↑ 3k ↓ 26 <$0.01` 这种 meter。

**前置**：SDK 是否暴露 token 用量？
- 已知：`/api/agent/[id]/events` SSE 事件里上游显示了 cost，所以 SDK 一定暴露了 usage 字段
- 行动：先 grep `pi-coding-agent` 类型定义里有无 `usage` / `cost` 字段；没有的话此项 P3

**风险**：依赖 SDK 数据，需要先验证。

**预计**：先 30 min 验证可行性，可行再 1.5h 实现

---

## P2 验收

- [ ] 进入未选会话状态，看到 hero
- [ ] 文件树是侧栏（不再 toggle 模态）
- [ ] token meter 数字会随对话更新（如果 P2-3 走通）

---

# 排期建议

| 阶段 | 估时 | 串行/并行 | 必须完成才能进下一阶段 |
|---|---|---|---|
| P0 全部 | ~1.5h | 串行 | 是（地基） |
| P1-1 ~ P1-5 | 各 0.5~2h | 可并行 | 不严格 |
| P2-1 hero | 1.5h | 独立 | — |
| P2-2 explorer | 3h | 独立 | — |
| P2-3 meter | 30min 探查 + 1.5h | 独立 | — |

**最小可见成果路线**：P0 全做完 + P1-1（图标）+ P1-2（toolbar）+ P2-1（hero）。约 5h 工作量，做完截图就明显"是上游同款产品"的视觉了。

---

# 风险登记

| 编号 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 字体改动后中文显示丑 | P0-3 | fallback 链已设计好；提前在中文 demo 里验证 |
| R2 | token 改名导致组件断电 | P0-1 | alias 保留旧名 |
| R3 | hero 抽离输入框搞坏现有逻辑 | P2-1 | 先做最小版 |
| R4 | 文件树常驻 = 上游性能坑 | P2-2 | 默认只展开 cwd；懒加载 |
| R5 | `@lobehub/icons` 体积爆 | P1-1 | 按需 import；构建后看 bundle 报告 |
| R6 | 自己写的 popover 有 a11y 问题 | P1-4 | 至少加 `aria-expanded` 和 ESC 关闭；键盘导航延后 |

---

# 不做的事（明确登记）

- ❌ Branches / System 顶部 tab：未验证业务必要性
- ❌ Tailwind 3 → 4 升级：体力活，无新能力
- ❌ 全局 `~` 文件树展开：上游反例
- ❌ 上游 Models/Skills 独立 `/models` `/skills` 路由：上游 prod build 都跑不动，模态浮层方案更稳
- ❌ `prefers-color-scheme` 自动切：mini 用 `[data-theme]` 手动控制更可控
