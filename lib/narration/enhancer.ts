import "server-only";
import { completeSimple, type TextContent } from "@earendil-works/pi-ai";
import type { MessagePart } from "@/lib/types";
import { getModelRegistry } from "@/lib/agent-registry";
import { getLastModel } from "@/lib/preferences/last-model";
import { getNarrationSettings } from "./settings";
import { isWorthNarrating, narrateTool } from "./tool";

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;

interface NarrateParams {
  question?: string;
  locale?: string;
  tool: ToolPart;
  ruleText?: string;
  /** 客户端 abort 会同步取消 LLM 调用，避免心跳后继续燃烧 token。 */
  signal?: AbortSignal;
}

const cache = new Map<string, string>();
const MAX_CACHE = 300;

export function clearNarrationCacheForTest() {
  cache.clear();
}

export function narrationCacheKey(params: NarrateParams): string {
  return [
    params.locale || "zh-CN",
    params.question || "",
    params.tool.toolName,
    stableStringify(params.tool.args ?? {}),
  ].join("|");
}

export async function enhanceToolNarration(params: NarrateParams): Promise<{
  text: string;
  enhanced: boolean;
  reason?: string;
}> {
  const ruleText = params.ruleText || narrateTool(params.tool).primary;
  if (!ruleText || !isWorthNarrating(params.tool)) {
    return { text: ruleText, enhanced: false, reason: "not_worth" };
  }
  const settings = await getNarrationSettings();
  if (!settings.enable) return { text: ruleText, enhanced: false, reason: "disabled" };

  const key = narrationCacheKey(params);
  const cached = cache.get(key);
  if (cached) return { text: cached, enhanced: true, reason: "cache" };

  if (params.signal?.aborted) {
    return { text: ruleText, enhanced: false, reason: "aborted" };
  }
  const task = requestNarration(params, ruleText, settings)
    .then((text) => {
      const cleaned = cleanModelOutput(text, params.locale || "zh-CN");
      if (cleaned) putCache(key, cleaned);
      return cleaned;
    })
    .catch(() => "");

  const timed = await Promise.race([
    task,
    new Promise<string>((resolve) => setTimeout(() => resolve(""), settings.timeoutMs)),
  ]);
  if (timed) return { text: timed, enhanced: true };
  // 后台 task 仍会写 cache；本次先回落规则文案。
  void task;
  return { text: ruleText, enhanced: false, reason: "timeout_or_failed" };
}

async function requestNarration(
  params: NarrateParams,
  ruleText: string,
  settings: Awaited<ReturnType<typeof getNarrationSettings>>
): Promise<string> {
  const selection = settings.provider && settings.modelId
    ? { provider: settings.provider, modelId: settings.modelId }
    : await getLastModel();
  if (!selection?.provider || !selection.modelId) return "";
  const mr = getModelRegistry();
  const model = mr.find(selection.provider, selection.modelId);
  if (!model) return "";
  const auth = await mr.getApiKeyAndHeaders(model);
  if (!auth.ok) return "";

  const prompt = buildPrompt({
    question: params.question || "",
    toolLog: `${params.tool.toolName}: ${stableStringify(params.tool.args ?? {})}`,
    ruleText,
    locale: params.locale || "zh-CN",
  });

  const msg = await completeSimple(
    model,
    {
      systemPrompt: "你是 AI 助手思维链的实时解说员，只输出一句短句。",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      temperature: 0.2,
      maxTokens: 80,
      timeoutMs: Math.max(1000, settings.timeoutMs + 500),
      maxRetries: 0,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
    }
  );
  return msg.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function buildPrompt(vars: {
  question: string;
  toolLog: string;
  ruleText: string;
  locale: string;
}): string {
  return `你是 AI 助手思维链的"实时解说员"。把一条工具调用日志改写成一句普通用户一眼能看懂的进行时叙述。

要求：
1. 只输出一句话，不超过 25 个字（英文不超过 12 个词），不要解释、引号、emoji、句号
2. 中文以"正在"开头；英文用现在进行时
3. 结合用户问题描述意图，不要翻译命令本身
4. 保留有意义信息：查询内容、日期、文件名、技能用途；丢弃 flag/cookie/内部代号
5. 看不懂就原样输出参考文案
6. 输出语言严格遵循 locale

用户问题：${vars.question}
工具日志：${vars.toolLog}
参考文案：${vars.ruleText}
locale：${vars.locale}
输出：`;
}

function cleanModelOutput(raw: string, locale: string): string {
  const one = raw
    .replace(/^输出[:：]\s*/i, "")
    .replace(/["“”]/g, "")
    .split(/\r?\n/)[0]
    .trim()
    .replace(/[。.!！]+$/g, "");
  if (!one) return "";
  if (/^zh/i.test(locale) && !one.startsWith("正在")) return "";
  if (one.length > 60) return "";
  return one;
}

function putCache(key: string, value: string) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return String(value);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortJson(v)])
    );
  }
  return value;
}
