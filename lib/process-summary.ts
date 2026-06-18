import { formatTokens } from "./format";
import { dedupeToolLabels } from "./narration/summary";
import { narrateTool, shouldHideTool } from "./narration/tool";
import type { ChatMessage, ChatMessageMeta, MessagePart } from "./types";

export interface ProcessSummary {
  title: string;
  detail: string;
  tools: string[];
  stepCount: number;
  errorRecoveredCount: number;
  running: boolean;
  usage?: {
    input: number;
    output: number;
    cost: number;
  };
}

function partsFromMessage(message: ChatMessage): MessagePart[] {
  let parts: MessagePart[] = message.parts ? [...message.parts] : [];
  if (message.thinking && !parts.some((part) => part.kind === "thinking")) {
    parts = [...parts, { kind: "thinking", text: message.thinking }];
  }
  if (
    message.text &&
    !parts.some((part) => part.kind === "text" && part.text === message.text)
  ) {
    parts = [...parts, { kind: "text", text: message.text }];
  }
  return parts;
}

export function buildProcessSummary({
  parts,
  messages,
  meta,
  forceRunning = false,
}: {
  parts?: MessagePart[];
  messages?: ChatMessage[];
  meta?: ChatMessageMeta;
  forceRunning?: boolean;
}): ProcessSummary {
  const sourceParts = parts ?? messages?.flatMap(partsFromMessage) ?? [];
  const metas = messages?.map((message) => message.meta).filter(Boolean) ?? [];
  if (meta) metas.push(meta);

  let errorRecoveredCount = 0;
  let approvals = 0;
  let thinking = 0;
  let runningCount = 0;
  const toolLabels: string[] = [];
  const errorLabels: string[] = [];
  const models = new Map<string, number>();
  let input = 0;
  let output = 0;
  let cost = 0;

  for (const item of metas) {
    if (!item) continue;
    if (item.model) models.set(item.model, (models.get(item.model) ?? 0) + 1);
    if (item.usage) {
      input += item.usage.input;
      output += item.usage.output;
      cost += item.usage.cost;
    }
  }

  for (const part of sourceParts) {
    if (part.kind === "tool") {
      if (!shouldHideTool(part)) {
        const label = narrateTool(part).primary;
        if (label) toolLabels.push(label);
        if (part.status === "error" || part.isError) {
          errorLabels.push(label || `调用 ${part.toolName}`);
        }
      }
      if (part.status === "running") runningCount += 1;
      if (part.status === "error" || part.isError) errorRecoveredCount += 1;
    } else if (part.kind === "thinking") {
      thinking += 1;
    } else if (part.kind === "approval") {
      approvals += 1;
      if (part.status === "denied") {
        errorRecoveredCount += 1;
        errorLabels.push(`工具确认被拒绝：${part.toolName}`);
      }
    } else if (part.kind === "subagent_batch" && part.status === "failed") {
      errorRecoveredCount += 1;
    } else if (part.kind === "workflow_run" && part.status === "failed") {
      errorRecoveredCount += 1;
    }
  }

  const toolNames = dedupeToolLabels(toolLabels).slice(0, 3);
  const fallbacks = [
    thinking > 0 ? `思考×${thinking}` : "",
    approvals > 0 ? `确认×${approvals}` : "",
  ].filter(Boolean);
  const usage =
    input > 0 || output > 0 || cost > 0 ? { input, output, cost } : undefined;
  const usageText = usage
    ? `${formatTokens(input)} in · ${formatTokens(output)} out${
        cost > 0 ? ` · $${cost.toFixed(4)}` : ""
      }`
    : "";
  const modelLabel =
    [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    meta?.model ??
    meta?.provider ??
    "";
  const stepCount = sourceParts.length || messages?.length || 0;
  const running = forceRunning || runningCount > 0;
  const actor = modelLabel ? `${modelLabel} · ` : "";
  const verb = running ? "执行中" : "已处理";
  const issue = summarizeIssue(errorLabels, errorRecoveredCount, running);
  const title =
    issue
      ? `${actor}${issue}`
      : `${actor}${verb} ${stepCount} 个步骤`;

  return {
    title,
    detail:
      [toolNames.join(" / ") || fallbacks.join(" / "), usageText]
        .filter(Boolean)
        .join(" · ") || "过程记录",
    tools: toolNames,
    stepCount,
    errorRecoveredCount,
    running,
    usage,
  };
}

function summarizeIssue(
  labels: string[],
  count: number,
  running: boolean
): string | null {
  if (count <= 0) return null;
  const prefix = running ? "执行失败" : "已处理：";
  const suffix = running ? "" : "曾失败";
  const rawLabel = dedupeToolLabels(labels)[0]?.replace(/^执行失败：/, "").trim();
  // 限长 label：避免 "查找：grep -n ... a.ts b.ts c.ts" 这种似错不错的长串
  // 被拼到折叠/头条 title 里变成一条被截断的红框。
  const label = rawLabel
    ? rawLabel.length > 24
      ? `${rawLabel.slice(0, 23)}…`
      : rawLabel
    : rawLabel;
  if (!label) {
    if (running) return count > 1 ? `执行失败：${count} 个步骤` : "执行失败";
    return count > 1 ? `已处理：${count} 个步骤曾失败` : "已处理：1 个步骤曾失败";
  }
  if (running) {
    return count > 1
      ? `${prefix}：${label} 等 ${count} 个步骤`
      : `${prefix}：${label}`;
  }
  return count > 1
    ? `${prefix}${label} 等 ${count} 个步骤${suffix}`
    : `${prefix}${label}${suffix}`;
}
