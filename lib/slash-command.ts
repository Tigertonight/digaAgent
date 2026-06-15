/**
 * Slash command 解析。
 *
 * 之前 ChatApp 用 `trimmed.startsWith("/goal")` 直接判定，会把 `/goalxxx` 误判为
 * /goal 命令。这里抽一个严格匹配 helper 给 useSendComposer / runGoalCommand /
 * runWorkflowCommand 共用，规则：
 *
 *   `/<name>(<空白>+...args | <空白>* | EOL)`
 *
 * 即命令名后必须是空白或字符串末尾，避免 `/goalxx` / `/workflowabc` 的歧义。
 */

export interface ParsedSlashCommand {
  /** 命令名（不含前导 /），命中时为 lowercase */
  name: string;
  /** 命令名之后的剩余文本，已 trim */
  rest: string;
}

/**
 * 解析 raw input 是否符合 `/<name>(空白|EOL)...` 形式。命中返回 { name, rest }；
 * 否则返回 null。raw 不要求事先 trim，本函数会 trim 一次。
 */
export function parseSlashCommand(
  raw: string,
  acceptedNames: readonly string[]
): ParsedSlashCommand | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  for (const name of acceptedNames) {
    if (!name) continue;
    // 严格匹配：/^\/<name>(?:\s|$)/
    const re = new RegExp(`^/${escapeRegex(name)}(?:\\s|$)`, "i");
    if (re.test(trimmed)) {
      const rest = trimmed.slice(1 + name.length).trim();
      return { name: name.toLowerCase(), rest };
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
