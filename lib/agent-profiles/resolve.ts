import type { WorkMode } from "@/lib/communication/settings";
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  canonicalProfileId,
  getBuiltInProfile,
} from "./built-in";
import type {
  AgentProfile,
  AgentProfilesSettings,
  CommunicationMode,
  ProfileAxes,
} from "./types";

/**
 * Agent Profiles 解析层（Phase A）。
 *
 * 职责：在 profile（顶层打包）与既有正交轴（communication 等）之间做映射，
 * 让 communication 成为 profile 的一条轴，而不是另起一套并行真值源（不双轨）。
 *
 * Phase A 不改运行时注入点：withCommunicationInstructions 仍消费 WorkMode，
 * 这里只提供「profile -> WorkMode」「WorkMode -> communication 轴」的纯映射，
 * 供后续 Phase 接线时使用。
 */

/** communication 轴与现有 WorkMode 是同一组取值，直接互转。 */
export function communicationToWorkMode(mode: CommunicationMode): WorkMode {
  return mode === "daily" ? "daily" : "coding";
}

export function workModeToCommunication(mode: WorkMode): CommunicationMode {
  return mode === "daily" ? "daily" : "coding";
}

/** 解析出某 profile 的 WorkMode（供 communication 注入点使用）。 */
export function profileWorkMode(profile: AgentProfile): WorkMode {
  return communicationToWorkMode(profile.defaults.communication);
}

/** 规范化全局 agentProfiles 设置；缺省时回退到内置默认。 */
export function normalizeAgentProfilesSettings(
  input: Partial<AgentProfilesSettings> | undefined
): AgentProfilesSettings {
  const customProfiles = Array.isArray(input?.customProfiles)
    ? input!.customProfiles.filter(isValidCustomProfile)
    : [];
  const requestedId = canonicalProfileId(input?.defaultProfileId);
  const known =
    (requestedId && getBuiltInProfile(requestedId)) ||
    customProfiles.find((p) => p.id === requestedId);
  return {
    defaultProfileId: known ? requestedId! : DEFAULT_PROFILE_ID,
    customProfiles,
  };
}

/**
 * 按 id 解析 profile：先内置，再自定义；都没有则回退默认内置 profile。
 * 永远返回一个可用 profile（不会是 undefined）。
 */
export function resolveProfile(
  id: string | undefined,
  settings?: AgentProfilesSettings
): AgentProfile {
  const canonicalId = canonicalProfileId(id);
  if (canonicalId) {
    const builtIn = getBuiltInProfile(canonicalId);
    if (builtIn) return builtIn;
    const custom = settings?.customProfiles.find((p) => p.id === canonicalId);
    if (custom) return custom;
  }
  return (
    getBuiltInProfile(DEFAULT_PROFILE_ID) ?? BUILT_IN_PROFILES[0]
  );
}

/** 取一个 profile 的轴快照（用于持久化每条 turn 当时生效的配置）。 */
export function profileAxesSnapshot(profile: AgentProfile): ProfileAxes {
  return {
    ...profile.defaults,
    toolsets: [...profile.defaults.toolsets],
  };
}

function isValidCustomProfile(value: unknown): value is AgentProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<AgentProfile>;
  return (
    typeof p.id === "string" &&
    typeof p.label === "string" &&
    !!p.defaults &&
    typeof p.defaults === "object"
  );
}
