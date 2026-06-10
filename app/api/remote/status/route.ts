import { NextResponse } from "next/server";
import os from "node:os";
import pkg from "@/package.json";
import { listAgentSummaries, getModelRegistry } from "@/lib/agent-registry";
import { getRemoteAccessSettings } from "@/lib/remote/store";
import { listRemoteCandidates } from "@/lib/remote/network";
import { ensurePublicTunnel, getPublicTunnelStatus } from "@/lib/remote/public-tunnel";
import { pickDefaultFlatModel } from "@/lib/default-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getRemoteAccessSettings();
  let tunnel = getPublicTunnelStatus();
  if (
    !settings.publicTunnelDisabled &&
    (!tunnel.running || !tunnel.url || tunnel.healthy === false)
  ) {
    tunnel = await ensurePublicTunnel(settings.port);
  } else if (!settings.publicTunnelDisabled && tunnel.running && tunnel.url) {
    tunnel = await ensurePublicTunnel(settings.port);
  }
  const mr = getModelRegistry();
  const providers = mr.getAll();
  const authedProviders = new Set<string>();
  for (const provider of new Set(providers.map((model) => model.provider))) {
    const status = mr.getProviderAuthStatus(provider);
    if (
      status.configured ||
      status.source === "environment" ||
      status.source === "runtime" ||
      status.source === "models_json_key" ||
      status.source === "models_json_command"
    ) {
      authedProviders.add(provider);
    }
  }
  const defaultModel = pickDefaultFlatModel(providers, authedProviders);
  const candidates = listRemoteCandidates({ mode: settings.mode, port: settings.port });
  if (tunnel.running && tunnel.url) {
    candidates.unshift({
      url: tunnel.url,
      kind: "public-tunnel",
      label: "公网",
    });
  }
  return NextResponse.json({
    enabled: settings.mode !== "off" || Boolean(tunnel.running && tunnel.url),
    mode: settings.mode,
    hostName: os.hostname(),
    instanceId: settings.instanceId,
    candidates,
    port: settings.port,
    publicTunnel: tunnel,
    defaultCwd: process.env.MINI_PI_WEB_ROOT || process.cwd(),
    defaultProvider: defaultModel?.provider,
    defaultModelId: defaultModel?.id,
    activeAgents: listAgentSummaries().filter((agent) => !agent.hidden),
    version: (pkg as { version?: string }).version ?? "0.0.0",
  });
}
