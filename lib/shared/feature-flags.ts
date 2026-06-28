import "server-only";

/**
 * 功能开关集中配置。
 *
 * 运行环境是 Electron 桌面单进程应用，没有远端配置中心，因此用环境变量作为
 * 开关载体即可满足「实验性功能可一键降级」的诉求。
 *
 * 约定：值为 "0" / "false" / "off"（大小写不敏感）视为关闭；其余（含未设置）
 * 取各 flag 的默认值。
 */
function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") {
    return false;
  }
  if (normalized === "1" || normalized === "true" || normalized === "on") {
    return true;
  }
  return defaultValue;
}

export const FEATURE_FLAGS = {
  /**
   * Agent Team（多成员协作）。功能已真实接入，但仍在密集迭代，保留开关以便
   * 不稳定时快速降级（关闭后仅禁止新建 team，既有 team 仍可只读查看）。
   */
  agentTeamEnabled: (): boolean =>
    envBool("DIGA_AGENT_ENABLE_AGENT_TEAM", true),
} as const;
