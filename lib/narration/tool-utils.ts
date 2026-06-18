/**
 * 思维链/工具叙事 helper 工具函数。Phase 1+2 规则引擎用，Phase 3 LLM 增强可复用。
 *
 * 注意：所有函数对未知 shape 都做了 best-effort，绝不抛错；调用方拿到空字符串
 * 视为"没识别到"。
 */

/** 把任意值转成 stringified 单行展示。已 trim 末尾换行。 */
export function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 在 args/result 这种 record 上按多个备选 key 取第一个非 undefined 的。 */
export function getArg(args: unknown, ...keys: string[]): unknown {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

/** 文本长度限制。超过 max 截断并加省略号，单行（不会跨行）。 */
export function shorten(text: string, max: number): string {
  if (!text) return "";
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

/** 路径裁剪：保留末两段，例如 /Users/me/code/lib/foo.ts → lib/foo.ts。 */
export function shortPath(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  // 排除 URL，URL 直接返回（由调用方决定要不要截断）
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(trimmed)) return trimmed;
  const cleaned = trimmed.replace(/^\.\/+/, "").replace(/\\+/g, "/").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || cleaned;
  return parts.slice(-2).join("/");
}

/**
 * 从路径推断 skill：识别 .../skills/<name>/... 或 .../<name>/SKILL.md 形态。
 * 如果命中返回 { skillName, isLearning }；isLearning=true 表示是 SKILL.md 读取
 * （"正在学习"），false 表示是 skill 内部脚本（"正在使用"）。
 */
export function detectSkillFromPath(input: string): {
  skillName: string;
  isLearning: boolean;
} | null {
  if (!input) return null;
  const norm = input.replace(/\\+/g, "/");
  const skillsMatch = norm.match(/(?:^|\/)(?:agent\/)?skills\/([^/]+)\/(.*)$/i);
  if (skillsMatch) {
    const name = skillsMatch[1];
    const rest = skillsMatch[2] ?? "";
    if (!name || /^\.|\.$/.test(name)) return null;
    return {
      skillName: name,
      isLearning: /SKILL\.(md|markdown)$/i.test(rest),
    };
  }
  // 兼容 .skill / .pi/agent/skills 类形态：直接 SKILL.md 末尾
  const direct = norm.match(/(?:^|\/)([^/]+)\/SKILL\.(?:md|markdown)$/i);
  if (direct) {
    const name = direct[1];
    if (name && !/^\.|\.$/.test(name)) return { skillName: name, isLearning: true };
  }
  return null;
}

/** 命令是不是验证类（lint/test/build）—— 文案上区分"验证命令" vs "终端命令"。 */
export function isVerificationCommand(command: string): boolean {
  if (!command) return false;
  return /\b(tsc|eslint|vitest|playwright|jest|pytest|npm\s+(test|lint|build)|npm\s+run\s+(test|lint|build|route-auth:check|public-surface:check)|pnpm\s+(test|lint|build)|yarn\s+(test|lint|build))\b/.test(
    command,
  );
}

/**
 * 内部噪音 tool 名单——这些 tool 对用户没有可读性意义，主视图直接隐藏。
 * 仍会进入 process group 折叠区的 tool 计数。
 *
 * 与 Java PRD 的 shouldHide(rawContent) 等价。
 */
const HIDDEN_INTERNAL_TOOLS = new Set([
  "update_progress",
  "goal_update",
  "add_evidence",
  "evidence_add",
  "process_status",
]);

export function isInternalNoiseTool(toolName: string): boolean {
  if (!toolName) return false;
  return HIDDEN_INTERNAL_TOOLS.has(toolName.toLowerCase());
}

/**
 * 从工具 result 里挑出文本。兼容三种常见形态：
 *   1. 裸数组 [{type:"text",text},{type:"image",...}]
 *   2. AgentToolResult 包装 {content:[...]}（tool_execution_end 的 result 即此形态，
 *      校验失败 / 错误信息就藏在这里——之前只处理裸数组，导致错误透不出来）
 *   3. {content:"string"} 或 {text:"string"}
 */
export function extractTextFromResult(result: unknown): string {
  if (typeof result === "string") return result;
  // 解包 AgentToolResult 的 content；优先 content，回退 text。
  const unwrapped =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as { content?: unknown }).content ??
        (result as { text?: unknown }).text)
      : result;
  if (typeof unwrapped === "string") return unwrapped;
  if (!Array.isArray(unwrapped)) return "";
  const texts: string[] = [];
  for (const item of unwrapped) {
    if (typeof item === "string") {
      texts.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const t = (item as { type?: unknown }).type;
      if (t === "text" || t === undefined) {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  return texts.join("\n");
}

/** 从 result 抽错误描述。优先 error/message/stderr/output → text 块 → 整体 stringify。 */
export function summarizeToolError(
  result: unknown,
  partialResult: unknown,
): string {
  const r = result ?? partialResult;
  const candidates = [
    getArg(r, "error"),
    getArg(r, "message"),
    getArg(r, "stderr"),
    getArg(r, "output"),
    extractTextFromResult(r),
    typeof r === "string" ? r : "",
  ];
  const text = candidates.map((v) => asString(v).trim()).find(Boolean) ?? "";
  return shorten(text, 180);
}

/**
 * 从 args 里挑出“对用户最有意义”的目标短语：路径/URL/命令/查询词。
 * tool.ts 里另有一个以 ToolPart 为入参、会对 path 走 shortPath 的包装。
 */
export function summarizeRecordTarget(
  args: unknown,
  result: unknown,
): string {
  const keys = [
    "path",
    "file_path",
    "file",
    "url",
    "href",
    "command",
    "cmd",
    "query",
    "pattern",
    "selector",
    "text",
    "expectation",
    "status",
  ];
  for (const key of keys) {
    const value = getArg(args, key);
    const text = asString(value).trim();
    if (text && text !== "{}") return shorten(text, 120);
  }
  // 一些工具 args 不含 target，退而看 result.path / result.url
  for (const key of ["path", "url", "href"]) {
    const value = getArg(result, key);
    const text = asString(value).trim();
    if (text && text !== "{}") return shorten(text, 120);
  }
  return "";
}
