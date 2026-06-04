import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setWorkflowNetworkPolicyRootForTest,
  appendWorkflowNetworkAudit,
  getWorkflowNetworkPolicy,
  listWorkflowNetworkAudits,
  normalizeWorkflowNetworkPolicy,
  setWorkflowNetworkPolicy,
} from "./network-policy";

describe("workflow network policy", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workflow-network-policy-"));
    __setWorkflowNetworkPolicyRootForTest(root);
  });

  afterEach(async () => {
    __setWorkflowNetworkPolicyRootForTest(null);
    await rm(root, { recursive: true, force: true });
  });

  it("normalizes supported policy fields and drops invalid values", () => {
    expect(
      normalizeWorkflowNetworkPolicy({
        allowedOrigins: [" https://api.example.com ", "", 42],
        deniedOrigins: ["https://bad.example.com"],
        allowedUrlPatterns: ["https://api.example.com/*"],
        deniedUrlPatterns: ["https://api.example.com/private/*"],
        allowedMethods: ["GET", "DELETE", "POST"],
      })
    ).toEqual({
      allowedOrigins: ["https://api.example.com"],
      deniedOrigins: ["https://bad.example.com"],
      allowedUrlPatterns: ["https://api.example.com/*"],
      deniedUrlPatterns: ["https://api.example.com/private/*"],
      allowedMethods: ["GET", "POST"],
    });
  });

  it("persists policy in an envelope and loads it back", async () => {
    const saved = setWorkflowNetworkPolicy({
      allowedOrigins: ["https://api.example.com"],
      allowedMethods: ["GET"],
    });
    expect(saved).toEqual({
      allowedOrigins: ["https://api.example.com"],
      allowedMethods: ["GET"],
    });

    const raw = await readFile(
      path.join(root, "workflows", "network-policy.json"),
      "utf8"
    );
    const envelope = JSON.parse(raw);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      kind: "workflow-network-policy",
    });
    expect(envelope.policy).toEqual({
      allowedOrigins: ["https://api.example.com"],
      allowedMethods: ["GET"],
    });

    __setWorkflowNetworkPolicyRootForTest(root);
    expect(getWorkflowNetworkPolicy()).toEqual(saved);
  });

  it("loads legacy bare policy JSON", async () => {
    await mkdir(path.join(root, "workflows"), { recursive: true });
    await writeFile(
      path.join(root, "workflows", "network-policy.json"),
      JSON.stringify({ deniedOrigins: ["https://blocked.example.com"] })
    );

    __setWorkflowNetworkPolicyRootForTest(root);
    expect(getWorkflowNetworkPolicy()).toEqual({
      deniedOrigins: ["https://blocked.example.com"],
    });
  });

  it("appends and lists recent audit entries newest-first", () => {
    const first = appendWorkflowNetworkAudit({
      workflowId: "workflow-a",
      url: "https://api.example.com/a",
      method: "GET",
      outcome: "allowed",
      status: 200,
      reason: "OK",
      createdAt: 10,
    });
    const second = appendWorkflowNetworkAudit({
      workflowId: "workflow-b",
      url: "https://api.example.com/b",
      method: "POST",
      outcome: "failed",
      reason: "blocked",
      createdAt: 20,
    });

    expect(listWorkflowNetworkAudits()).toEqual([second, first]);
    expect(listWorkflowNetworkAudits(1)).toEqual([second]);
  });

  it("filters audit entries by workflow, outcome, origin, and text", () => {
    const allowed = appendWorkflowNetworkAudit({
      workflowId: "workflow-a",
      url: "https://api.example.com/public",
      method: "GET",
      outcome: "allowed",
      status: 200,
      reason: "OK",
      createdAt: 10,
    });
    appendWorkflowNetworkAudit({
      workflowId: "workflow-b",
      url: "https://other.example.com/private",
      method: "POST",
      outcome: "denied",
      reason: "policy blocked",
      createdAt: 20,
    });

    expect(
      listWorkflowNetworkAudits({
        workflowId: "workflow-a",
        outcome: "allowed",
        origin: "https://api.example.com",
        q: "public",
      })
    ).toEqual([allowed]);
  });
});
