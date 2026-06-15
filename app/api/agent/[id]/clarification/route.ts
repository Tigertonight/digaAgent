/**
 * /api/agent/[id]/clarification
 *
 * 用户对 agent 主动追问卡片的选择提交入口。
 */
import { NextResponse } from "next/server";
import { getAgent, maybeResumeGoalAfterUserInput } from "@/lib/agent-registry";
import { assertRemoteAuth } from "@/lib/remote/auth";
import {
  getPendingClarification,
  listPendingClarifications,
  resolveClarification,
} from "@/lib/clarification/server-store";

export const runtime = "nodejs";

interface ClarificationBody {
  requestId?: unknown;
  selectedOptionId?: unknown;
  customText?: unknown;
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
    clarifications: listPendingClarifications(agentId),
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

  let body: ClarificationBody;
  try {
    body = (await req.json()) as ClarificationBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const requestId =
    typeof body.requestId === "string" && body.requestId.length > 0
      ? body.requestId
      : null;
  const selectedOptionId =
    typeof body.selectedOptionId === "string" &&
    body.selectedOptionId.length > 0
      ? body.selectedOptionId
      : undefined;
  const customText =
    typeof body.customText === "string" && body.customText.trim().length > 0
      ? body.customText.trim()
      : undefined;

  if (!requestId || (!selectedOptionId && !customText)) {
    return NextResponse.json(
      {
        error:
          "requestId and either selectedOptionId or customText are required",
      },
      { status: 400 }
    );
  }

  const clarificationId = `${agentId}:${requestId}`;
  // C2：在 resolve 之前检查 selectedOptionId 确实在 pending request 的 options 里。
  // 防 fly-by-night UI / 老 cache / 恶意请求传个不存在选项 → agent 拿到空 answer。
  const pending = getPendingClarification(clarificationId);
  if (!pending) {
    return NextResponse.json(
      {
        error:
          "clarification not pending (already resolved, aborted, or never registered)",
      },
      { status: 409 }
    );
  }
  if (selectedOptionId) {
    const found = pending.options.some((opt) => opt.id === selectedOptionId);
    if (!found) {
      return NextResponse.json(
        {
          error: `selectedOptionId "${selectedOptionId}" is not part of this clarification`,
        },
        { status: 400 }
      );
    }
  }
  const ok = resolveClarification(clarificationId, {
    selectedOptionId,
    customText,
  });
  if (!ok) {
    return NextResponse.json(
      {
        error:
          "clarification not pending (already resolved, aborted, or never registered)",
      },
      { status: 409 }
    );
  }

  // G5：追问 resolve 后如果 goal 是“等用户输入”被暂停的，自动恢复。
  // 这里用 agentId 而不是 originAgentId——paused 的是仅 parent agent 的 goal，
  // 子 agent 本身没有 goal。
  try {
    maybeResumeGoalAfterUserInput(agentId);
  } catch (e) {
    console.error("[clarification] maybeResumeGoalAfterUserInput failed:", e);
  }

  return NextResponse.json({ ok: true });
}
