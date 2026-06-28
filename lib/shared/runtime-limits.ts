import "server-only";

/**
 * 三个执行模块（subagents / workflows / agent-team）的超时与并发上限集中配置。
 *
 * 此前这些常量散落在各模块内部、语义不一致（subagent 30min、workflow 24h、
 * team 30min+env），且 subagent 的 timeout sanitize 是死代码（忽略入参恒返回
 * 默认值）。集中到这里统一治理，并通过环境变量允许部署期覆盖。
 *
 * 单位统一为毫秒。所有 getter 形式的项支持 env 覆盖；纯数值项是硬约束。
 */
function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RUNTIME_LIMITS = {
  /** 单个 subagent 任务的超时上限（也是默认值）。可被 env 覆盖。 */
  subagentTaskTimeoutMs: (): number =>
    envMs("DIGA_AGENT_SUBAGENT_TIMEOUT_MS", 30 * MINUTE),
  /** subagent 批处理的默认/最大并发。 */
  subagentMaxConcurrency: 4,
  /** subagent 默认最大轮数。 */
  subagentDefaultMaxTurns: 6,

  /** workflow 脚本默认超时。可被 env 覆盖。 */
  workflowDefaultTimeoutMs: (): number =>
    envMs("DIGA_AGENT_WORKFLOW_TIMEOUT_MS", 24 * HOUR),
  /** workflow 脚本超时硬上限（clamp 用，不可被 env 突破）。 */
  workflowMaxTimeoutMs: 24 * HOUR,

  /** agent-team 单次 dispatch（一个成员 prompt）的超时。可被 env 覆盖。 */
  teamDispatchTimeoutMs: (): number =>
    envMs("DIGA_AGENT_TEAM_DISPATCH_TIMEOUT_MS", 30 * MINUTE),
} as const;
