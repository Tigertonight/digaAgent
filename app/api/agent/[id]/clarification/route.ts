/**
 * /api/agent/[id]/clarification
 *
 * 用户对 agent 主动追问卡片的选择提交入口。
 */
import { NextResponse } from "next/server";
import { getAgent } from "@/lib/agent-registry";
import { assertRemoteAuth } from "@/lib/remote/auth";
import {
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

  return NextResponse.json({ ok: true });
}
