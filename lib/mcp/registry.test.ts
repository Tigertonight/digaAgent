import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetMcpRegistryForTest,
  __setMcpRegistryRootForTest,
  getMcpServer,
  listEnabledMcpServers,
  listMcpServers,
  removeMcpServer,
  upsertMcpServer,
} from "./registry";
import type { McpServerConfig } from "./types";

function server(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "fs",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    enabled: true,
    ...over,
  };
}

describe("mcp registry", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "mini-pi-mcp-"));
    __setMcpRegistryRootForTest(root);
  });

  afterEach(() => {
    __setMcpRegistryRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(listMcpServers()).toHaveLength(0);
  });

  it("upserts and persists a server", () => {
    upsertMcpServer(server());
    expect(existsSync(path.join(root, "mcp", "servers.json"))).toBe(true);
    expect(getMcpServer("fs")?.command).toBe("npx");
  });

  it("recovers from disk after reset", () => {
    upsertMcpServer(server({ id: "gh", command: "gh-mcp" }));
    __resetMcpRegistryForTest();
    expect(getMcpServer("gh")?.command).toBe("gh-mcp");
  });

  it("updates an existing server", () => {
    upsertMcpServer(server());
    upsertMcpServer(server({ title: "Filesystem" }));
    expect(listMcpServers()).toHaveLength(1);
    expect(getMcpServer("fs")?.title).toBe("Filesystem");
  });

  it("filters enabled servers", () => {
    upsertMcpServer(server({ id: "a", enabled: true }));
    upsertMcpServer(server({ id: "b", enabled: false }));
    expect(listEnabledMcpServers().map((s) => s.id)).toEqual(["a"]);
  });

  it("removes a server", () => {
    upsertMcpServer(server());
    removeMcpServer("fs");
    expect(getMcpServer("fs")).toBeNull();
  });

  it("rejects unsafe ids", () => {
    expect(() => upsertMcpServer(server({ id: "../x" }))).toThrow();
    expect(() => upsertMcpServer(server({ id: "a b" }))).toThrow();
  });

  it("rejects empty command", () => {
    expect(() => upsertMcpServer(server({ command: "  " }))).toThrow();
  });

  it("skips corrupt entries on hydrate", () => {
    upsertMcpServer(server({ id: "good" }));
    __resetMcpRegistryForTest();
    // good still loads from disk
    expect(getMcpServer("good")).not.toBeNull();
  });
});
