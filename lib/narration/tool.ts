import type { MessagePart } from "@/lib/types";
import {
  asString,
  detectSkillFromPath,
  extractTextFromResult,
  getArg,
  isInternalNoiseTool,
  isVerificationCommand,
  shortPath,
  shorten,
  summarizeToolError as summarizeToolErrorFromResult,
} from "./tool-utils";

export {
  asString,
  extractTextFromResult,
  getArg,
  isVerificationCommand as commandKind,
  shortPath,
  shorten,
};

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;

export interface ToolNarration {
  primary: string;
  secondary?: string;
  recovery?: string;
  hidden?: boolean;
}

const READ_NAMES = new Set(["read", "read_file"]);
const WRITE_NAMES = new Set(["write", "write_file", "create_file"]);
const EDIT_NAMES = new Set(["edit", "edit_file", "str_replace"]);
const EXEC_NAMES = new Set(["bash", "shell", "exec"]);
const SEARCH_NAMES = new Set(["grep", "search", "find", "glob", "web_search", "browser_search"]);
const LIST_NAMES = new Set(["ls", "list", "list_directory"]);

export function shouldHideTool(tool: ToolPart): boolean {
  const name = normalizeToolName(tool.toolName);
  if (isInternalNoiseTool(name)) return true;
  const target = summarizeToolTarget(tool);
  return /^Process:\s*[-\w]+$/i.test(target) || /^quiet-[a-z-]+$/i.test(target);
}

/** Phase 3 LLM 白名单：只增强 Exec / 搜索类，文件读写和内部治理工具规则直出。 */
export function isWorthNarrating(tool: ToolPart): boolean {
  if (shouldHideTool(tool)) return false;
  const name = normalizeToolName(tool.toolName);
  if (!(EXEC_NAMES.has(name) || SEARCH_NAMES.has(name))) return false;
  const target = summarizeToolTarget(tool);
  if (!target) return false;
  const cmd = commandArg(tool);
  const path = pathArg(tool);
  // 技能脚本 / SKILL.md 已有很明确的规则文案，不再浪费 LLM。
  if (detectSkillFromPath(path) || detectSkillFromPath(cmd)) return false;
  return true;
}

export function narrateTool(tool: ToolPart): ToolNarration {
  if (shouldHideTool(tool)) return { primary: "", hidden: true };
  const name = normalizeToolName(tool.toolName);
  const phase = phaseText(tool.status);
  const errorText = tool.status === "error" || tool.isError ? summarizeToolError(tool) : "";
  const path = pathArg(tool);
  const cmd = commandArg(tool);
  const skill = detectSkillFromPath(path) || detectSkillFromPath(cmd);
  if (skill) {
    return withFailure(tool, {
      primary: `${phase}${skill.isLearning ? "学习" : "使用"}「${skill.skillName}」技能`,
      secondary: skill.isLearning ? "正在读取技能说明，理解这个技能能做什么、怎么调用。" : "正在通过技能脚本完成更贴近业务语义的操作。",
    }, errorText);
  }
  if (READ_NAMES.has(name)) return withFailure(tool, { primary: `${phase}查看 ${path ? shortPath(path) : "文件内容"}`, secondary: tool.status === "running" ? "先看现有实现和上下文，避免后续修改偏离代码当前结构。" : "这一步用于确认事实依据，后续修改或判断会基于读到的内容。" }, errorText);
  if (WRITE_NAMES.has(name) || EDIT_NAMES.has(name)) {
    const target = path ? shortPath(path) : "文件";
    return withFailure(tool, { primary: `${phase}${WRITE_NAMES.has(name) ? "写入" : "修改"} ${target}`, secondary: tool.status === "running" ? "正在把已确认的变更落到文件里，完成后需要通过检查或测试验证。" : "文件变更已经生成，建议继续查看 diff、运行检查，确认没有引入回归。" }, errorText);
  }
  if (EXEC_NAMES.has(name)) {
    const cli = describeCliCommand(cmd);
    const primary = cli ? `${phase}${cli.verb}${cli.object ? `：${cli.object}` : ""}` : `${phase}${isVerificationCommand(cmd) ? "验证" : "运行终端命令"}${cmd ? `：${cleanCommandForDisplay(cmd)}` : ""}`;
    return withFailure(tool, { primary, secondary: isVerificationCommand(cmd) ? "这一步用来确认代码质量和回归状态，把结果从主观判断变成可验证信号。" : "这一步用于从环境里拿事实、执行脚本或检查当前项目状态。" }, errorText);
  }
  if (name.startsWith("browser_") || name.startsWith("browser:")) return withFailure(tool, browserNarration(name, summarizeToolTarget(tool), tool.status), errorText);
  if (SEARCH_NAMES.has(name)) {
    const query = searchQuery(tool);
    return withFailure(tool, { primary: `${phase}${name.includes("web") || name.includes("browser") ? "搜索网页" : "查找"}${query ? `：${query}` : "相关信息"}`, secondary: "先定位文件、符号、网页或目录结构，再决定下一步读文件、修改或验证。" }, errorText);
  }
  if (LIST_NAMES.has(name)) return withFailure(tool, { primary: `${phase}查看 ${path ? shortPath(path) : "目录内容"}`, secondary: "先确认目录结构，再决定下一步读取或修改哪些文件。" }, errorText);
  if (name.includes("test") || name.includes("verify")) return withFailure(tool, { primary: `${phase}执行验证${summarizeToolTarget(tool) ? `：${summarizeToolTarget(tool)}` : ""}`, secondary: "这一步用于确认结果是否符合预期，失败时需要根据输出继续修复。" }, errorText);
  const target = summarizeToolTarget(tool);
  return withFailure(tool, { primary: `${phase}调用 ${friendlyToolName(tool.toolName)}${target ? `：${target}` : ""}`, secondary: "这一步是 agent 完成任务所需的外部操作，详细参数和结果可展开查看。" }, errorText);
}

export function summarizeToolTarget(tool: ToolPart): string {
  for (const key of ["path", "file_path", "file", "url", "href", "query", "pattern", "selector", "text", "expectation", "status", "command", "cmd"]) {
    const text = asString(getArg(tool.args, key)).trim();
    if (text && text !== "{}") return key.includes("path") || key === "file" ? shortPath(text) : shorten(sanitizeText(text), 120);
  }
  return "";
}

export function summarizeToolError(tool: ToolPart): string {
  return summarizeToolErrorFromResult(tool.result, tool.partialResult);
}

function phaseText(status: ToolPart["status"]): string {
  if (status === "running") return "正在";
  if (status === "error") return "执行失败：";
  return "已完成：";
}
/**
 * 识别"工具调用被截断"特征：schema 校验报某个必填字段缺失（如 write 缺 content、
 * edit 缺 edits、bash 缺 command），且这些字段正是大体量参数。模型把一大段内容
 * （如长报告）塞进参数时，provider 输出长度上限会把后半段连同该字段一起截掉，
 * 留下只有 path 的非法调用。命中时给出更对症的"分段重写"建议，而不是泛泛重试。
 */
const TRUNCATION_PRONE_FIELDS = ["content", "edits", "new_string", "command", "text"];
export function detectTruncatedToolCall(errorText: string): string | null {
  if (!errorText) return null;
  // 典型文案：'Validation failed for tool "write": - content: must have required properties content'
  if (!/validation failed/i.test(errorText)) return null;
  if (!/required propert|must have required|is required|required field/i.test(errorText)) {
    return null;
  }
  const field = TRUNCATION_PRONE_FIELDS.find((f) =>
    new RegExp(`\\b${f}\\b`).test(errorText)
  );
  if (!field) return null;
  return field;
}

function withFailure(tool: ToolPart, narration: ToolNarration, errorText: string): ToolNarration {
  if (tool.status !== "error" && !tool.isError) return narration;
  const truncatedField = detectTruncatedToolCall(errorText);
  if (truncatedField) {
    const cause = `遇到的问题：工具调用疑似被截断——缺少必填字段「${truncatedField}」（${shorten(errorText, 120)}）。`;
    return {
      ...narration,
      recovery: `${cause} 这通常是单次输出过长被截断造成的。不要原样重试同一个工具调用；应先写入较短的骨架/大纲，再用 edit 分多次追加每个章节，最后用 read 或 wc 校验文件非空，避免把超大内容一次性塞进同一个工具参数。`,
    };
  }
  const cause = errorText ? `遇到的问题：${errorText}` : "工具返回了错误状态。";
  return { ...narration, recovery: `${cause} 接下来应根据错误信息调整参数、换一条更稳的路径，或在必要时重试。` };
}
function browserNarration(name: string, target: string, status: ToolPart["status"]): ToolNarration {
  const phase = phaseText(status);
  if (name.includes("open")) return { primary: `${phase}打开页面${target ? `：${target}` : ""}`, secondary: "先让页面进入可观察状态，后续才能点击、输入、提取内容或验收页面结果。" };
  if (name.includes("click")) return { primary: `${phase}点击页面元素${target ? `：${target}` : ""}`, secondary: "这一步模拟用户操作，用来推进页面流程或触发目标状态。" };
  if (name.includes("type") || name.includes("fill") || name.includes("input")) return { primary: `${phase}向页面输入内容${target ? `：${target}` : ""}`, secondary: "这一步用于验证表单、搜索框或交互控件是否能被 agent 正确操作。" };
  if (name.includes("extract")) return { primary: `${phase}提取页面内容`, secondary: "先把页面事实转成文本证据，再继续判断下一步是否达成预期。" };
  if (name.includes("verify")) return { primary: `${phase}验证页面状态${target ? `：${target}` : ""}`, secondary: "这一步把浏览器观察结果转成 PASS/FAIL，避免只凭肉眼描述。" };
  if (name.includes("wait")) return { primary: `${phase}等待页面达到目标状态${target ? `：${target}` : ""}`, secondary: "页面跳转或异步渲染需要时间，等待可以减少误判和过早失败。" };
  if (name.includes("screenshot")) return { primary: `${phase}采集页面截图`, secondary: "截图会作为视觉证据，方便后续批注、验收或排查界面问题。" };
  return { primary: `${phase}操作浏览器${target ? `：${target}` : ""}`, secondary: "这一步让 agent 和用户共用同一个可观察页面状态。" };
}
function describeCliCommand(command: string): { verb: string; object?: string } | null {
  const hibo = command.trim().match(/(?:^|\s)hibo\s+(\S+)(?:\s+([\s\S]+))?/);
  if (!hibo) {
    if (/\b(grep|rg|egrep|fgrep|ripgrep)\b/.test(command)) {
      // 原本是把 grep/rg 后面整个命令都填进 object——遇上多文件 / 多参数
      // 的 grep 会脓到不可读，上层可能还会加 "执行失败：" / "已处理：" 前缀、
      // 然后被裁到 44 字，看起来就是一条被截断的红框。这里抽出 pattern 作为 object，
      // 其他 (path / glob / flags) 全干掉；抽不到时也给用户一个完整动作文案。
      const pattern = extractGrepPattern(command);
      return pattern
        ? { verb: "查找", object: pattern }
        : { verb: "查找相关内容" };
    }
    return null;
  }
  const sub = hibo[1] ?? "";
  const rest = stripFlags(hibo[2] ?? "");
  if (/meeting|room/i.test(sub)) return { verb: "帮你查询会议室", object: /^(rooms?|query)$/i.test(rest) ? undefined : rest || undefined };
  return { verb: "帮你查询知识库", object: rest || undefined };
}
function cleanCommandForDisplay(command: string): string { return shorten(stripSecrets(command).replace(/\s+/g, " ").trim(), 120); }
function stripSecrets(text: string): string { return text.replace(/(--cookie|--token|--secret|--password)\s+\S+/gi, "$1 ***").replace(/(cookie|token|secret|password)=\S+/gi, "$1=***"); }
function stripFlags(text: string): string { return stripSecrets(text).replace(/--[\w-]+(?:\s+\S+)?/g, "").replace(/\s+/g, " ").trim(); }
/**
 * 从一条 "... grep/rg [flags] PATTERN [paths…]" 形式的命令里提取 PATTERN。
 * 提取不出返空串，使调用方退化到 "查找" 不带 object。
 */
function extractGrepPattern(command: string): string {
  const cleaned = stripSecrets(command);
  // 先按 shell 语义切 token（会处理引号 / 转义），再在 token 层面上看是不是遇到
  // 未引号的管道 / 逻辑运算符。避免把引号里的 "foo|bar" 误切。
  // 对管道里常见的 "rg --files | rg pattern" 取最后一个 grep/rg 段的 pattern。
  const allTokens = splitShellTokens(cleaned);
  const segments: string[][] = [[]];
  for (const tok of allTokens) {
    if (tok === "|" || tok === ";" || tok === "&" || tok === "&&" || tok === "||") {
      if (tok === "|" && segments.at(-1)?.length) segments.push([]);
      else break;
      continue;
    }
    segments.at(-1)?.push(tok);
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const pattern = extractGrepPatternFromTokens(segments[i] ?? []);
    if (pattern) return pattern;
  }
  return "";
}

function extractGrepPatternFromTokens(headTokens: string[]): string {
  const grepIdx = headTokens.findIndex((t) => /^(grep|rg|egrep|fgrep|ripgrep)$/.test(t));
  if (grepIdx < 0) return "";
  const tokens = headTokens.slice(grepIdx + 1);
  if (tokens.some((tok) => tok === "--files")) return "";
  const flagsWithValue = new Set([
    "-e", "-f", "-g", "-G", "-t", "-T", "--glob", "--iglob", "--type", "--type-not",
    "--regexp", "--file", "--include", "--exclude", "--exclude-dir",
    "-A", "-B", "-C", "--after-context", "--before-context", "--context",
    "--max-count", "-m",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (!tok) continue;
    if (tok === "--") continue;
    if (tok.startsWith("-") && tok.length > 1) {
      // -e PATTERN 这种，取下一个作为 pattern
      if (tok === "-e" || tok === "--regexp") {
        const next = tokens[i + 1];
        if (next) return shorten(next, 32);
      }
      // -A=3 / --glob=*.ts 这种不需要多跳
      if (tok.includes("=")) continue;
      // 带值的 long/short flag 跳过下一个 token
      if (flagsWithValue.has(tok)) {
        i += 1;
        continue;
      }
      continue;
    }
    return shorten(tok, 32);
  }
  return "";
}
function splitShellTokens(text: string): string[] {
  // 简易 tokenizer：支持 "..." / '...' / \<space> 转义、以及将未引号的
  // | / || / & / && / ; 作为独立 token，供上层识别“报句边界”。
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const flush = () => {
    if (cur) {
      out.push(cur);
      cur = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < text.length) {
        cur += text[i + 1] ?? "";
        i += 1;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      cur += text[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      flush();
      const next = text[i + 1] ?? "";
      if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) {
        out.push(ch + next);
        i += 1;
      } else {
        out.push(ch);
      }
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}
function searchQuery(tool: ToolPart): string { return sanitizeText(asString(getArg(tool.args, "query", "pattern", "text", "q"))).trim(); }
function pathArg(tool: ToolPart): string { return asString(getArg(tool.args, "path", "file_path", "file")).trim(); }
function commandArg(tool: ToolPart): string { return asString(getArg(tool.args, "command", "cmd")).trim(); }
function normalizeToolName(name: string): string { return (name || "").toLowerCase().replace(/[:\s]+/g, "_"); }
function friendlyToolName(name: string): string { return (name || "工具").replace(/_/g, " "); }
function sanitizeText(text: string): string { return stripSecrets(text).replace(/\s+/g, " ").trim(); }
