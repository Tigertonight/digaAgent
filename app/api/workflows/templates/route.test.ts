import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWorkflowTemplateStoreForTest,
  __setWorkflowTemplateStoreRootForTest,
} from "@/lib/workflows/template-store";
import { DELETE, GET, POST } from "./route";

// 所有 route 现在都走 withRemoteAuth，为了让本地 fast path 生效，需要
// 注入 DIGA_AGENT_LOCAL_SECRET 与同名 header。
const TEST_LOCAL_SECRET = "vitest-local-secret";

function request(url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("x-diga-agent-local-secret", TEST_LOCAL_SECRET);
  return new Request(url, {
    ...init,
    headers,
  });
}

describe("/api/workflows/templates", () => {
  let root: string;
  const previousSecret = process.env.DIGA_AGENT_LOCAL_SECRET;

  beforeAll(() => {
    process.env.DIGA_AGENT_LOCAL_SECRET = TEST_LOCAL_SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.DIGA_AGENT_LOCAL_SECRET;
    } else {
      process.env.DIGA_AGENT_LOCAL_SECRET = previousSecret;
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workflow-template-api-test-"));
    __setWorkflowTemplateStoreRootForTest(root);
  });

  afterEach(async () => {
    __resetWorkflowTemplateStoreForTest();
    __setWorkflowTemplateStoreRootForTest(null);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("creates, reads, lists, and deletes a template", async () => {
    const created = await POST(
      request("http://localhost/api/workflows/templates", {
        method: "POST",
        body: JSON.stringify({
          id: "research",
          name: "Deep research",
          script: "return workflow.params;",
          defaultParams: { topic: "workflow" },
          capabilities: ["spawn_agent", "read_files"],
        }),
      })
    );

    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      ok: true,
      template: { id: "research", name: "Deep research" },
    });

    const listed = await GET(request("http://localhost/api/workflows/templates"));
    await expect(listed.json()).resolves.toMatchObject({
      templates: [expect.objectContaining({ id: "research" })],
    });

    const fetched = await GET(
      request("http://localhost/api/workflows/templates?id=research")
    );
    await expect(fetched.json()).resolves.toMatchObject({
      template: {
        id: "research",
        defaultParams: { topic: "workflow" },
      },
    });

    const deleted = await DELETE(
      request("http://localhost/api/workflows/templates?id=research", {
        method: "DELETE",
      })
    );
    await expect(deleted.json()).resolves.toEqual({ ok: true, deleted: true });

    const missing = await GET(
      request("http://localhost/api/workflows/templates?id=research")
    );
    expect(missing.status).toBe(404);
  });
});
