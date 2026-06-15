import type { SubagentDefinition, SubagentPermissionMode } from "./definition";

export interface ResolvedSubagentModel {
  provider: string;
  modelId: string;
  /** Whether the definition's model policy overrode the parent model. */
  overridden: boolean;
  note?: string;
}

/**
 * Resolve which model a subagent should run on.
 *
 * Per-agent model policy (Sprint 2): a specialist can pin a stronger model
 * (e.g. a reviewer) or a cheaper one (e.g. bulk RAG). To stay safe we only
 * override when the definition provides BOTH provider and id; a partial spec
 * (e.g. id only) falls back to the parent model rather than risk an unresolved
 * model that would fail the whole task.
 */
export function resolveSubagentModel(
  definition: SubagentDefinition | null,
  parent: { provider: string; modelId: string }
): ResolvedSubagentModel {
  const model = definition?.model;
  if (model?.provider && model.id) {
    return {
      provider: model.provider,
      modelId: model.id,
      overridden: true,
      note: `Using specialist model ${model.provider}/${model.id}.`,
    };
  }
  if (model?.id && !model.provider) {
    return {
      provider: parent.provider,
      modelId: parent.modelId,
      overridden: false,
      note: `Specialist model id "${model.id}" lacks a provider; kept parent model.`,
    };
  }
  return {
    provider: parent.provider,
    modelId: parent.modelId,
    overridden: false,
  };
}

/**
 * Shared write-capable tool matcher. Mirrors orchestrator's WRITE_TOOL_PATTERN
 * so readOnly stripping is consistent across the codebase.
 */
export const WRITE_TOOL_PATTERN =
  /write|edit|patch|apply|delete|move|rename|mkdir|touch/i;

export function isWriteCapableTool(tool: string): boolean {
  return WRITE_TOOL_PATTERN.test(tool);
}

export interface SubagentPermissionInput {
  /** Tools the runtime task explicitly requested (already sanitized upstream). */
  requestedTools?: string[];
  /** Write paths the runtime task declared. */
  writePaths?: string[];
  /**
   * S2: 该 task 在隔离 worktree 里跑。此时“写入边界”就是 worktree 路径，
   * 应该能拿到写工具 + 常见实现型工具（bash 等）。这里只控制底层哲学：
   *   - definition.defaultTools 仍是上限。
   *   - definition.permissionMode === "worktree" 或 input.isolatedWorktree===true
   *     时，不会被误剖成 read-only。
   */
  isolatedWorktree?: boolean;
}

export interface ResolvedSubagentPermission {
  allowedTools: string[];
  writePaths?: string[];
  appliedMode: SubagentPermissionMode | "role-default";
  notes: string[];
}

/**
 * S2: worktree 隔离下的 “实现型” 默认工具。包括 read 及常见写工具。
 * 这些名字与主 agent 可用工具保持一致（write / edit / apply_patch 等是 SDK 默认 builtin）。
 * 仅在调用方没有明确传 requested tools 且 definition 也没 pin defaultTools 时使用。
 */
export const WORKTREE_DEFAULT_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "apply_patch",
];

/**
 * Resolve the final permission for a subagent task.
 *
 * Core rules (修正 4):
 *  - definition is the hard ceiling; runtime cannot escalate beyond it.
 *  - final tools = (requested OR definition.defaultTools OR roleDefaultTools),
 *    then intersected with definition.defaultTools when the definition pins a
 *    tool allowlist.
 *  - denyAll   -> no tools.
 *  - readOnly  -> strip all write-capable tools.
 *  - boundedWrite -> keep write tools only if writePaths is non-empty.
 *  - no definition -> return role defaults unchanged (backward compatible, 修正 5).
 */
export function resolveSubagentPermission(
  definition: SubagentDefinition | null,
  input: SubagentPermissionInput,
  roleDefaultTools: string[]
): ResolvedSubagentPermission {
  const notes: string[] = [];

  // No definition -> legacy behavior: requested tools or role defaults.
  if (!definition) {
    const tools = dedupe(
      input.requestedTools && input.requestedTools.length > 0
        ? input.requestedTools
        : roleDefaultTools
    );
    return {
      allowedTools: tools,
      writePaths: nonEmpty(input.writePaths),
      appliedMode: "role-default",
      notes,
    };
  }

  const mode = definition.permissionMode;

  // Base set: requested -> definition.defaultTools -> roleDefaultTools.
  let tools = dedupe(
    input.requestedTools && input.requestedTools.length > 0
      ? input.requestedTools
      : definition.defaultTools && definition.defaultTools.length > 0
        ? definition.defaultTools
        : roleDefaultTools
  );

  // Ceiling: if the definition pins defaultTools, runtime cannot exceed it.
  if (definition.defaultTools && definition.defaultTools.length > 0) {
    const ceiling = new Set(definition.defaultTools);
    const before = tools.length;
    tools = tools.filter((t) => ceiling.has(t));
    if (tools.length < before) {
      notes.push(
        "Requested tools were intersected with the definition's defaultTools (no escalation)."
      );
    }
  }

  if (mode === "denyAll") {
    return { allowedTools: [], appliedMode: "denyAll", notes };
  }

  if (mode === "readOnly") {
    const before = tools.length;
    tools = tools.filter((t) => !isWriteCapableTool(t));
    if (tools.length < before) {
      notes.push("readOnly mode stripped write-capable tools.");
    }
    return { allowedTools: tools, appliedMode: "readOnly", notes };
  }

  // S2：worktree 模式的完整处理。以 worktree 路径作为写入边界；不要被作 read-only。
  if (mode === "worktree") {
    // 如果调用方没传 requested tools 也没 pin defaultTools，拉上 worktree 默认实现型工具。
    if (
      (!input.requestedTools || input.requestedTools.length === 0) &&
      (!definition.defaultTools || definition.defaultTools.length === 0)
    ) {
      tools = dedupe(WORKTREE_DEFAULT_TOOLS as string[]);
      notes.push(
        "worktree mode: applied default implementation toolset (read+write)."
      );
    }
    return {
      allowedTools: tools,
      // worktree 路径由 orchestrator 在 createChild 时以 child cwd 代替，这里仅传出用户
      // 明确声明的 writePaths（若有）供审计。
      writePaths: nonEmpty(input.writePaths),
      appliedMode: "worktree",
      notes,
    };
  }

  if (mode === "boundedWrite") {
    const writePaths = nonEmpty(input.writePaths);
    if (!writePaths) {
      const before = tools.length;
      tools = tools.filter((t) => !isWriteCapableTool(t));
      if (tools.length < before) {
        notes.push(
          "boundedWrite without writePaths: write tools were removed."
        );
      }
      return { allowedTools: tools, appliedMode: "boundedWrite", notes };
    }
    return {
      allowedTools: tools,
      writePaths,
      appliedMode: "boundedWrite",
      notes,
    };
  }

  // Definition without an explicit mode: keep tools, honor declared writePaths.
  // S2：如果调用方明确表示这份 run 在 isolated worktree 里，不要反转成 read-only。
  if (input.isolatedWorktree) {
    return {
      allowedTools: tools,
      writePaths: nonEmpty(input.writePaths),
      appliedMode: "role-default",
      notes: [
        ...notes,
        "isolated worktree: write-capable tools allowed within the worktree.",
      ],
    };
  }
  return {
    allowedTools: tools,
    writePaths: nonEmpty(input.writePaths),
    appliedMode: "role-default",
    notes,
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function nonEmpty(arr: string[] | undefined): string[] | undefined {
  const cleaned = arr?.map((s) => s.trim()).filter(Boolean);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}
