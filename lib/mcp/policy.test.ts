import { describe, expect, it } from "vitest";
import {
  isServerAllowedForSpecialist,
  resolveMcpPolicy,
  scopeServersForSpecialist,
} from "./policy";
import type { McpPolicyRule } from "./types";

describe("resolveMcpPolicy", () => {
  it("defaults to ask with no rules", () => {
    expect(resolveMcpPolicy("fs", "read", []).action).toBe("ask");
  });

  it("matches exact server + tool first", () => {
    const rules: McpPolicyRule[] = [
      { serverId: "*", tool: "*", action: "deny" },
      { serverId: "fs", tool: "read", action: "allow" },
    ];
    expect(resolveMcpPolicy("fs", "read", rules).action).toBe("allow");
  });

  it("falls back to server wildcard tool", () => {
    const rules: McpPolicyRule[] = [
      { serverId: "fs", tool: "*", action: "allow" },
    ];
    expect(resolveMcpPolicy("fs", "write", rules).action).toBe("allow");
  });

  it("falls back to global wildcard", () => {
    const rules: McpPolicyRule[] = [
      { serverId: "*", tool: "*", action: "deny" },
    ];
    expect(resolveMcpPolicy("anything", "x", rules).action).toBe("deny");
  });

  it("server-specific beats global", () => {
    const rules: McpPolicyRule[] = [
      { serverId: "*", tool: "*", action: "deny" },
      { serverId: "fs", tool: "*", action: "allow" },
    ];
    expect(resolveMcpPolicy("fs", "read", rules).action).toBe("allow");
    expect(resolveMcpPolicy("gh", "read", rules).action).toBe("deny");
  });
});

describe("isServerAllowedForSpecialist", () => {
  it("denies when no scope declared", () => {
    expect(isServerAllowedForSpecialist("fs", undefined)).toBe(false);
    expect(isServerAllowedForSpecialist("fs", [])).toBe(false);
  });

  it("allows only declared servers", () => {
    expect(isServerAllowedForSpecialist("fs", ["fs"])).toBe(true);
    expect(isServerAllowedForSpecialist("gh", ["fs"])).toBe(false);
  });
});

describe("scopeServersForSpecialist", () => {
  it("filters to declared servers", () => {
    expect(
      scopeServersForSpecialist(["fs", "gh", "db"], ["fs", "db"])
    ).toEqual(["fs", "db"]);
  });

  it("returns empty with no scope", () => {
    expect(scopeServersForSpecialist(["fs"], undefined)).toEqual([]);
  });
});
