import type { PublicTunnelTarget } from "./public-tunnel";

export function tunnelTargetFromRequest(req: Request, fallbackPort: number): PublicTunnelTarget {
  const url = new URL(req.url);
  const hostHeader = req.headers.get("host") || url.host;
  const parsed = new URL(`${url.protocol}//${hostHeader}`);
  const hostname =
    parsed.hostname === "localhost" || parsed.hostname === "::1"
      ? "127.0.0.1"
      : parsed.hostname;
  const port = Number(parsed.port || url.port || fallbackPort);
  return {
    host: hostname,
    port: Number.isInteger(port) && port > 0 ? port : fallbackPort,
  };
}
