import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import {
  getCommunicationSettings,
  updateCommunicationSettings,
  type WorkMode,
} from "@/lib/communication/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseWorkMode(value: unknown): WorkMode | undefined {
  return value === "coding" || value === "daily" ? value : undefined;
}

export const GET = withRemoteAuth(async (req: Request) => {
  void req;
  return NextResponse.json({
    communication: await getCommunicationSettings(),
  });
});

export const PATCH = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const patch = (body.communication ?? body) as Record<string, unknown>;
  const communication = await updateCommunicationSettings({
    workMode: parseWorkMode(patch.workMode),
  });
  return NextResponse.json({ communication });
});
