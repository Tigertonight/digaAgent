import type { AgentProfile } from "./types";

/**
 * 内置 agent profiles（Phase A：仅数据，不接线到运行时）。
 *
 * 轴取值对照 docs/plans/agent-profiles.md §5 的表；reasoning 使用 ThinkingLevel
 * 取值（minimal/low/medium/high）。这些 profile 都标 builtIn=true，不可直接编辑。
 */
export const BUILT_IN_PROFILES: readonly AgentProfile[] = [
  {
    id: "quick-chat",
    label: "Quick Chat",
    description: "快速问答，不主动改环境。",
    risk: "low",
    builtIn: true,
    defaults: {
      communication: "daily",
      approval: "always-ask",
      sandbox: "read-only",
      reasoning: "low",
      display: "compact",
      toolsets: ["chat"],
    },
  },
  {
    id: "daily-research",
    label: "Daily Research",
    description: "检索、整理、归纳，过程可展开。",
    risk: "low",
    builtIn: true,
    defaults: {
      communication: "daily",
      approval: "on-request",
      sandbox: "read-only",
      reasoning: "medium",
      display: "grouped",
      toolsets: ["chat", "research", "browser"],
    },
  },
  {
    id: "code-review",
    label: "Code Review",
    description: "读代码、找风险、给建议。",
    risk: "low",
    builtIn: true,
    defaults: {
      communication: "coding",
      approval: "always-ask",
      sandbox: "read-only",
      reasoning: "high",
      display: "full",
      toolsets: ["code-read", "research"],
    },
  },
  {
    id: "code-edit",
    label: "Code Edit",
    description: "可修改工作区并验证。",
    risk: "medium",
    builtIn: true,
    defaults: {
      communication: "coding",
      approval: "on-request",
      sandbox: "workspace-write",
      reasoning: "high",
      display: "full",
      toolsets: ["code-read", "code-write", "workflow"],
    },
  },
  {
    id: "workflow-planner",
    label: "Workflow Planner",
    description: "拆任务、生成计划、少执行。",
    risk: "low",
    builtIn: true,
    defaults: {
      communication: "daily",
      approval: "always-ask",
      sandbox: "read-only",
      reasoning: "high",
      display: "grouped",
      toolsets: ["chat", "research", "workflow"],
    },
  },
  {
    id: "yolo-refactor",
    label: "Yolo Refactor",
    description: "在可回滚环境中自动推进（高风险）。",
    risk: "high",
    builtIn: true,
    defaults: {
      communication: "coding",
      approval: "never",
      sandbox: "workspace-write",
      reasoning: "high",
      display: "full",
      toolsets: ["code-read", "code-write", "workflow", "browser"],
    },
  },
] as const;

/**
 * 默认 profile：保持现状 communication=coding，read-only，零行为变更（见文档 §5.1）。
 * 引入 profile 抽象但不静默把存量用户切到 daily。
 */
export const DEFAULT_PROFILE_ID = "code-review";

export function getBuiltInProfile(id: string): AgentProfile | undefined {
  return BUILT_IN_PROFILES.find((p) => p.id === id);
}
