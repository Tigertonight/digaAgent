import type {
  AgentTeamBlockReason,
  AgentTeamBlockReasonCode,
  AgentTeamRecoveryAttempt,
  AgentTeamRun,
} from "./types";

function includesAny(value: string, needles: string[]): boolean {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

export type AgentTeamProviderFailureKind =
  | "temporary_stream_error"
  | "auth_or_config_error"
  | "schema_error"
  | "unknown_provider_error";

export function classifyAgentTeamProviderFailure(text: string): AgentTeamProviderFailureKind {
  if (includesAny(text, [
    "input_schema",
    "schema",
    "tool schema",
    "tools.",
    "Field required",
    "字段",
    "工具参数",
  ])) {
    return "schema_error";
  }
  if (includesAny(text, [
    "No API key",
    "API key",
    "OAuth token",
    "unauthorized",
    "authentication",
    "forbidden",
    "invalid api key",
    "鉴权",
    "密钥",
    "未授权",
    "模型不存在",
    "model not found",
  ])) {
    return "auth_or_config_error";
  }
  if (includesAny(text, [
    "finish_reason",
    "stream ended",
    "529",
    "overloaded",
    "temporarily unavailable",
    "rate limit",
    "负载",
    "稍后重试",
    "服务集群",
    "模型连接提前结束",
    "连接提前结束",
    "断流",
  ])) {
    return "temporary_stream_error";
  }
  return "unknown_provider_error";
}

export function isRecoverableAgentTeamProviderFailure(text: string): boolean {
  const kind = classifyAgentTeamProviderFailure(text);
  return kind === "temporary_stream_error" || kind === "unknown_provider_error";
}

export function classifyAgentTeamBlockReason(text: string): AgentTeamBlockReasonCode {
  if (includesAny(text, [
    "finish_reason",
    "stream ended",
    "provider",
    "input_schema",
    "tool schema",
    "tools.",
    "No API key",
    "API key",
    "OAuth token",
    "unauthorized",
    "authentication",
    "529",
    "负载",
    "稍后重试",
    "服务集群",
    "鉴权",
    "密钥",
    "模型连接提前结束",
  ])) {
    return "provider_stream_error";
  }
  if (includesAny(text, ["timed out", "timeout", "超时", "超过"])) {
    return "member_timeout";
  }
  if (includesAny(text, ["session is not available", "session 丢失", "teammate session is not available", "member missing", "会话丢失"])) {
    return "member_unavailable";
  }
  if (includesAny(text, ["invalid TEAM_RESULT_JSON", "could not be parsed", "json"])) {
    return "invalid_result_json";
  }
  if (includesAny(text, ["placeholder", "copied template", "占位"])) {
    return "placeholder_result";
  }
  if (includesAny(text, ["no structured findings", "missing TEAM_RESULT_JSON", "without findings", "没有结构化", "成员结果待整理", "没有提取到可采纳发现"])) {
    return "missing_structured_result";
  }
  if (includesAny(text, ["no evidence", "evidence"])) {
    return "missing_evidence";
  }
  if (includesAny(text, ["Waiting for dependencies", "dependencies", "前置"])) {
    return "task_dependency_waiting";
  }
  if (includesAny(text, ["worktree"])) {
    return "worktree_pending";
  }
  return "quality_gate_failed";
}

function reasonCopy(code: AgentTeamBlockReasonCode): Omit<AgentTeamBlockReason, "code" | "entityRefs"> {
  switch (code) {
    case "missing_structured_result":
      return {
        severity: "blocking",
        message: "成员回复还没有整理成团队可采纳发现。",
        recommendedAction: "先自动整理成员回复；仍失败时再重派或人工补充发现。",
        autoActions: ["recover_team", "retry_task"],
        manualActions: ["manual_submit_finding", "skip_task_with_reason", "finalize_with_risks"],
      };
    case "invalid_result_json":
      return {
        severity: "blocking",
        message: "成员提交的结构化结果格式不完整或无法解析。",
        recommendedAction: "先让系统整理成员回复；仍失败时再重派任务或人工补充发现。",
        autoActions: ["repair_result", "recover_team"],
        manualActions: ["retry_task", "manual_submit_finding"],
      };
    case "missing_findings":
      return {
        severity: "blocking",
        message: "结果里没有可采纳的发现。",
        recommendedAction: "先自动整理成员回复；仍失败时人工补充一条发现，或带风险总结。",
        autoActions: ["recover_team"],
        manualActions: ["manual_submit_finding", "skip_task_with_reason"],
      };
    case "missing_evidence":
      return {
        severity: "warning",
        message: "发现缺少证据引用。",
        recommendedAction: "协作模式可带 warning 总结；严格审计模式需要补证据。",
        autoActions: ["recover_team"],
        manualActions: ["manual_submit_finding", "finalize_with_risks"],
      };
    case "placeholder_result":
      return {
        severity: "blocking",
        message: "成员像是复制了模板占位内容，没有给出真实结论。",
        recommendedAction: "换人或重派任务，不要采纳占位结果。",
        autoActions: ["recover_team"],
        manualActions: ["replace_member", "retry_task"],
      };
    case "member_unavailable":
      return {
        severity: "blocking",
        message: "成员会话不可用或已丢失。",
        recommendedAction: "替换成员后重派任务。",
        autoActions: ["recover_team"],
        manualActions: ["replace_member", "retry_task"],
      };
    case "member_timeout":
      return {
        severity: "blocking",
        message: "成员执行超时，没有及时返回结果。",
        recommendedAction: "自动收回任务并重派，或换人处理。",
        autoActions: ["recover_team"],
        manualActions: ["retry_task", "replace_member", "finalize_with_risks"],
      };
    case "task_dependency_waiting":
      return {
        severity: "warning",
        message: "任务正在等待前置事项完成。",
        recommendedAction: "继续推进前置任务；如果前置长期失败，可跳过并总结。",
        autoActions: ["recover_team", "run_until_idle"],
        manualActions: ["skip_task_with_reason"],
      };
    case "open_challenge":
      return {
        severity: "blocking",
        message: "还有未解决的分歧或反证。",
        recommendedAction: "解决/关闭分歧，或带风险总结。",
        autoActions: ["recover_team"],
        manualActions: ["resolve_challenge", "dismiss_challenge", "finalize_with_risks"],
      };
    case "worktree_pending":
      return {
        severity: "blocking",
        message: "还有成员独立改动区没有合并、保留或丢弃。",
        recommendedAction: "处理 worktree 后再总结。",
        autoActions: [],
        manualActions: ["merge_worktree"],
      };
    case "provider_stream_error":
      return {
        severity: "blocking",
        message: "成员模型调用失败，可能是供应商断流、鉴权失败或模型配置不可用。",
        recommendedAction: "先检查当前模型/供应商配置；确认可用后再重试任务，或换一个可用模型。",
        autoActions: ["recover_team"],
        manualActions: ["retry_task", "replace_member"],
      };
    case "quality_gate_failed":
    default:
      return {
        severity: "blocking",
        message: "最终总结门禁还没有通过。",
        recommendedAction: "处理未完成事项，或在协作模式下带风险总结。",
        autoActions: ["run_until_idle"],
        manualActions: ["finalize_with_risks", "summarize_available"],
      };
  }
}

function makeReason(
  code: AgentTeamBlockReasonCode,
  entityRefs: AgentTeamBlockReason["entityRefs"],
  overrides: Partial<Omit<AgentTeamBlockReason, "code" | "entityRefs">> = {}
): AgentTeamBlockReason {
  return {
    code,
    entityRefs,
    ...reasonCopy(code),
    ...overrides,
  };
}

function uniqueReasons(reasons: AgentTeamBlockReason[]): AgentTeamBlockReason[] {
  const providerErrorTaskIds = new Set(
    reasons
      .filter((reason) => reason.code === "provider_stream_error" && reason.entityRefs.taskId)
      .map((reason) => reason.entityRefs.taskId!)
  );
  const seen = new Set<string>();
  const seenMemberCodes = new Set<string>();
  return reasons.filter((reason) => {
    if (
      reason.entityRefs.taskId &&
      providerErrorTaskIds.has(reason.entityRefs.taskId) &&
      (reason.code === "missing_findings" || reason.code === "missing_structured_result")
    ) {
      return false;
    }
    const memberKey = reason.entityRefs.memberId
      ? `${reason.code}:member:${reason.entityRefs.memberId}`
      : "";
    if (!reason.entityRefs.taskId && memberKey && seenMemberCodes.has(memberKey)) {
      return false;
    }
    const key = reason.entityRefs.taskId
      ? `${reason.code}:task:${reason.entityRefs.taskId}`
      : `${reason.code}:${reason.entityRefs.memberId ?? ""}:${reason.entityRefs.resultId ?? ""}:${reason.entityRefs.challengeId ?? ""}:${reason.entityRefs.gateId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (memberKey) seenMemberCodes.add(memberKey);
    return true;
  });
}

function providerFailureReasonOverrides(text: string): Partial<Omit<AgentTeamBlockReason, "code" | "entityRefs">> {
  const kind = classifyAgentTeamProviderFailure(text);
  if (kind === "temporary_stream_error") {
    return {
      message: "成员模型临时中断，没有完整返回。",
      recommendedAction: "系统会先自动重试；如果连续失败，再换成员或带风险总结。",
      autoActions: ["recover_team"],
      manualActions: ["retry_task", "replace_member", "finalize_with_risks"],
    };
  }
  if (kind === "auth_or_config_error") {
    return {
      message: "成员模型调用失败：模型配置或鉴权不可用。",
      recommendedAction: "请切换到可用模型/供应商，或修复密钥配置后再重试。",
      autoActions: [],
      manualActions: ["retry_task", "replace_member"],
    };
  }
  if (kind === "schema_error") {
    return {
      message: "成员模型调用失败：当前供应商不接受这次工具参数格式。",
      recommendedAction: "需要修复工具 schema 兼容性，或切换到支持当前工具格式的模型。",
      autoActions: [],
      manualActions: ["retry_task", "replace_member"],
    };
  }
  return {};
}

export function diagnoseAgentTeamRun(run: AgentTeamRun): AgentTeamBlockReason[] {
  if (run.status === "completed" || run.status === "aborted") {
    return [];
  }
  const reasons: AgentTeamBlockReason[] = [];
  for (const result of run.board.results ?? []) {
    if (result.status !== "needs_review") continue;
    const warningText = result.parseWarnings.join("; ");
    const warningCode = classifyAgentTeamBlockReason(warningText);
    const code =
      warningCode !== "quality_gate_failed"
        ? warningCode
        : result.findingIds.length === 0
          ? "missing_findings"
          : warningCode;
    reasons.push(makeReason(code, {
      taskId: result.taskId,
      memberId: result.authorAgentId,
      resultId: result.id,
    }, code === "provider_stream_error" ? providerFailureReasonOverrides(warningText) : {}));
  }
  for (const task of run.board.tasks) {
    if (task.status !== "blocked") continue;
    const latestAttemptReason = task.attempts?.at(-1)?.reasonCode;
    const taskErrorText = task.blocker || task.lastError || task.attempts?.at(-1)?.error || "";
    const code = latestAttemptReason ?? classifyAgentTeamBlockReason(taskErrorText);
    reasons.push(makeReason(code, {
      taskId: task.id,
      memberId: task.ownerAgentId,
      resultId: task.resultId,
    }, code === "provider_stream_error" ? providerFailureReasonOverrides(taskErrorText) : {}));
  }
  for (const member of run.members) {
    if (member.status !== "blocked") continue;
    const memberText = member.latestOutput || "";
    const code = classifyAgentTeamBlockReason(memberText);
    reasons.push(makeReason(code, {
      memberId: member.id,
      taskId: member.currentTaskId,
    }, code === "provider_stream_error" ? providerFailureReasonOverrides(memberText) : {}));
  }
  for (const challenge of run.board.challenges) {
    if (challenge.status !== "open" && challenge.status !== "needs_evidence") continue;
    reasons.push(makeReason("open_challenge", {
      challengeId: challenge.id,
      resultId: challenge.sourceResultId,
    }));
  }
  for (const member of run.members) {
    if (member.worktree?.status === "active" || member.worktree?.status === "merge_pending") {
      reasons.push(makeReason("worktree_pending", { memberId: member.id }));
    }
  }
  for (const gate of run.board.qualityGates) {
    if (gate.status !== "failed") continue;
    if (run.status === "running") {
      continue;
    }
    const code = gate.id === "gate-open-challenges"
      ? "open_challenge"
      : gate.id === "gate-worktrees-merged"
        ? "worktree_pending"
        : "quality_gate_failed";
    reasons.push(makeReason(code, { gateId: gate.id }));
  }
  return uniqueReasons(reasons);
}

export function recommendedAgentTeamActions(reasons: AgentTeamBlockReason[]): string[] {
  return Array.from(new Set(reasons.flatMap((reason) => [
    ...reason.autoActions,
    ...reason.manualActions,
  ])));
}

export function attachAgentTeamDiagnostics(run: AgentTeamRun): AgentTeamRun {
  const blockReasons = diagnoseAgentTeamRun(run);
  return {
    ...run,
    blockReasons,
  };
}

export function createRecoveryAttempt(input: {
  run: AgentTeamRun;
  reasonCode: AgentTeamBlockReasonCode;
  action: string;
  status: AgentTeamRecoveryAttempt["status"];
  taskId?: string;
  memberId?: string;
  resultId?: string;
  error?: string;
  now?: number;
}): AgentTeamRecoveryAttempt {
  const now = input.now ?? Date.now();
  return {
    id: `${input.run.id}:recovery:${now}:${Math.random().toString(36).slice(2, 8)}`,
    reasonCode: input.reasonCode,
    action: input.action,
    status: input.status,
    startedAt: now,
    endedAt: now,
    taskId: input.taskId,
    memberId: input.memberId,
    resultId: input.resultId,
    error: input.error,
  };
}
