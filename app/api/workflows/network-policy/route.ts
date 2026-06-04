import { NextResponse } from "next/server";
import {
  getWorkflowNetworkPolicy,
  listWorkflowNetworkAudits,
  setWorkflowNetworkPolicy,
} from "@/lib/workflows/network-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auditLimit = Number(url.searchParams.get("auditLimit") ?? 50);
  const outcome = url.searchParams.get("outcome");
  return NextResponse.json({
    policy: getWorkflowNetworkPolicy(),
    audits: listWorkflowNetworkAudits({
      limit: auditLimit,
      workflowId: url.searchParams.get("workflowId") ?? undefined,
      origin: url.searchParams.get("origin") ?? undefined,
      outcome:
        outcome === "allowed" || outcome === "denied" || outcome === "failed"
          ? outcome
          : undefined,
      q: url.searchParams.get("q") ?? undefined,
    }),
  });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  const rawPolicy =
    body && typeof body === "object" && "policy" in body
      ? (body as { policy?: unknown }).policy
      : body;
  const policy = setWorkflowNetworkPolicy(rawPolicy);
  return NextResponse.json({ policy });
}
