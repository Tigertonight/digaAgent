/**
 * BrowserId 规范 —— 把浏览器实例从「过度绑定 agentId」中解耦出来。
 *
 * 设计原则（来自四层架构）：
 *   Browser Runtime 是独立的 browser workspace，agent 只是其中一个操作者。
 *   因此浏览器实例不应只由 agentId 标识，而应由一个通用的 browserId 标识：
 *
 *   - agent:<agentId>       —— agent 自动浏览器（执行 browser task / tools）
 *   - standalone:<threadId> —— 用户在 BrowserPanel 里手动打开的预览浏览器
 *   - task:<taskId>         —— 未来专门的任务浏览器
 *
 * 向后兼容：历史代码直接用裸 agentId 作为 key。本模块对「不带已知前缀」的
 * 字符串一律视为 agent 域的裸 agentId（owner.kind="agent"），保证旧调用零破坏。
 *
 * runtime 层只把 browserId 当作 Map key，不关心它的语义；
 * 只有 API 层需要据此判断「是否要给某个 agent 推 SSE」。
 */

export type BrowserOwnerKind = "agent" | "standalone" | "task";

export interface BrowserOwner {
  kind: BrowserOwnerKind;
  /** kind=agent 时是 agentId；standalone 时是 threadId；task 时是 taskId */
  id: string;
}

const PREFIX_SEP = ":";

/** 构造 agent 域 browserId */
export function agentBrowserId(agentId: string): string {
  return `agent${PREFIX_SEP}${agentId}`;
}

/** 构造 standalone（用户手动预览）域 browserId */
export function standaloneBrowserId(threadId: string): string {
  return `standalone${PREFIX_SEP}${threadId}`;
}

/** 构造 task 域 browserId */
export function taskBrowserId(taskId: string): string {
  return `task${PREFIX_SEP}${taskId}`;
}

/**
 * 解析 browserId 的 owner。
 *
 * - "agent:abc"      -> { kind:"agent", id:"abc" }
 * - "standalone:t1"  -> { kind:"standalone", id:"t1" }
 * - "task:x"         -> { kind:"task", id:"x" }
 * - "abc"（无前缀）  -> { kind:"agent", id:"abc" }  // 向后兼容裸 agentId
 */
export function parseBrowserId(browserId: string): BrowserOwner {
  const sepIdx = browserId.indexOf(PREFIX_SEP);
  if (sepIdx > 0) {
    const prefix = browserId.slice(0, sepIdx);
    const rest = browserId.slice(sepIdx + 1);
    if (prefix === "agent") return { kind: "agent", id: rest };
    if (prefix === "standalone") return { kind: "standalone", id: rest };
    if (prefix === "task") return { kind: "task", id: rest };
  }
  // 无已知前缀：向后兼容，按裸 agentId 处理
  return { kind: "agent", id: browserId };
}

/**
 * 若 browserId 属于某个 agent，返回其 agentId（用于决定是否推 SSE）；
 * 否则返回 null（standalone / task 不推 SSE，只回 snapshot）。
 */
export function agentIdFromBrowserId(browserId: string): string | null {
  const owner = parseBrowserId(browserId);
  return owner.kind === "agent" ? owner.id : null;
}
