/**
 * /api/agent/[id]/approval
 *
 * 用户对审批气泡 Allow / Deny 决策的提交入口（RFC-2 Phase B3）。
 *
 * POST body：
 *   {
 *     toolCallId: string,             // 必填；前端从 ApprovalRequest.toolCallId 拿
 *     decision: "allow" | "deny",     // 必填
 *     denyReason?: string,            // deny 时给 agent 看的人话原因（可选）
 *     remember?: "this-session",      // B4：仅当 decision="allow" 时生效——
 *                                     //   把 (agentId, ruleId) 加入"本 session 不再问"集合
 *     ruleId?: string                 // B4：remember 需要的归属规则 id；
 *                                     //   不传或不是 ask 规则触发的 → 忽略 remember
 *   }
 *
 * 行为：
 *   1. 校验 agent 存在
 *   2. 若 decision="allow" + remember="this-session" + ruleId 有值 → addSessionRemember
 *      （顺序在 resolveApproval 前——确保下一次同规则触发时已能被命中）
 *   3. 组合 approval id = `${agentId}:${toolCallId}` → resolveApproval
 *      - resolver 命中：onApprovalNeeded 的 await 解锁，handler 返回 → SDK 据此 allow/block tool
 *      - resolver 未命中（已超时 / 已结算 / 不存在）→ 409 Conflict
 *   4. 不在路由内推 approval_resolved 事件 ——
 *      由 agent-registry.onApprovalNeeded 在 await 完成之后统一推（保证唯一来源）。
 *
 * 注意：本路由不做权限校验（与其他 /api/agent/[id]/* 路由一致——dev 假设单用户本地）。
 */
import { NextResponse } from "next/server";
import { getAgent } from "@/lib/agent-registry";
import { assertRemoteAuth } from "@/lib/remote/auth";
import {
  addSessionRemember,
  listPendingApprovals,
  resolveApproval,
} from "@/lib/collab/server-store";
import type { ApprovalDecision } from "@/lib/collab/types";

export const runtime = "nodejs";

interface ApprovalBody {
  toolCallId?: unknown;
  decision?: unknown;
  denyReason?: unknown;
  remember?: unknown;
  ruleId?: unknown;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  const { id: agentId } = await params;
  const rec = getAgent(agentId);
  if (!rec) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    approvals: listPendingApprovals(agentId),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  const { id: agentId } = await params;
  const rec = getAgent(agentId);
  if (!rec) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }

  let body: ApprovalBody;
  try {
    body = (await req.json()) as ApprovalBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const toolCallId =
    typeof body.toolCallId === "string" && body.toolCallId.length > 0
      ? body.toolCallId
      : null;
  const decision: ApprovalDecision | null =
    body.decision === "allow" || body.decision === "deny"
      ? (body.decision as ApprovalDecision)
      : null;
  const denyReason =
    typeof body.denyReason === "string" && body.denyReason.length > 0
      ? body.denyReason
      : undefined;

  if (!toolCallId || !decision) {
    return NextResponse.json(
      { error: "toolCallId and decision (allow|deny) are required" },
      { status: 400 }
    );
  }

  // B4：处理 remember——必须在 resolveApproval **之前**写入。
  // 原因：onApprovalNeeded await resolve 后立即返回，agent 进入下一个 tool_call 时
  // 可能立刻再次命中同规则（极端情况），此时若 sessionRemember 尚未写入 → 又弹气泡。
  const remember =
    body.remember === "this-session" ? ("this-session" as const) : undefined;
  const ruleId =
    typeof body.ruleId === "string" && body.ruleId.length > 0
      ? body.ruleId
      : undefined;
  if (decision === "allow" && remember === "this-session" && ruleId) {
    addSessionRemember(agentId, ruleId);
  }

  const approvalId = `${agentId}:${toolCallId}`;
  const ok = resolveApproval(approvalId, {
    decision,
    denyReason,
    remember,
  });
  if (!ok) {
    return NextResponse.json(
      {
        error:
          "approval not pending (already resolved, timed out, or never registered)",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}
