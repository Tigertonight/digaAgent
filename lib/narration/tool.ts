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
function withFailure(tool: ToolPart, narration: ToolNarration, errorText: string): ToolNarration {
  if (tool.status !== "error" && !tool.isError) return narration;
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
  if (!hibo) return /\b(grep|rg)\b/.test(command) ? { verb: "查找", object: stripFlags(command.replace(/^.*?\b(grep|rg)\b\s*/, "")) || undefined } : null;
  const sub = hibo[1] ?? "";
  const rest = stripFlags(hibo[2] ?? "");
  if (/meeting|room/i.test(sub)) return { verb: "帮你查询会议室", object: /^(rooms?|query)$/i.test(rest) ? undefined : rest || undefined };
  return { verb: "帮你查询知识库", object: rest || undefined };
}
function cleanCommandForDisplay(command: string): string { return shorten(stripSecrets(command).replace(/\s+/g, " ").trim(), 120); }
function stripSecrets(text: string): string { return text.replace(/(--cookie|--token|--secret|--password)\s+\S+/gi, "$1 ***").replace(/(cookie|token|secret|password)=\S+/gi, "$1=***"); }
function stripFlags(text: string): string { return stripSecrets(text).replace(/--[\w-]+(?:\s+\S+)?/g, "").replace(/\s+/g, " ").trim(); }
function searchQuery(tool: ToolPart): string { return sanitizeText(asString(getArg(tool.args, "query", "pattern", "text", "q"))).trim(); }
function pathArg(tool: ToolPart): string { return asString(getArg(tool.args, "path", "file_path", "file")).trim(); }
function commandArg(tool: ToolPart): string { return asString(getArg(tool.args, "command", "cmd")).trim(); }
function normalizeToolName(name: string): string { return (name || "").toLowerCase().replace(/[:\s]+/g, "_"); }
function friendlyToolName(name: string): string { return (name || "工具").replace(/_/g, " "); }
function sanitizeText(text: string): string { return stripSecrets(text).replace(/\s+/g, " ").trim(); }
