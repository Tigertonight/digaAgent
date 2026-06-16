import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { enhanceToolNarration } from "@/lib/narration/enhancer";
import type { MessagePart } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

export const POST = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const toolObj = body.tool;
  if (!toolObj || typeof toolObj !== "object") {
    return NextResponse.json({ error: "tool required" }, { status: 400 });
  }
  const raw = toolObj as Record<string, unknown>;
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : "narration";
  if (!toolName) return NextResponse.json({ error: "toolName required" }, { status: 400 });
  const status = raw.status === "done" || raw.status === "error" ? raw.status : "running";
  const tool: ToolPart = {
    kind: "tool",
    toolCallId,
    toolName,
    args: raw.args,
    status,
    isError: Boolean(raw.isError),
  };
  const result = await enhanceToolNarration({
    question: typeof body.question === "string" ? body.question : "",
    locale: typeof body.locale === "string" ? body.locale : "zh-CN",
    ruleText: typeof body.ruleText === "string" ? body.ruleText : "",
    tool,
    signal: req.signal,
  });
  return NextResponse.json({ narration: result.text, enhanced: result.enhanced, reason: result.reason });
});
