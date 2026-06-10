"use client";

/**
 * useApprovals —— 工具审批的用户操作入口（RFC-2 Phase B3）。
 *
 * 职责：
 *   - 提供 approve(toolCallId) / deny(toolCallId, denyReason?) 两个 action
 *   - POST 到 /api/agent/[id]/approval
 *   - **不做乐观更新**——server 端在 onApprovalNeeded 的 await resolve 后会推
 *     approval_resolved SSE 事件，前端 chat-reducer 会自然把 part.status 改成 allowed/denied
 *   - POST 失败时记错（外层 setError 注入）
 *
 * 设计选择：不乐观更新的理由是
 *   1. 避免"乐观状态"与"server 真实结算"双源真实导致不一致（比如同时超时 + 用户点了）
 *   2. SSE 回声极快（本地），延迟用户感知不到
 *   3. 节省一个"如果 POST 失败要回滚"的复杂分支
 *
 * 不在本 hook 内的职责：
 *   - 渲染气泡 → ApprovalBubble
 *   - 把 part 塞进 chat → chat-reducer + useAgentEvents
 *   - 修改 agent state → server-side agent-registry.onApprovalNeeded
 */

import { useCallback } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "@/lib/collab/types";
import { userFacingMessage } from "@/lib/user-facing-error";

export interface UseApprovalsOptions {
  /** 当前活跃 agent id；null 时 action 退化为 no-op（不应该被触发） */
  agentId: string | null;
  /** POST 失败时报错（通常接 setError） */
  onError?: (msg: string) => void;
}

/** B4：approve 的可选项——传 remember 让 server 把 (agentId, ruleId) 加入 session 记忆。 */
export interface ApproveOptions {
  /** "this-session" = 本 session 内同 ruleId 不再问；undefined = 只这次 */
  remember?: "this-session";
  /** 触发审批的 ruleId（remember 必须配合 ruleId 才生效）。 */
  ruleId?: string;
}

export interface UseApprovalsReturn {
  approve: (toolCallId: string, opts?: ApproveOptions) => Promise<void>;
  deny: (toolCallId: string, denyReason?: string) => Promise<void>;
  loadPending: () => Promise<ApprovalRequest[]>;
}

interface PostDecisionBody {
  toolCallId: string;
  decision: ApprovalDecision;
  denyReason?: string;
  remember?: "this-session";
  ruleId?: string;
}

async function postDecision(
  agentId: string,
  body: PostDecisionBody,
  onError: ((m: string) => void) | undefined
): Promise<void> {
  try {
    const r = await fetch(`/api/agent/${agentId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      onError?.(userFacingMessage(text || `HTTP ${r.status}`));
    }
  } catch (e) {
    onError?.(userFacingMessage(e));
  }
}

export function useApprovals(opts: UseApprovalsOptions): UseApprovalsReturn {
  const { agentId, onError } = opts;

  const loadPending = useCallback<UseApprovalsReturn["loadPending"]>(
    async () => {
      if (!agentId) return [];
      try {
        const r = await fetch(`/api/agent/${agentId}/approval`);
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          onError?.(userFacingMessage(text || `HTTP ${r.status}`));
          return [];
        }
        const d = (await r.json()) as { approvals?: ApprovalRequest[] };
        return Array.isArray(d.approvals) ? d.approvals : [];
      } catch (e) {
        onError?.(userFacingMessage(e));
        return [];
      }
    },
    [agentId, onError]
  );

  const approve = useCallback<UseApprovalsReturn["approve"]>(
    async (toolCallId, approveOpts) => {
      if (!agentId) return;
      await postDecision(
        agentId,
        {
          toolCallId,
          decision: "allow",
          remember: approveOpts?.remember,
          ruleId: approveOpts?.ruleId,
        },
        onError
      );
    },
    [agentId, onError]
  );

  const deny = useCallback<UseApprovalsReturn["deny"]>(
    async (toolCallId, denyReason) => {
      if (!agentId) return;
      await postDecision(
        agentId,
        { toolCallId, decision: "deny", denyReason },
        onError
      );
    },
    [agentId, onError]
  );

  return { approve, deny, loadPending };
}
