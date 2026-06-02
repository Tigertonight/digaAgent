/**
 * CollabExtension 工厂。
 *
 * 注入到 SDK 的 DefaultResourceLoader.extensionFactories 里，每次 tool_call 都过一遍：
 * 1. 用 matcher 匹配预置规则
 * 2. 命中 auto-allow 或没匹配 → 放行（return void）
 * 3. 命中 auto-deny → block + reason
 * 4. 命中 ask → 调 onApprovalNeeded（Phase B2 是 stub auto-allow + console.log，
 *    Phase B3 替换为真挂前端通道）；按响应决定 allow/deny
 *
 * R6 兜底（来自 RFC-2 §5）：handler 内任何异常都 catch → 默认放行，不阻塞 agent。
 * 安全 vs 可用性的取舍是「extension 自身炸了不能让 agent 卡死」。
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { matchRule } from "./matcher";
import type { ApprovalRequest, ApprovalResponse, ApprovalRule } from "./types";

export interface CollabExtensionOptions {
  /** 每次 tool_call 都重新读规则——支持运行时改规则配置不重启 session。 */
  getRules: () => ApprovalRule[];
  /** 命中 ask 规则时调用；返回用户的决策。 */
  onApprovalNeeded: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  /** 当前 agentId（用于 approval id 复合 key，区分多 session 并发）。 */
  getAgentId: () => string;
  /**
   * B4：查询某 ruleId 是否已在本 session "不再问"集合中。
   * 命中 ask 规则时若返回 true → 直接放行（不调 onApprovalNeeded、不弹气泡）。
   * undefined / false → 走原 ask 流程。
   *
   * 可选参数：B1/B2 没有此能力，老调用方不传也能跑（视为永不命中）。
   */
  hasRemember?: (ruleId: string) => boolean;
}

export function createCollabExtension(
  opts: CollabExtensionOptions
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      try {
        const rule = matchRule(event, opts.getRules());

        // 没命中任何规则 / 命中 auto-allow → 放行
        if (!rule || rule.on === "auto-allow") return;

        // 命中 auto-deny → 直接 block
        if (rule.on === "auto-deny") {
          return {
            block: true,
            reason: rule.denyReason ?? "denied by rule",
          };
        }

        // rule.on === "ask"：先查 session remember（B4）。
        // 命中 → 静默放行（前端 chat 流也不会出现气泡——因为不推 approval_request）。
        if (opts.hasRemember && opts.hasRemember(rule.id)) {
          return;
        }

        // 走真审批通道：弹气泡 + await 用户决策（或超时）。
        const req: ApprovalRequest = {
          id: `${opts.getAgentId()}:${event.toolCallId}`,
          agentId: opts.getAgentId(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input as Record<string, unknown>,
          reason: "rule",
          ruleId: rule.id,
          defaultDecision: "deny",
          createdAt: Date.now(),
        };

        const resp = await opts.onApprovalNeeded(req);

        if (resp.decision === "allow") return;
        return {
          block: true,
          reason: resp.denyReason ?? rule.denyReason ?? "denied by user",
        };
      } catch (err) {
        // R6：extension 自己抛错时默认放行，避免卡死 agent。
        // 用 console.error 让 server 日志能看到，便于排查。
        console.error("[collab] extension error, defaulting allow:", err);
        return;
      }
    });
  };
}
