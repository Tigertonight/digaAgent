import type { AgentProfile } from "./types";

/**
 * 内置 agent profiles。
 *
 * 产品面只保留两种用户能稳定理解的工作形态：
 * - daily: 日常问答 / 研究整理，低风险、只读、偏紧凑展示。
 * - coding: 代码协作 / 修改验证，工作区可写、高推理、完整展示。
 *
 * 更细的 quick-chat / code-review / code-edit / yolo 等历史预设不再作为
 * built-in 展示；resolve 层会把旧 id 迁移到这两个 canonical id。
 */
export const BUILT_IN_PROFILES: readonly AgentProfile[] = [
  {
    id: "daily",
    label: "Daily",
    description: "日常问答、检索、整理和归纳；默认只读、低风险。",
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
    id: "coding",
    label: "Coding",
    description: "代码阅读、修改、工作流编排和验证；默认需要按需审批。",
    risk: "medium",
    builtIn: true,
    defaults: {
      communication: "coding",
      approval: "on-request",
      sandbox: "workspace-write",
      reasoning: "high",
      display: "full",
      toolsets: ["code-read", "code-write", "workflow", "browser"],
    },
  },
] as const;

/**
 * 默认 profile：保持现状 communication=coding，避免静默把存量用户切到 daily。
 */
export const DEFAULT_PROFILE_ID = "coding";

export const LEGACY_PROFILE_ALIASES: Readonly<Record<string, string>> = {
  "quick-chat": "daily",
  "daily-research": "daily",
  "workflow-planner": "daily",
  "code-review": "coding",
  "code-edit": "coding",
  "yolo-refactor": "coding",
};

export function canonicalProfileId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return LEGACY_PROFILE_ALIASES[id] ?? id;
}

export function getBuiltInProfile(id: string): AgentProfile | undefined {
  const canonical = canonicalProfileId(id);
  return BUILT_IN_PROFILES.find((p) => p.id === canonical);
}
