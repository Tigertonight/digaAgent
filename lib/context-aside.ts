/**
 * Context aside markers.
 *
 * 「展示文本 / 发送文本解耦」的实现细节：
 *   - 发给模型的 user message = 用户原话 + 用下面这对标记包裹的「优化上下文」
 *     （浏览器观察结果、@附件引用、@agent 委托指令等）。
 *   - 前端渲染 user 气泡时，用 stripContextAside() 把这段标记及其内容剥离，
 *     只显示用户原话。
 *
 * 为什么不用 SDK 的 sendCustomMessage(role:"custom") 旁注机制？
 *   本项目使用的 local shim 是非标准 OpenAI 兼容端，不认识 role:"custom"
 *   消息，注入后模型会返回空响应（空气泡）。把上下文作为标准 user message
 *   文本的一部分发送，shim 完全认识，因此最稳妥。
 *
 * 标记选用不易与正常文本冲突的形式，且 stripContextAside 对未闭合 / 缺失标记
 * 做了防御，保证任何情况下都不会把内容错误地吞掉。
 */
export const CONTEXT_ASIDE_OPEN = "<<<CONTEXT_ASIDE>>>";
export const CONTEXT_ASIDE_CLOSE = "<<<END_CONTEXT_ASIDE>>>";

/**
 * 从一段 user message 文本中剥离「上下文 aside」，返回用户原始可见文本。
 *
 * 行为：
 *   - 删除所有 OPEN...CLOSE 之间的内容（含标记本身）。
 *   - 对未闭合的 OPEN（只有开标记没有闭标记）也做截断，避免把半截标记露给用户。
 *   - 清理因剥离产生的多余空白，trim 两端。
 *   - 无标记时原样返回（仅 trim）。
 */
export function stripContextAside(text: string): string {
  if (!text) return text;
  if (!text.includes(CONTEXT_ASIDE_OPEN)) return text;

  const openIdx = text.indexOf(CONTEXT_ASIDE_OPEN);
  const closeIdx = text.indexOf(CONTEXT_ASIDE_CLOSE, openIdx);

  let result: string;
  if (closeIdx >= 0) {
    // 正常闭合：删除 [open, close+marker) 区间。
    const before = text.slice(0, openIdx);
    const after = text.slice(closeIdx + CONTEXT_ASIDE_CLOSE.length);
    result = `${before}${after}`;
  } else {
    // 未闭合：从 open 标记处直接截断到结尾。
    result = text.slice(0, openIdx);
  }

  // 收尾：去掉因剥离残留的多余空行/空白。
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
