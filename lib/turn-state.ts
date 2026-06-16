import type { ChatMessage } from "./types";

/**
 * 判断 index 处的 assistant 消息是否是「本轮最后一条 assistant」。
 * 一轮 = 上一条 user → 下一条 user 之间的所有 assistant。
 * 中间允许穿插 tool/system 等非 user/assistant 类。
 */
export function isLastAssistantOfTurn(
  messages: ChatMessage[],
  index: number
): boolean {
  if (messages[index]?.role !== "assistant") return false;
  for (let j = index + 1; j < messages.length; j += 1) {
    const role = messages[j]?.role;
    if (role === "user") return true;
    if (role === "assistant") return false;
  }
  return true;
}

export type TurnChromeState = "final" | "compact" | "live";

/**
 * 推导 assistant 消息的 chrome 状态：
 *   - live    → 当前活跃 assistant（正在写）
 *   - final   → 整轮已结束 + 该轮最后一条 assistant
 *   - compact → 已封盘但不显示 full chrome（中间 turn / 整轮未结束）
 */
export function deriveTurnChromeState(args: {
  messages: ChatMessage[];
  index: number;
  streaming: boolean;
  isActiveAssistant: boolean;
}): TurnChromeState {
  const { messages, index, streaming, isActiveAssistant } = args;
  if (messages[index]?.role !== "assistant") return "final";
  if (isActiveAssistant && streaming) return "live";
  if (!isLastAssistantOfTurn(messages, index)) return "compact";
  if (streaming) return "compact";
  return "final";
}
