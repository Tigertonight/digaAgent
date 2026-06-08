import { NextResponse } from "next/server";
import {
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  putWorkflowTemplate,
} from "@/lib/workflows/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? url.searchParams.get("templateId");
  if (id) {
    const template = getWorkflowTemplate(id);
    if (!template) {
      return NextResponse.json({ error: "workflow template not found" }, { status: 404 });
    }
    return NextResponse.json({ template });
  }
  return NextResponse.json({ templates: listWorkflowTemplates() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    const template = putWorkflowTemplate({
      id: body.id,
      name: body.name,
      description: body.description,
      version: body.version,
      script: body.script,
      paramsSchema: body.paramsSchema,
      defaultParams: body.defaultParams,
      capabilities: body.capabilities,
      maxAgents: body.maxAgents,
      maxConcurrency: body.maxConcurrency,
      timeoutMs: body.timeoutMs,
      tags: body.tags,
    });
    return NextResponse.json({ ok: true, template });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? url.searchParams.get("templateId");
  if (!id) {
    return NextResponse.json({ error: "template id is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, deleted: deleteWorkflowTemplate(id) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
