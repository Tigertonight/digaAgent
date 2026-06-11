import { NextResponse } from "next/server";
import pkg from "@/package.json";
import {
  createPairingPayload,
  getRemoteAccessSettings,
  isLocalRequest,
} from "@/lib/remote/store";
import { tunnelTargetFromRequest } from "@/lib/remote/request-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  const settings = await getRemoteAccessSettings();
  const result = await createPairingPayload(
    (pkg as { version?: string }).version ?? "0.0.0",
    tunnelTargetFromRequest(req, settings.port)
  );
  return NextResponse.json(result);
}
