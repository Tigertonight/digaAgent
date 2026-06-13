import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig, McpToolDescriptor, McpToolResult } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2024-11-05";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Minimal stdio JSON-RPC MCP client (decision A). Speaks newline-delimited JSON
 * over the spawned process's stdio. Supports initialize / tools/list /
 * tools/call only. Manages the child process lifecycle with timeouts and
 * guaranteed cleanup (修正 1).
 */
export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private closed = false;
  private initialized = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;
    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env ?? {}) },
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", () => {
      // stderr is diagnostic; ignored to avoid noisy logs in tests.
    });
    proc.on("error", (err) => this.failAll(err));
    proc.on("close", () => {
      if (!this.closed) this.failAll(new Error("mcp server process closed"));
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "diga-agent", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.ensureStarted();
    const result = (await this.request("tools/list", {})) as {
      tools?: Array<{
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };
    return (result.tools ?? [])
      .filter((t): t is { name: string } & typeof t => typeof t.name === "string")
      .map((t) => ({
        serverId: this.config.id,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
  }

  async callTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<McpToolResult> {
    await this.ensureStarted();
    const result = (await this.request("tools/call", {
      name,
      arguments: input ?? {},
    })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    return { text, isError: result.isError === true, raw: result };
  }

  dispose(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("mcp client disposed"));
    }
    this.pending.clear();
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.proc = null;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.proc) await this.start();
    else if (!this.initialized) {
      // start() in progress elsewhere is not expected (single-threaded usage);
      // guard anyway.
      throw new Error("mcp client not initialized");
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.closed) {
        reject(new Error("mcp client not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request "${method}" timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      try {
        this.proc.stdin.write(payload + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc || this.closed) return;
    try {
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
      );
    } catch {
      // best-effort
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // skip non-JSON lines (some servers log to stdout)
      }
      if (msg.id === undefined || msg.id === null) continue; // notification
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (msg.error) {
        p.reject(new Error(`mcp error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
