import "server-only";
import {
  createAgent,
  getAgent,
  getEventsSince,
  getLatestEventSeq,
  onNewEvent,
} from "@/lib/agent-registry";
import {
  createTaskFinding,
  createTaskRun,
  getLongTask,
  listLongTasksDashboard,
  updateTaskRun,
} from "@/lib/tasks/store";
import type {
  LongTaskDefinition,
  LongTaskRun,
} from "@/lib/tasks/types";
import { withCommunicationInstructions } from "@/lib/communication/instructions";
import { getCommunicationSettings } from "@/lib/communication/settings";

const g = globalThis as unknown as { __digaAgentLongTaskRunner?: { starting: Set<string> } };
if (!g.__digaAgentLongTaskRunner) {
  g.__digaAgentLongTaskRunner = { starting: new Set() };
}
const runnerState = g.__digaAgentLongTaskRunner;

export interface StartLongTaskRunResult {
  task: LongTaskDefinition;
  run: LongTaskRun;
  agentId: string;
  sessionId: string;
  sessionFile?: string;
}

export async function startLongTaskRun(
  taskId: string
): Promise<StartLongTaskRunResult> {
  if (runnerState.starting.has(taskId)) {
    throw new Error("任务正在启动中");
  }
  runnerState.starting.add(taskId);
  try {
    return await startLongTaskRunUnsafe(taskId);
  } finally {
    runnerState.starting.delete(taskId);
  }
}

async function startLongTaskRunUnsafe(
  taskId: string
): Promise<StartLongTaskRunResult> {
  const task = getLongTask(taskId);
  if (!task) throw new Error("任务不存在");
  if (!task.enabled) throw new Error("任务已停用");
  if (task.status === "running" || task.status === "waiting_user") {
    throw new Error("任务正在运行中");
  }
  const run = createTaskRun(task.id);
  try {
    const agent = await createAgent({
      provider: task.provider,
      modelId: task.modelId,
      cwd: task.projectPath,
      thinkingLevel: "medium",
    });
    const rec = getAgent(agent.id);
    if (!rec) throw new Error("agent 创建失败");

    updateTaskRun(run.id, {
      status: "running",
      agentId: agent.id,
      sessionId: agent.sessionId,
      sessionFile: agent.sessionFile,
    });

    attachRunLifecycle(agent.id, run.id, task.id);
    await rec.session.prompt(
      withCommunicationInstructions(
        buildLongTaskPrompt(task),
        await getCommunicationSettings()
      )
    );

    return {
      task: getLongTask(task.id) ?? task,
      run: updateTaskRun(run.id, {
        status: "running",
        agentId: agent.id,
        sessionId: agent.sessionId,
        sessionFile: agent.sessionFile,
      }),
      agentId: agent.id,
      sessionId: agent.sessionId,
      sessionFile: agent.sessionFile,
    };
  } catch (e) {
    const failed = updateTaskRun(run.id, {
      status: "failed",
      endedAt: Date.now(),
      error: (e as Error).message,
    });
    return {
      task: getLongTask(task.id) ?? task,
      run: failed,
      agentId: "",
      sessionId: "",
    };
  }
}

export async function runDueLongTasks(): Promise<StartLongTaskRunResult[]> {
  const started: StartLongTaskRunResult[] = [];
  for (const task of listLongTasksDashboard().dueTasks) {
    try {
      started.push(await startLongTaskRun(task.id));
    } catch (e) {
      console.error("[long-tasks] due task start failed:", task.id, e);
    }
  }
  return started;
}

function attachRunLifecycle(agentId: string, runId: string, taskId: string): void {
  const rec = getAgent(agentId);
  if (!rec) return;
  let finalText = "";
  let settled = false;
  let lastSeq = getLatestEventSeq(agentId);
  const handleEvent = (event: { type?: string; message?: unknown }) => {
    if (event.type === "approval_request") {
      updateTaskRun(runId, {
        status: "waiting_user",
        waitingReason: waitingReasonFromEvent(event),
        summary: "等待你确认授权后继续执行。",
      });
    } else if (event.type === "clarification_request") {
      updateTaskRun(runId, {
        status: "waiting_user",
        waitingReason: waitingReasonFromEvent(event),
        summary: "等待你补充信息或选择下一步。",
      });
    } else if (
      event.type === "approval_resolved" ||
      event.type === "clarification_resolved"
    ) {
      updateTaskRun(runId, {
        status: "running",
        waitingReason: undefined,
        summary: "已收到你的决策，继续执行。",
      });
    } else if (event.type === "message_end") {
      finalText = messageText(event.message) || finalText;
    } else if (event.type === "agent_end") {
      settled = true;
      try {
        const parsed = parseTaskReport(finalText);
        const findingIds: string[] = [];
        if (parsed.hasFindings) {
          const finding = createTaskFinding({
            taskId,
            runId,
            title: parsed.title,
            body: parsed.body,
            severity: parsed.severity,
          });
          findingIds.push(finding.id);
        }
        updateTaskRun(runId, {
          status:
            findingIds.length > 0
              ? "completed_with_findings"
              : "completed_empty",
          endedAt: Date.now(),
          summary: parsed.summary,
          waitingReason: undefined,
          findingIds,
        });
      } finally {
        unsubscribe();
      }
    }
  };
  const unsubscribe = onNewEvent(agentId, () => {
    if (settled) return;
    const events = getEventsSince(agentId, lastSeq);
    for (const item of events) {
      lastSeq = item.seq;
      handleEvent(item.event as { type?: string; message?: unknown });
      if (settled) break;
    }
  });
}

function waitingReasonFromEvent(event: unknown): string {
  if (!event || typeof event !== "object") return "等待你确认后继续。";
  const rec = event as {
    type?: string;
    request?: {
      title?: string;
      question?: string;
      toolName?: string;
      reason?: string;
    };
  };
  const request = rec.request;
  if (rec.type === "approval_request") {
    return [
      "需要授权",
      request?.toolName,
      typeof request?.reason === "string" ? request.reason : "",
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 240);
  }
  if (rec.type === "clarification_request") {
    return (request?.title || request?.question || "需要你确认下一步").slice(0, 240);
  }
  return "等待你确认后继续。";
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const rec = part as { type?: string; text?: string };
      if (rec.type === "text") return rec.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseTaskReport(text: string): {
  hasFindings: boolean;
  title: string;
  body: string;
  summary: string;
  severity: "info" | "warning" | "critical";
} {
  const trimmed = text.trim();
  if (!trimmed || /\bNO_FINDINGS\b/i.test(trimmed)) {
    return {
      hasFindings: false,
      title: "没有需要处理的新事项",
      body: trimmed,
      summary: "本次运行没有发现需要你处理的新事项。",
      severity: "info",
    };
  }
  const severity = /\bCRITICAL\b|严重|阻塞|高风险/i.test(trimmed)
    ? "critical"
    : /\bWARNING\b|警告|风险|失败/i.test(trimmed)
      ? "warning"
      : "info";
  const firstLine =
    trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "任务运行报告";
  return {
    hasFindings: true,
    title: firstLine.slice(0, 120),
    body: trimmed,
    summary: firstLine.slice(0, 240),
    severity,
  };
}

function buildLongTaskPrompt(task: LongTaskDefinition): string {
  return [
    "你正在以 Diga 长期任务模式运行。请把自己当成一个会长期替用户盯事、跑事、汇报事、等待用户决策的工作系统。",
    "",
    `任务名称：${task.title}`,
    `项目路径：${task.projectPath}`,
    `运行频率：${task.cadence}`,
    "",
    "任务目标：",
    task.prompt,
    "",
    "权限策略：",
    `- 写入或修改代码前需要确认：${task.permissionPolicy.requireApprovalBeforeWrite ? "是" : "否"}`,
    `- 访问外部网络前需要确认：${task.permissionPolicy.requireApprovalBeforeNetwork ? "是" : "否"}`,
    `- 单次运行建议最长 ${task.permissionPolicy.maxDurationMinutes} 分钟`,
    "",
    "执行要求：",
    "- 先判断是否有值得用户处理的新事项，不要为了汇报而制造噪音。",
    "- 如果需要修改代码、运行高风险命令、访问敏感网络或需要用户决策，请通过已有审批/追问能力暂停等待。",
    "- 如果发现明确事项，请在最终回复里给出标题、证据、影响、建议动作和风险等级。",
    "- 如果没有发现需要处理的新事项，请在最终回复中包含 NO_FINDINGS，并简要说明检查范围。",
    "- 请保持 update_progress 最新，让用户能看到当前阶段、证据和产物。",
  ].join("\n");
}
