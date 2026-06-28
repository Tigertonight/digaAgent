import type { AgentTeamRunStatus, AgentTeamSettings } from "./types";

/**
 * Agent Team HTTP route 的纯函数辅助集合。
 *
 * 从 app/api/agent/[id]/teams/route.ts 下沉而来：这些函数无状态、不依赖
 * AgentRecord / agent-registry / session，可独立单测。route 文件因此变薄，
 * 且这些（尤其 mergeSettings 的策略推导）关键逻辑获得直接测试覆盖。
 */

/** 压缩空白并截断为预览字符串。 */
export function teamObjectivePreview(objective: string): string {
  return objective.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** 统一把 unknown 错误转成消息字符串。 */
export function teamErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 assistant message 的 content（string 或 part[]）拍平成纯文本。 */
export function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 从简单“文件是否存在”类目标里提取项目相对路径。 */
export function extractSimpleFileExistenceTarget(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/(?:是否存在|存在吗|确认.*存在|只读确认|check if|whether.*exists?)/i.test(normalized)) {
    return null;
  }
  if (
    /(?:并|同时|以及|且).{0,12}(?:判断|评估|检查|审计|复核|分析)|(?:判断|评估|检查|审计|复核|分析).{0,20}(?:能力|链路|完整|完整度|主要问题|明显问题|是否能|能否|区分|adapter)/i.test(
      normalized
    )
  ) {
    return null;
  }
  const matches = Array.from(
    normalized.matchAll(
      /\b((?:(?:app|lib|src|components|pages|server|scripts|docs|test|tests)\/[A-Za-z0-9._/@+-]+|(?:package|tsconfig|next\.config|vitest\.config|playwright\.config|eslint\.config|postcss\.config|tailwind\.config))\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|yml|yaml|toml|txt))\b/g
    )
  )
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item));
  return matches[0] ?? null;
}

/** 校验并规范化项目相对路径，避免确定性 fallback 读取项目外文件。 */
export function safeProjectRelativePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  return normalized;
}

/** 把团队成员的中文/英文角色名映射到 subagent role。 */
export function teamRoleToSubagentRole(
  role: string
): "general" | "research" | "code-review" {
  if (role.includes("资料") || role.toLowerCase().includes("research")) {
    return "research";
  }
  if (role.includes("挑战") || role.toLowerCase().includes("critic")) {
    return "code-review";
  }
  return "general";
}

/** 校验外部传入的 transition 目标状态，非法返回 null。 */
export function parseTransitionStatus(value: unknown): AgentTeamRunStatus | null {
  if (
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "aborted"
  ) {
    return value;
  }
  return null;
}

/**
 * 把外部传入的 settings 增量合并到 base，并推导 write/network/worktree 策略。
 *
 * 策略推导规则（保持与 route 原实现一致）：
 *  - writePolicy：!allowWrite → read_only；否则取显式非 read_only 值，
 *    再否则 requirePlanApproval → plan_approval，否则 write_allowed。
 *  - networkPolicy：!allowNetwork → disabled；否则取显式非 disabled 值，
 *    否则 lead_only。
 *  - worktreePolicy：!allowWorktree → none；否则取显式非 none 值，否则 per_member。
 */
export function mergeAgentTeamSettings(
  base: AgentTeamSettings,
  raw: unknown
): AgentTeamSettings {
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<AgentTeamSettings>;
  const allowNetwork =
    typeof input.allowNetwork === "boolean" ? input.allowNetwork : base.allowNetwork;
  const allowWrite =
    typeof input.allowWrite === "boolean" ? input.allowWrite : base.allowWrite;
  const allowWorktree =
    typeof input.allowWorktree === "boolean" ? input.allowWorktree : base.allowWorktree;
  const requirePlanApproval =
    typeof input.requirePlanApproval === "boolean"
      ? input.requirePlanApproval
      : base.requirePlanApproval;
  const requestedWritePolicy =
    input.writePolicy === "read_only" ||
    input.writePolicy === "plan_approval" ||
    input.writePolicy === "write_allowed"
      ? input.writePolicy
      : undefined;
  const requestedNetworkPolicy =
    input.networkPolicy === "disabled" ||
    input.networkPolicy === "lead_only" ||
    input.networkPolicy === "teammates_allowed"
      ? input.networkPolicy
      : undefined;
  const requestedWorktreePolicy =
    input.worktreePolicy === "none" ||
    input.worktreePolicy === "per_member" ||
    input.worktreePolicy === "per_task"
      ? input.worktreePolicy
      : undefined;
  return {
    ...base,
    mode:
      input.mode === "collaboration" || input.mode === "audit"
        ? input.mode
        : base.mode ?? "collaboration",
    memberScale:
      input.memberScale === "small" ||
      input.memberScale === "standard" ||
      input.memberScale === "deep"
        ? input.memberScale
        : base.memberScale,
    allowNetwork,
    allowWrite,
    allowWorktree,
    allowChallenges:
      typeof input.allowChallenges === "boolean"
        ? input.allowChallenges
        : base.allowChallenges,
    requirePlanApproval,
    displayMode:
      input.displayMode === "workspace" ||
      input.displayMode === "in_process" ||
      input.displayMode === "split_panes"
        ? input.displayMode
        : base.displayMode,
    stopConditions: {
      ...base.stopConditions,
      ...(input.stopConditions && typeof input.stopConditions === "object"
        ? input.stopConditions
        : {}),
    },
    writePolicy: !allowWrite
      ? "read_only"
      : requestedWritePolicy && requestedWritePolicy !== "read_only"
        ? requestedWritePolicy
        : requirePlanApproval
          ? "plan_approval"
          : "write_allowed",
    networkPolicy: !allowNetwork
      ? "disabled"
      : requestedNetworkPolicy && requestedNetworkPolicy !== "disabled"
        ? requestedNetworkPolicy
        : "lead_only",
    worktreePolicy: !allowWorktree
      ? "none"
      : requestedWorktreePolicy && requestedWorktreePolicy !== "none"
        ? requestedWorktreePolicy
        : "per_member",
    resultIngestionMode:
      input.resultIngestionMode === "structured" ||
      input.resultIngestionMode === "transcript_summary"
        ? input.resultIngestionMode
        : base.resultIngestionMode,
  };
}
