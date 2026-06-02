/**
 * 规则匹配纯函数。无副作用、无 I/O，方便单测全覆盖。
 *
 * 设计原则：
 * - 同一 matcher 内所有字段 AND；任一字段不满足整条规则不命中。
 * - 空 matcher `{}` 视为"全 match"——给"对所有工具一律 ask"这种总线规则留口子。
 * - inputMatch 取值不存在或类型非 string 一律视为不命中（不做 toString 强转，避免误触发）。
 */
import type { ApprovalRule, ToolCallMatcher } from "./types";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * 在规则列表里找第一条命中 event 的规则。
 * 顺序敏感：调用方应把"更具体 / 高优先级"的规则放前面。
 */
export function matchRule(
  event: ToolCallEvent,
  rules: ApprovalRule[]
): ApprovalRule | undefined {
  for (const rule of rules) {
    if (matchesMatcher(event, rule.match)) return rule;
  }
  return undefined;
}

function matchesMatcher(event: ToolCallEvent, m: ToolCallMatcher): boolean {
  // toolName 检查
  if (m.toolName != null) {
    const names = Array.isArray(m.toolName) ? m.toolName : [m.toolName];
    if (!names.includes(event.toolName)) return false;
  }
  // inputMatch 检查
  if (m.inputMatch) {
    // 把 input 当成普通对象访问；SDK 的 ToolCallEvent.input 是 discriminated union，
    // 不同 tool 各自有强类型，但 matcher 是规则驱动的 string 比较，统一按 Record 处理。
    const input = event.input as Record<string, unknown>;
    for (const [key, cond] of Object.entries(m.inputMatch)) {
      const val = input[key];
      if (typeof val !== "string") return false;
      if (cond.contains && cond.contains.length > 0) {
        if (!cond.contains.some((kw) => val.includes(kw))) return false;
      }
      if (cond.regex) {
        if (!new RegExp(cond.regex).test(val)) return false;
      }
    }
  }
  return true;
}
