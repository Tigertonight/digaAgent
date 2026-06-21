/**
 * collectSessionDescendants —— 父 session 删除时级联收集所有子 fork。
 *
 * 验证：
 * - 不存在 id 返回 null
 * - 没有 children 时只返回自己
 * - 单层 child + 多层（child of child）都跟着被收集
 * - 跨分支的同级 fork 互不影响
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const listAll = vi.fn();
const access = vi.fn();
const listAgentSummaries = vi.fn<() => unknown[]>(() => []);

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    SessionManager: {
      ...actual.SessionManager,
      listAll: (...args: unknown[]) => listAll(...args),
    },
  };
});

vi.mock("./meta/store", () => ({
  batchReadMeta: vi.fn(async () => new Map()),
}));

vi.mock("./agent-registry", () => ({
  listAgentSummaries: () => listAgentSummaries(),
}));

vi.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => access(...args),
}));

import {
  __clearSessionListCacheForTests,
  collectSessionDescendants,
  listAllSessions,
} from "./sessions";

afterEach(() => {
  __clearSessionListCacheForTests();
  listAll.mockReset();
  access.mockReset();
  listAgentSummaries.mockReset();
  listAgentSummaries.mockReturnValue([]);
});

function makeSession(
  id: string,
  path: string,
  parentSessionPath?: string,
): {
  id: string;
  path: string;
  parentSessionPath?: string;
  cwd: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
} {
  return {
    id,
    path,
    parentSessionPath,
    cwd: "/tmp",
    created: new Date(0),
    modified: new Date(0),
    messageCount: 0,
    firstMessage: "",
    allMessagesText: "",
  };
}

function makeRecentSession(id: string, path: string) {
  return {
    ...makeSession(id, path),
    created: new Date(),
    modified: new Date(),
  };
}

describe("collectSessionDescendants", () => {
  it("找不到 root id 时返回 null", async () => {
    listAll.mockResolvedValue([makeSession("a", "/p/a.jsonl")]);
    const out = await collectSessionDescendants("missing");
    expect(out).toBeNull();
  });

  it("没有 child 时只返回 root 自己", async () => {
    listAll.mockResolvedValue([
      makeSession("a", "/p/a.jsonl"),
      makeSession("b", "/p/b.jsonl"), // 同级，无 parent 关系
    ]);
    const out = await collectSessionDescendants("a");
    expect(out).toEqual([{ id: "a", path: "/p/a.jsonl" }]);
  });

  it("收集单层 + 多层 fork（孙子）", async () => {
    listAll.mockResolvedValue([
      makeSession("root", "/p/root.jsonl"),
      makeSession("child1", "/p/child1.jsonl", "/p/root.jsonl"),
      makeSession("child2", "/p/child2.jsonl", "/p/root.jsonl"),
      makeSession("grand", "/p/grand.jsonl", "/p/child1.jsonl"),
      // 跨分支的不相关 session 不能被卷进来
      makeSession("other", "/p/other.jsonl"),
      makeSession("otherChild", "/p/oc.jsonl", "/p/other.jsonl"),
    ]);
    const out = await collectSessionDescendants("root");
    expect(out).not.toBeNull();
    const ids = out!.map((x) => x.id).sort();
    expect(ids).toEqual(["child1", "child2", "grand", "root"]);
    // root 必须排第一（删除顺序：广度优先）
    expect(out![0]!.id).toBe("root");
  });
});

describe("listAllSessions", () => {
  it("隐藏文件已不存在的空白会话", async () => {
    listAll.mockResolvedValue([
      makeSession("ghost", "/p/ghost.jsonl"),
      { ...makeSession("real", "/p/real.jsonl"), messageCount: 1 },
    ]);
    access.mockImplementation(async (path: string) => {
      if (path === "/p/ghost.jsonl") throw new Error("missing");
    });

    const out = await listAllSessions();

    expect(out.map((s) => s.id)).toEqual(["real"]);
  });

  it("保留刚创建但文件尚未出现的空白会话", async () => {
    listAll.mockResolvedValue([makeRecentSession("fresh", "/p/fresh.jsonl")]);
    access.mockRejectedValue(new Error("missing"));

    const out = await listAllSessions();

    expect(out.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("保留正在运行但文件尚未出现的临时会话", async () => {
    listAll.mockResolvedValue([]);
    listAgentSummaries.mockReturnValue([
      {
        agentId: "agent-1",
        sessionId: "running",
        sessionFile: "/p/running.jsonl",
        hidden: false,
        cwd: "/tmp",
        runtimeState: "streaming",
        updatedAt: 1,
      },
    ]);
    access.mockRejectedValue(new Error("missing"));

    const out = await listAllSessions();

    expect(out.map((s) => s.id)).toEqual(["running"]);
  });
});
