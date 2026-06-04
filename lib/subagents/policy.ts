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
}

export interface ResolvedSubagentPermission {
  allowedTools: string[];
  writePaths?: string[];
  appliedMode: SubagentPermissionMode | "role-default";
  notes: string[];
}

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
