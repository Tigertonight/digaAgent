export type ToolTruncationCode =
  | "tool_args_truncated"
  | "large_field_missing"
  | "oversized_tool_payload"
  | "script_args_truncated";

export type ToolTruncationStrategy =
  | "skeleton_then_sections"
  | "draft_ref"
  | "split_subagent_batch"
  | "small_patch";

export interface ToolTruncationDiagnosis {
  code: ToolTruncationCode;
  toolName: string;
  field?: string;
  reason: string;
  recommendedStrategy: ToolTruncationStrategy;
  userMessage: string;
}

export interface DiagnoseToolTruncationInput {
  toolName?: string;
  isError?: boolean;
  input?: unknown;
  result?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

const LARGE_FIELD_BY_TOOL: Record<string, string[]> = {
  write: ["content", "text"],
  write_file: ["content", "text"],
  create_file: ["content", "text"],
  edit: ["new_string", "newString", "edits", "content"],
  edit_file: ["new_string", "newString", "edits", "content"],
  str_replace: ["new_str", "newString", "new_string"],
  run_workflow_script: ["script"],
  delegate_subagents: ["tasks"],
};

const BUDGETS: Record<string, number> = {
  "write.content": 12_000,
  "write.text": 12_000,
  "write_file.content": 12_000,
  "create_file.content": 12_000,
  "edit.new_string": 12_000,
  "edit.newString": 12_000,
  "edit_file.new_string": 12_000,
  "str_replace.new_str": 12_000,
  "run_workflow_script.script": 18_000,
  "delegate_subagents.tasks": 20_000,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getArg(input: unknown, key: string): unknown {
  return asRecord(input)?.[key];
}

function normalizeToolName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  const unwrapped =
    value && typeof value === "object" && !Array.isArray(value)
      ? ((value as { content?: unknown; text?: unknown }).content ??
        (value as { text?: unknown }).text)
      : value;
  if (typeof unwrapped === "string") return unwrapped;
  if (!Array.isArray(unwrapped)) return "";
  const out: string[] = [];
  for (const item of unwrapped) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    if (
      (record.type === "text" || record.type === undefined) &&
      typeof record.text === "string"
    ) {
      out.push(record.text);
    }
  }
  return out.join("\n");
}

function contentText(content: DiagnoseToolTruncationInput["content"]): string {
  return (content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function requiredFieldFromText(text: string, candidates: string[]): string | undefined {
  for (const field of candidates) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) return field;
  }
  const match =
    text.match(/-\s*([A-Za-z0-9_.-]+)\s*:/) ??
    text.match(/\b([A-Za-z0-9_.-]+)\b.*(?:required|required propert)/i);
  return match?.[1];
}

function hasOwnString(input: unknown, key: string): boolean {
  const record = asRecord(input);
  return (
    !!record &&
    Object.prototype.hasOwnProperty.call(record, key) &&
    typeof record[key] === "string" &&
    String(record[key]).length > 0
  );
}

function recommendedStrategy(toolName: string, field?: string): ToolTruncationStrategy {
  if (toolName === "run_workflow_script" || field === "script") return "draft_ref";
  if (toolName === "delegate_subagents" || field === "tasks") {
    return "split_subagent_batch";
  }
  if (/edit|str_replace|patch/.test(toolName)) return "small_patch";
  return "skeleton_then_sections";
}

function userMessageFor(strategy: ToolTruncationStrategy): string {
  switch (strategy) {
    case "draft_ref":
      return "工具参数疑似被截断。请先把长脚本保存为 draft，再用 draftRef 执行，不要原样重试同一个大参数。";
    case "split_subagent_batch":
      return "工具参数疑似被截断。请减少单次 subagent 任务数，缩短每个 prompt，或把共享上下文保存成文件/引用后让子任务读取。";
    case "small_patch":
      return "工具参数疑似被截断。请改用小范围 patch/edit，多次提交局部变更，不要一次传入超长替换内容。";
    case "skeleton_then_sections":
      return "工具参数疑似被截断。请先写短骨架，再分章节追加或编辑，最后 read/wc 校验文件非空。";
  }
}

function diagnosis(args: {
  code: ToolTruncationCode;
  toolName: string;
  field?: string;
  reason: string;
}): ToolTruncationDiagnosis {
  const strategy = recommendedStrategy(args.toolName, args.field);
  return {
    ...args,
    recommendedStrategy: strategy,
    userMessage: userMessageFor(strategy),
  };
}

export function diagnoseOversizedToolPayload(input: {
  toolName?: string;
  args?: unknown;
}): ToolTruncationDiagnosis | null {
  const toolName = normalizeToolName(input.toolName);
  if (!toolName) return null;
  const fields = LARGE_FIELD_BY_TOOL[toolName] ?? [];
  for (const field of fields) {
    const value = getArg(input.args, field);
    const size = field === "tasks" ? stringify(value).length : stringify(value).length;
    const budget = BUDGETS[`${toolName}.${field}`];
    if (budget && size > budget) {
      return diagnosis({
        code: "oversized_tool_payload",
        toolName,
        field,
        reason: `${toolName}.${field} is ${size} chars, above ${budget} char soft budget.`,
      });
    }
  }
  return null;
}

export function diagnoseToolTruncation(
  input: DiagnoseToolTruncationInput,
): ToolTruncationDiagnosis | null {
  const toolName = normalizeToolName(input.toolName);
  if (!toolName || !input.isError) return null;

  const oversized = diagnoseOversizedToolPayload({
    toolName,
    args: input.input,
  });
  if (oversized) return oversized;

  const text = [toolResultText(input.result), contentText(input.content)]
    .filter(Boolean)
    .join("\n");
  const candidates = LARGE_FIELD_BY_TOOL[toolName] ?? [
    "content",
    "text",
    "script",
    "tasks",
    "new_string",
    "newString",
    "new_str",
    "edits",
  ];
  const missingField = requiredFieldFromText(text, candidates);
  const requiredFailure =
    /validation failed/i.test(text) &&
    /required propert|must have required|is required|required field/i.test(text);

  if (requiredFailure && missingField && candidates.includes(missingField)) {
    return diagnosis({
      code:
        toolName === "run_workflow_script" || missingField === "script"
          ? "script_args_truncated"
          : "large_field_missing",
      toolName,
      field: missingField,
      reason: `${toolName} failed validation because required large field "${missingField}" is missing.`,
    });
  }

  if (
    toolName === "run_workflow_script" &&
    /neither a script|valid draftRef|valid skillRef|likely truncated/i.test(text)
  ) {
    return diagnosis({
      code: "script_args_truncated",
      toolName,
      field: "script",
      reason: "run_workflow_script was called without script/draftRef/skillRef after a likely output-length truncation.",
    });
  }

  if (toolName === "delegate_subagents" && /without any tasks|truncated/i.test(text)) {
    return diagnosis({
      code: "tool_args_truncated",
      toolName,
      field: "tasks",
      reason: "delegate_subagents was called without tasks after a likely output-length truncation.",
    });
  }

  for (const field of candidates) {
    if (!hasOwnString(input.input, field)) continue;
    const size = String(getArg(input.input, field)).length;
    const budget = BUDGETS[`${toolName}.${field}`];
    if (budget && size > budget) {
      return diagnosis({
        code: "oversized_tool_payload",
        toolName,
        field,
        reason: `${toolName}.${field} is ${size} chars, above ${budget} char soft budget.`,
      });
    }
  }

  return null;
}

export function appendToolTruncationRecovery(
  text: string,
  diagnosisInput: ToolTruncationDiagnosis,
): string {
  if (text.includes("Tool argument truncation recovery:")) return text;
  return [
    text.trimEnd(),
    "",
    "Tool argument truncation recovery:",
    diagnosisInput.userMessage,
    `Diagnostic: ${diagnosisInput.code}${diagnosisInput.field ? ` (${diagnosisInput.field})` : ""}.`,
  ].join("\n");
}
