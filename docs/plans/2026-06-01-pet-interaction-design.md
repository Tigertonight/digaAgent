# Diga 桌宠挂件 · 交互设计规范 v1

> 创建日期：2026-06-01
> 状态：设计基线（v1 保守路线，已与产品方对齐）
> 关联计划：`docs/plans/2026-06-01-pet-widget.md`
> 最新产品状态矩阵：`docs/plans/2026-06-03-pet-state-matrix.md`（后续触发规则以该文档为准）

---

## 0. 设计原则（决策基线）

| 维度 | v1 选择 | 含义 |
|------|--------|------|
| **角色定位** | 指示器（1A） | 宠物 = Agent 状态的"窗口" + 轻量入口（abort / 快回复 / 切 session / 跳主窗口）。**复杂决策一律回主窗口**。 |
| **追问/确认/推荐选项** | 不模拟不存在的能力（2A） | 当前 agent 不支持 permission_request / clarification / suggested_replies，宠物不假装支持。 |
| **细节展示** | 用现有事件做更细反馈（部分 2B） | 利用已有 `auto_retry` / `tool_execution` / `compaction` 事件，在气泡里显示更具体的文案。 |
| **状态颗粒度** | 5 态主状态机（3A） | sprite 用 5 个主状态，细节信息全部塞气泡。 |
| **异常打扰程度** | 分级（4 推荐） | 小问题轻提示，大问题主动喊。 |

**核心准则**：
1. **不撒谎**：sprite 状态必须真实反映 agent 状态，不做"假装在思考"的动画。
2. **不抢戏**：宠物默认安静，只在状态切换、错误、完成时短暂"活跃"。
3. **可逃逸**：任何时候用户都能：拖走、隐藏、跳回主窗口。
4. **能力对齐**：宠物上能做的事，主窗口必然也能做（且做得更好）。宠物只是"更快的入口"。

---

## 1. 状态机定义（5 态）

### 1.1 主状态枚举

| State | 触发条件 | sprite 视觉 | 持续时间 |
|-------|---------|-----------|---------|
| `idle` | 无 agent OR 有 agent 但从未对话 | 主 logo 静态，轻微呼吸（4s 周期 opacity 0.85↔1.0） | 持续 |
| `thinking` | `agentPhase.kind` ∈ {`waiting_model`, `thinking`} | 主 logo + 顶部小圆点脉动（1s 周期），蓝色光晕 | 持续到状态变 |
| `running` | `agentPhase.kind === "running_tools"` | 主 logo + 底部细线进度扫动（2s 周期），紫色光晕 | 持续到状态变 |
| `attention` | `streaming=false` 且 `lastMessage` 非空 且 未被用户查看 | 主 logo + 右上角小红点徽章 | 持续到用户 hover 或聚焦主窗口 |
| `done` | `streaming` 从 true 变 false 的瞬间 | 主 logo + 绿色光晕扩散一次 + 缩放 1.0→1.1→1.0 | 闪现 **2000ms** 后回 `attention` 或 `idle` |

### 1.2 状态转移图

```
            ┌─────────┐
            │  idle   │◄────────────────┐
            └────┬────┘                 │
                 │ user 发送消息        │ 用户聚焦主窗口
                 ▼                      │ 或 hover 宠物
            ┌─────────┐                 │
       ┌───►│thinking │                 │
       │    └────┬────┘                 │
       │         │ tool_execution_start │
       │         ▼                      │
       │    ┌─────────┐                 │
       │    │ running │                 │
       │    └────┬────┘                 │
       │         │ tool_execution_end   │
       └─────────┤ (回到 thinking)      │
                 │                      │
                 │ agent_end            │
                 ▼                      │
            ┌─────────┐ 2000ms          │
            │  done   │──────────►┌─────┴────┐
            └─────────┘           │attention │
                                  └──────────┘
```

### 1.3 与现有代码对齐

当前 `derivePetAnimState()` 实现已基本正确，**仅需补充 done 状态的视觉**（光晕 + 缩放动画）。状态机本身**无需修改**。

---

## 2. 视觉规范

### 2.1 配色

| 元素 | 颜色 | 用途 |
|------|------|------|
| 主品牌色 | `#6366F1` (indigo-500) | thinking 光晕、链接 |
| 进行中 | `#A855F7` (purple-500) | running 光晕、进度条 |
| 成功 | `#10B981` (emerald-500) | done 光晕 |
| 待办/未读 | `#EF4444` (red-500) | attention 红点徽章 |
| 错误 | `#DC2626` (red-600) | error sprite 滤镜 |
| 离线/失联 | `#9CA3AF` (gray-400) | SSE 断线灰度 |
| 气泡背景 | `rgba(17,24,39,0.92)` (slate-900/92) | 深色半透明，对透明窗口友好 |
| 气泡文字 | `#F9FAFB` (gray-50) | |

### 2.2 尺寸

| 元素 | 尺寸 |
|------|------|
| BrowserWindow | 320 × 400 |
| sprite 容器 | 96 × 96（锁右下角，距右、下各 8px）|
| 红点徽章 | 8 × 8（sprite 右上角，距各 4px）|
| 气泡 | max-width 240，padding 8×12，圆角 12，箭头 8 |
| 卡片 | width 280，padding 12，圆角 16 |
| 光晕 | radius = sprite 半径 × 1.5，blur 20px |

### 2.3 动画曲线

| 场景 | 时长 | easing |
|------|------|--------|
| sprite 呼吸 | 4000ms | ease-in-out infinite |
| thinking 圆点脉动 | 1000ms | ease-in-out infinite |
| running 进度扫动 | 2000ms | linear infinite |
| done 缩放 | 600ms | cubic-bezier(.34, 1.56, .64, 1)（弹性） |
| 气泡淡入/淡出 | 150ms | ease-out |
| 卡片展开 | 200ms | cubic-bezier(.4, 0, .2, 1) |

---

## 3. 鼠标交互矩阵

### 3.1 全量交互表

| 触发 | 区域 | 反馈 | 备注 |
|------|------|------|------|
| **mouseenter** | sprite | 100ms 后显示气泡 + sprite scale(1.05) | 100ms 防抖避免一闪而过 |
| **mouseleave** | sprite | 200ms 后隐藏气泡 | 给 hover 进气泡的时间 |
| **mouseenter** | 气泡 | 取消隐藏计时 | 让用户能看完文案 |
| **mouseleave** | 气泡 | 立即隐藏 | |
| **click**（单击） | sprite | 关闭气泡 + 打开卡片 | 卡片打开期间气泡禁用 |
| **click** | sprite（卡片已开） | 关闭卡片 | toggle |
| **click** | 卡片外区域 | 关闭卡片 | 但不关宠物窗口 |
| **dblclick** | sprite | 直接跳回主窗口（聚焦当前 session） | 老用户快捷操作 |
| **right-click** | sprite | 显示原生 ContextMenu | 见 §3.3 |
| **mousedown** + 移动 ≥ 5px | sprite 或卡片头部 | 进入拖拽模式 | < 5px 算单击 |
| **拖拽中** | 任意 | sprite scale(0.95) + opacity 0.8 | 给"被抓起"感 |
| **dragend** | 屏幕边缘 ≤ 20px | 吸附到最近边缘 | 见 §3.4 |
| **ESC**（卡片打开时） | 全局 | 关闭卡片 | 标准快捷键 |
| **窗口外鼠标** | sprite 外的透明区域 | **鼠标穿透**（点击穿过到下层）| `setIgnoreMouse(true)` |

### 3.2 鼠标穿透逻辑（关键工程细节）

由于宠物窗口 320×400 但 sprite 只占 96×96，**必须动态切换鼠标穿透**：

```
鼠标进入 sprite/气泡/卡片元素 → setIgnoreMouse(false)
鼠标移出所有可交互元素     → setIgnoreMouse(true)
```

实现：`PetApp.tsx` 已有该逻辑（`pet:set-ignore-mouse` IPC），保持现状。

### 3.3 右键菜单（v1 内容）

```
┌─────────────────────────┐
│  跳回主窗口              │ → focusMain()
│  切换到其他会话      ►   │ → 子菜单显示所有 session
│  ─────────────────────  │
│  暂停 Agent（如运行中）  │ → abort()（仅 streaming 时可点）
│  ─────────────────────  │
│  始终置顶  ✓             │ → toggle alwaysOnTop
│  隐藏宠物                │ → setPetVisible(false)
│  ─────────────────────  │
│  关于 Diga              │ → 跳主窗口设置页
└─────────────────────────┘
```

> v1 用 Electron 原生 `Menu`，不自绘。

### 3.4 边缘吸附

释放位置距屏幕边缘 ≤ 20px → 动画吸附到边缘（保留 sprite 完全可见）。
四角不做特殊处理（v2 再考虑变形为半圆"窝"在角落）。

---

## 4. 气泡文案规范

气泡 = "状态的人话翻译"。规则：

1. **最长 24 字**（中文），超出截断 + 省略号
2. **不带 emoji**（保持商务感）
3. **动词开头**（"正在…"、"等待…"、"已完成…"）
4. **数字优先**（"重试 2/3" 比 "正在重试" 好）

### 4.1 状态文案表

| State | agent 子状态/事件 | 气泡文案 | 副文案（小字） |
|-------|-----------------|---------|--------------|
| idle | 无 agent | "等待启动" | session 名称 |
| idle | 有 agent 无对话 | "准备就绪" | session 名称 |
| thinking | `waiting_model` | "等待模型响应…" | model 名称 |
| thinking | `thinking` | "正在思考…" | 已耗时 Xs |
| running | `tool: read` | "正在读取文件" | 文件名（截断） |
| running | `tool: edit/write` | "正在修改文件" | 文件名 |
| running | `tool: bash` | "正在执行命令" | 命令前 20 字 |
| running | `tool: grep/find/ls` | "正在搜索" | 关键词 |
| running | `tool: 其他` | "正在使用 {toolName}" | — |
| running | 多个 tool 并发 | "正在执行 N 个任务" | 第一个 tool 名 |
| attention | 流结束有 lastMessage | "有新回复" | lastMessage 前 40 字 |
| done | 刚完成 | "已完成" | 共耗时 Xs |
| **特殊事件** | `auto_retry_start` | "重试中 (X/Y)" | retry 原因 |
| **特殊事件** | `compaction_start` | "正在压缩上下文…" | — |
| **特殊事件** | `agent_error` | "出错了" | 错误前 40 字 |
| **特殊事件** | SSE lost | "连接已断开" | "点击重连" |
| **特殊事件** | tool error（非致命） | "{toolName} 失败" | 错误前 30 字（3s 后消失） |

### 4.2 气泡触发优先级

同时存在多个待显示信息时，按优先级：

```
1. 主动错误（agent_error / SSE lost）         → 强制显示，需用户关闭
2. 临时事件气泡（tool error / retry / compaction） → 自动 3s 消失
3. hover 气泡（状态文案）                       → 跟随 hover
```

---

## 5. 卡片（PetCard）规范

### 5.1 v1 卡片内容

```
┌─────────────────────────────────┐
│ ● {Session 名称}           [×] │   ← header（彩色圆点 = 当前状态色）
├─────────────────────────────────┤
│ {状态行：thinking / running…}    │   ← 与气泡文案一致
│ {副文案：耗时 / 文件名 / 错误}    │
├─────────────────────────────────┤
│ 最后一条回复（最多 3 行）        │
│ "lorem ipsum dolor sit amet..." │
├─────────────────────────────────┤
│ [快速回复]  ───────────────────│   ← input + 发送按钮
│ [____________________] [发送]   │
├─────────────────────────────────┤
│ [⏸ 暂停]  [↗ 跳回主窗口]        │   ← 主操作按钮
├─────────────────────────────────┤
│ 其他会话 (N)              [展开] │   ← 折叠区
│ ○ session A    正在思考          │
│ ○ session B    已完成            │
└─────────────────────────────────┘
```

### 5.2 按钮态

| 按钮 | 可用条件 | 不可用时 |
|------|---------|---------|
| ⏸ 暂停 | `streaming === true` | 灰色置灰，tooltip "无运行中任务" |
| 发送 | input 非空 + 非 streaming | 灰色置灰 |
| 跳回主窗口 | 始终可用 | — |

### 5.3 快速回复约束（v1）

- 仅支持纯文本，**不支持** @文件 / 图片 / 工具调用
- 发送后立即关闭卡片
- 长度限制 500 字（超出在主窗口编辑）

---

## 6. 异常反馈规范

### 6.1 异常分级

| 等级 | 类型 | sprite | 气泡 | 卡片 | 是否打断用户 |
|------|------|--------|------|------|------------|
| **L1 静默** | tool error（非致命）| 不变 | 临时气泡 3s | 不弹 | 否 |
| **L2 提示** | auto_retry | 不变 | 临时气泡持续 retry 全程 | 不弹 | 否 |
| **L2 提示** | compaction | 不变 | 临时气泡持续压缩全程 | 不弹 | 否 |
| **L3 警示** | SSE 断线 | 灰度 + 角标 | 不主动弹 | 不弹 | 否 |
| **L4 警报** | agent_error | 红色滤镜 | 强制弹气泡 3s | 自动弹卡片显示详情 | 是 |
| **L4 警报** | 完全离线 | 灰度 + 红色叉 | 强制弹"已离线" | 可点卡片重连 | 是 |

### 6.2 SSE 断线视觉

```
sprite 状态：
  - 整体 filter: grayscale(0.7)
  - 右下角额外加 16×16 红色叉图标（叠加在 sprite 上）
  - 呼吸动画暂停
  
点击 sprite：
  - 不开卡片，直接尝试 SSE 重连
  - 重连中 sprite 显示 spinner 覆盖层
  - 重连成功 → 回到正常状态
  - 重连失败 → 弹 toast "重连失败，请检查网络"
```

### 6.3 错误恢复路径

| 错误类型 | 用户可做的事 |
|---------|------------|
| tool error（自动继续） | 无需操作，可点卡片看详情 |
| auto_retry 中 | 可点卡片"取消重试"（= abort） |
| agent_error | 卡片显示错误堆栈，按钮"复制错误" + "跳回主窗口" |
| SSE 断线 | 点 sprite 重连 / 跳回主窗口 |
| 完全离线 | 跳回主窗口检查后端 |

---

## 7. 多会话行为

### 7.1 显示哪个 session 的状态？

**优先级**：
1. `localFocusId`（宠物本地切换的 session，不推回主窗口）
2. `petState.focusedSessionId`（主窗口当前选中的 session）
3. `sessions[0]`（兜底）

### 7.2 切换 session 的两种入口

| 入口 | 行为 |
|------|------|
| 卡片底部"其他会话"列表点击 | **本地切换**：仅宠物显示该 session 状态，主窗口不变 |
| 右键菜单"切换到其他会话" | **同步切换**：宠物 + 主窗口都切（调 `focusMain(sid)`）|

### 7.3 多 session 状态指示

卡片"其他会话"列表，每行显示：

```
○ {session 名称}    {简短状态}
```

简短状态：
- 流式中：彩色圆点 + "正在 {状态}"
- 有未读：红点 + "有新回复"
- 静默：灰点 + "—"

---

## 8. 性能与边界

### 8.1 IPC 推送节流

`pet:state` 推送频率上限 **10 Hz**（100ms 节流）。
streaming 期间 `lastMessage` 变化很频繁，必须节流避免 IPC 堆积。

> 实施位置：`app/ChatApp.tsx` 推送 PetState 的 useEffect 加 throttle。

### 8.2 大文本截断

- `lastMessage` 推送给宠物窗口前截断到 **200 字符**
- 文件路径显示截断到 **30 字符**，中间用 "…" 代替

### 8.3 离线/不在 Electron 中

`/pet` 路由在浏览器中打开时（dev 场景）：
- `window.digaAgent` 为 undefined
- 显示 mock 状态："（非 Electron 环境，仅展示样式）"
- 所有 IPC 调用 noop

---

## 9. 未实施项（v2 候选）

按优先级降序，**不在 v1 范围**：

1. **帧动画恢复**：等用户提供"帧动作 → state 映射表"后实施
2. **agent 能力扩展**（追问 / 确认 / 推荐选项）：单独立项，需先改 agent SSE 事件
3. **吸附变形**：吸附到角落时变成"窝在角落"的半圆形
4. **声音反馈**：done / error 的提示音（需用户开关）
5. **拖拽阴影**：drag 时跟一个半透明 ghost
6. **历史回顾**：卡片显示最近 N 条消息（不只是最后一条）
7. **多 sprite 皮肤**：用户可换不同 Diga 形象
8. **键盘全局快捷键**：Cmd+Shift+D 召唤/隐藏宠物
9. **气泡富文本**：tool 调用显示文件 icon、命令高亮等
10. **状态历史**：hover sprite 时显示最近 30 秒的状态变化时间线

---

## 10. v1 实施差距清单

对照当前代码（commit `1f24d17`）和本设计，**需要补的工作**：

| 编号 | 项 | 优先级 | 文件 |
|------|---|------|------|
| D1 | sprite 呼吸 / thinking 脉动 / running 进度扫动 / done 弹性缩放 4 套动画 | P0 | `PetSprite.tsx` + `globals.css` |
| D2 | sprite 颜色光晕（thinking 蓝 / running 紫 / done 绿 / error 红） | P0 | `PetSprite.tsx` |
| D3 | attention 红点徽章 | P0 | `PetSprite.tsx` |
| D4 | 气泡文案按 §4.1 表格细化（当前仅显示状态名） | P0 | `PetBubble.tsx` + `usePetState` 增加 `bubbleText` 派生 |
| D5 | 临时事件气泡（auto_retry / compaction / tool error）| P1 | `usePetState` 订阅事件 + 队列 |
| D6 | PetState 新增字段：`retry` / `compacting` / `error` / `sseStatus` | P0 | `lib/electron-bridge.ts` + ChatApp 推送逻辑 |
| D7 | IPC 推送 100ms 节流 | P0 | `app/ChatApp.tsx` |
| D8 | `lastMessage` 200 字符截断 | P0 | `app/ChatApp.tsx` |
| D9 | 右键菜单（原生 Menu） | P1 | `electron/main.js` + 新增 `pet:context-menu` IPC |
| D10 | 双击跳回主窗口 | P1 | `PetApp.tsx` |
| D11 | 边缘吸附（释放时检测距离） | P2 | `use-pet-drag.ts` |
| D12 | ESC 关卡片 | P1 | `PetCard.tsx` |
| D13 | 卡片增加"暂停 / 跳回 / 其他会话"完整布局 | P0 | `PetCard.tsx` |
| D14 | SSE 断线视觉（灰度 + 红叉 + 点击重连） | P1 | `PetSprite.tsx` + `usePetState` |
| D15 | 非 Electron 环境的 mock 提示 | P2 | `app/pet/page.tsx` |

**P0 = v1 必做（功能完整性）**
**P1 = v1 应做（体验完整性）**
**P2 = v1 可做（锦上添花）**

---

## 11. 验收标准

v1 实施完成的判据：

- [ ] sprite 5 个状态都有独特的视觉反馈（光晕 + 动画）
- [ ] 气泡文案随 agent 子状态实时更新（thinking → running tool 文件名等）
- [ ] auto_retry / compaction / tool_error 这 3 类事件能正确显示临时气泡
- [ ] SSE 断线时 sprite 灰度，点击能触发重连
- [ ] agent_error 时强制弹气泡 + 卡片自动弹出
- [ ] 卡片内 abort / 快速回复 / 跳主窗口 / 切 session 4 个动作全部可用
- [ ] 右键菜单包含 §3.3 所有选项
- [ ] 双击 sprite 直接跳主窗口
- [ ] ESC 能关卡片
- [ ] IPC 推送在 streaming 期间 ≤ 10Hz
- [ ] `/pet` 路由在浏览器中能打开且不报错

---

> **下一步**：将本文档转为 12-15 个可独立 commit 的 Task，分批实施 D1-D15。
