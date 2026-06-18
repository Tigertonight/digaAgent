import type { ThinkingLevel } from "@/lib/types";

/**
 * Agent Profiles —— 类型定义（Phase A）。
 *
 * 设计原则（见 docs/plans/agent-profiles.md）：底层正交轴，顶层 profile 打包。
 * Phase A 只定义类型 + 内置 profile 数据，不改变任何运行时行为。
 *
 * 关键现实约束（见文档 §0.1）：
 *   - reasoning 轴复用现有 ThinkingLevel，不新造枚举。
 *   - 默认 profile 的 communication 必须保持现状 "coding"，避免静默改变行为。
 *   - sandbox 在 Phase E 前是软边界（toolset + approval 模拟）。
 */

/** 协作风格 / 身份。映射现有 lib/communication 的 WorkMode。 */
export type CommunicationMode = "daily" | "coding";

/** 工具调用前是否需要用户确认。 */
export type ApprovalMode = "always-ask" | "on-request" | "on-failure" | "never";

/**
 * 文件系统 / 命令权限边界。
 * 注意：Phase E 前无系统级沙盒，read-only/workspace-write 的真实区别体现在
 * 「是否暴露 write/execute 工具 + 审批」，不是真沙盒。
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** 推理预算。复用 ThinkingLevel，避免与现有 per-provider 抽象双轨。 */
export type ReasoningLevel = ThinkingLevel;

/** 工具过程的展示密度。 */
export type DisplayDensity = "full" | "grouped" | "compact";

/** 可用工具族。 */
export type ToolsetProfile =
  | "chat"
  | "research"
  | "code-read"
  | "code-write"
  | "workflow"
  | "browser";

/** 一个 profile 的轴组合（运行时实际消费的形态）。 */
export interface ProfileAxes {
  communication: CommunicationMode;
  approval: ApprovalMode;
  sandbox: SandboxMode;
  reasoning: ReasoningLevel;
  display: DisplayDensity;
  toolsets: ToolsetProfile[];
}

export type ProfileRisk = "low" | "medium" | "high";

export interface AgentProfile {
  id: string;
  label: string;
  description: string;
  defaults: ProfileAxes;
  risk: ProfileRisk;
  /** 内置 profile 不可直接编辑，只能复制为自定义。 */
  builtIn: boolean;
}

/** 持久化在 session meta 上的 profile 快照（每条 turn 记录当时生效的轴）。 */
export interface SessionProfileSnapshot {
  id: string;
  axes: ProfileAxes;
}

/** 持久化在全局 settings.json 的 agentProfiles 字段。 */
export interface AgentProfilesSettings {
  defaultProfileId: string;
  customProfiles: AgentProfile[];
}
