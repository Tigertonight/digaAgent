#!/usr/bin/env node
/**
 * Minimal mock MCP stdio server for tests. Speaks newline-delimited JSON-RPC.
 * Implements: initialize, tools/list, tools/call (echo + fail tools).
 *
 * Behavior switches via argv[2]:
 *   (default)  normal server
 *   "slow"     never responds to tools/call (to test timeout)
 *   "crash"    exits immediately after initialize
 */
const mode = process.argv[2] || "normal";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1.0.0" },
      },
    });
    if (mode === "crash") setTimeout(() => process.exit(1), 5);
    return;
  }
  if (method === "notifications/initialized") return; // no response
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the input text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
          { name: "fail", description: "Always returns an error result" },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    if (mode === "slow") return; // never respond -> client times out
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `echo: ${args.text}` }] },
      });
    } else if (name === "fail") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "boom" }], isError: true },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      });
    }
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
}
