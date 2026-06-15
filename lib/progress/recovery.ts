import type {
  AgentProgress,
  ProgressGroup,
  ProgressStep,
} from "./types";

const INTERRUPTED_STEP_ID = "runtime-interrupted";

/**
 * 判定 session 恢复出来的 messages 里是否存在未配对的工具调用。
 *
 * SDK 的 AgentMessage.content 用 anthropic-style 块：
 *   - assistant.tool_use { id, name, input } 起调用
 *   - tool.tool_result { tool_use_id, content, is_error } 与之配对
 * (OpenAI 兼容层会变体为 toolCall/toolResult，同样以 id 为键。)
 *
 * 如果存在只有 tool_use 但没有对应 tool_result，意味着上轮进程在工具返回前崩了，
 * 需要在恢复路径上作为“异常中断”处理。最后一条 assistant message 可以带完整的
 * stopReason 终态，这里的判定是在按 id 配对后看是否还有裸露的 tool_use。
 */
export function hasUnpairedToolCalls(
  messages: ReadonlyArray<{
    role: string;
    toolCallId?: string;
    content?: ReadonlyArray<{
      type?: string;
      id?: string;
      tool_use_id?: string;
    }>;
  }>
): boolean {
  const seenResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) {
      seenResultIds.add(m.toolCallId);
      continue;
    }
    if (m.role === "tool") {
      for (const c of m.content ?? []) {
        if (c.type === "tool_result" && c.tool_use_id) {
          seenResultIds.add(c.tool_use_id);
        }
      }
    }
  }
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.content ?? []) {
      if (c.type === "tool_use" || c.type === "toolCall") {
        const id = c.id;
        if (id && !seenResultIds.has(id)) return true;
      }
    }
  }
  return false;
}

/**
 * 判定是否已经为本次“异常中断”补过节点，或原始快照里末尾本身就是
 * blocked（blocked 是主动设的 “需要人经手” 状态，markInterrupted 不应该越他）。
 * 主动带了 failed 的节点不作为“已告知过中断”，还要加 runtime-interrupted，让
 * UI 能反映“本次是进程崩”，而不是仅是某个子步骤失败。
 */
function shouldSkipMarker(steps: ProgressStep[]): boolean {
  for (const step of steps) {
    if (step.id === INTERRUPTED_STEP_ID) return true;
    if (step.status === "blocked") return true;
  }
  return false;
}

export function markInterruptedProgress(
  progress: AgentProgress | null,
  summary = "上次运行在工具返回前被中断，进度可能未完成。"
): AgentProgress | null {
  if (!progress) return progress;
  const t = Date.now();
  let changed = false;

  // 原始快照是否含 running/pending。后面决定要不要补 runtime-interrupted 节点。
  const originalHadOpen = progress.groups.some((g) =>
    g.steps.some(
      (step) => step.status === "running" || step.status === "pending"
    )
  ) || progress.steps.some(
    (step) => step.status === "running" || step.status === "pending"
  );
  const closeStep = (step: ProgressStep): ProgressStep => {
    if (step.status !== "running" && step.status !== "pending") return step;
    changed = true;
    return {
      ...step,
      status: "failed",
      summary: step.summary ? `${step.summary}\n${summary}` : summary,
      completedAt: t,
    };
  };

  let groups = progress.groups.map((group): ProgressGroup => {
    const hadOpen = group.steps.some(
      (step) => step.status === "running" || step.status === "pending"
    );
    return {
      ...group,
      steps: group.steps.map(closeStep),
      ...(hadOpen && group.endedAt === undefined ? { endedAt: t } : {}),
    };
  });
  let steps = progress.steps.map(closeStep);

  const latest = groups.at(-1);
  const latestSteps = latest?.steps ?? steps;
  // 补 runtime-interrupted 节点的准入条件：
  //   - 原始快照里要么有 running/pending（表明上次运行被截了）
  //   - 要么原本全是 completed（补一条提示 “快照看起来完美，但调用方认为进程崩了”）
  // 仅在末尾已有 runtime-interrupted 或主动 blocked 状态时跳过。
  const onlyCompleted = latestSteps.every(
    (step) => step.status === "completed"
  );
  const allowMarker = originalHadOpen || onlyCompleted;
  if (
    latestSteps.length > 0 &&
    !shouldSkipMarker(latestSteps) &&
    allowMarker
  ) {
    changed = true;
    const interruptedStep: ProgressStep = {
      id: INTERRUPTED_STEP_ID,
      title: "上次运行异常中断",
      status: "failed",
      summary,
      completedAt: t,
    };
    if (latest) {
      groups = groups.map((group) =>
        group.id === latest.id
          ? {
              ...group,
              steps: [...group.steps, interruptedStep],
              endedAt: group.endedAt ?? t,
            }
          : group
      );
      steps = groups.at(-1)?.steps ?? steps;
    } else {
      steps = [...steps, interruptedStep];
    }
  }

  if (!changed) return progress;
  return {
    ...progress,
    steps,
    groups,
    updatedAt: t,
  };
}
