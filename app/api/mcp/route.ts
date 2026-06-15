import { NextResponse } from "next/server";
import {
  listMcpServers,
  removeMcpServer,
  upsertMcpServer,
} from "@/lib/mcp/registry";
import { listMcpTools, disposeMcpClient } from "@/lib/mcp/runtime";
import type { McpServerConfig } from "@/lib/mcp/types";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { isLocalRequest } from "@/lib/remote/store";

export const dynamic = "force-dynamic";

/** GET: list configured MCP servers. */
export const GET = withRemoteAuth(async () => {
  return NextResponse.json({ servers: listMcpServers() });
});

function parseServer(body: Record<string, unknown>): McpServerConfig | null {
  if (typeof body.id !== "string") return null;
  if (body.transport !== "stdio") return null;
  if (typeof body.command !== "string" || !body.command.trim()) return null;
  return {
    id: body.id,
    title: typeof body.title === "string" ? body.title : undefined,
    transport: "stdio",
    command: body.command,
    args: Array.isArray(body.args)
      ? body.args.filter((a): a is string => typeof a === "string")
      : undefined,
    env:
      body.env && typeof body.env === "object"
        ? (body.env as Record<string, string>)
        : undefined,
    enabled: body.enabled !== false,
  };
}

/**
 * POST: upsert / remove / test a server. body.type selects the action.
 *
 * 安全收敛（fix-S2 / S1.4）：
 *   - 所有动作需要远程鉴权（token）。
 *   - upsert 可以 spawn 任意 stdio 子进程（= 远程 RCE），额外要求
 *     `isLocalRequest`：仅 Electron renderer / dev 本地 fetch 可调，远程设备一律拒绝。
 *     远程设备需要调试 MCP 时，可走 settings UI 走主进程 IPC（TODO：S2 交付模板机制）。
 */
export const POST = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const type = body.type as string | undefined;

  try {
    if (type === "upsert") {
      if (!isLocalRequest(req)) {
        return NextResponse.json(
          {
            error:
              "MCP upsert is local-only. Use the desktop settings UI to add servers.",
          },
          { status: 403 }
        );
      }
      const config = parseServer(body);
      if (!config) {
        return NextResponse.json(
          { error: "invalid server config (need id, stdio transport, command)" },
          { status: 400 }
        );
      }
      const saved = upsertMcpServer(config);
      // New config may change the running client; drop it so it re-spawns.
      disposeMcpClient(saved.id);
      return NextResponse.json({ ok: true, server: saved });
    }

    if (type === "remove") {
      const id = body.id;
      if (typeof id !== "string") {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      disposeMcpClient(id);
      removeMcpServer(id);
      return NextResponse.json({ ok: true });
    }

    if (type === "test") {
      const id = body.id;
      if (typeof id !== "string") {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      // Force a fresh connection attempt and list tools.
      disposeMcpClient(id);
      const tools = await listMcpTools(id);
      return NextResponse.json({
        ok: tools.length >= 0,
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    }

    return NextResponse.json(
      { error: `unknown action: ${type}` },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
});
