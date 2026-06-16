import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { enhanceToolNarration } from "@/lib/narration/enhancer";
import type { MessagePart } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

interface BatchItem {
  id?: string;
  question?: string;
  locale?: string;
  ruleText?: string;
  tool: Record<string, unknown>;
}

const MAX_ITEMS = 24;

function coerceTool(raw: Record<string, unknown> | null | undefined): ToolPart | null {
  if (!raw || typeof raw !== "object") return null;
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  if (!toolName) return null;
  const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : "narration";
  const status = raw.status === "done" || raw.status === "error" ? raw.status : "running";
  return {
    kind: "tool",
    toolCallId,
    toolName,
    args: raw.args,
    status,
    isError: Boolean(raw.isError),
  } as ToolPart;
}

export const POST = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const list = Array.isArray(body.items) ? (body.items as BatchItem[]) : null;
  if (!list || list.length === 0) {
    return NextResponse.json({ error: "items required" }, { status: 400 });
  }
  if (list.length > MAX_ITEMS) {
    return NextResponse.json({ error: `too many items (max ${MAX_ITEMS})` }, { status: 400 });
  }
  const results = await Promise.all(
    list.map(async (item, index) => {
      const tool = coerceTool(item.tool as Record<string, unknown>);
      if (!tool) return { id: item.id ?? String(index), error: "invalid tool" };
      const enhanced = await enhanceToolNarration({
        question: typeof item.question === "string" ? item.question : "",
        locale: typeof item.locale === "string" ? item.locale : "zh-CN",
        ruleText: typeof item.ruleText === "string" ? item.ruleText : "",
        tool,
        signal: req.signal,
      });
      return {
        id: item.id ?? String(index),
        narration: enhanced.text,
        enhanced: enhanced.enhanced,
        reason: enhanced.reason,
      };
    })
  );
  return NextResponse.json({ items: results });
});
