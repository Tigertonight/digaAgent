import { NextResponse } from "next/server";
import { writeClipboardText } from "@/lib/clipboard/runtime";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { isLocalRequest } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 剩贴板写入是侵入性副作用。除了远程 token 鉴权之外，只允许本地
// 调用（Electron renderer / dev local），避免远程设备静默面修改宣主机剩贴板。
export const POST = withRemoteAuth(async (req: Request) => {
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "clipboard is local-only" },
      { status: 403 }
    );
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = body.text as string | undefined;
  try {
    const result = await writeClipboardText(text ?? "");
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
});
