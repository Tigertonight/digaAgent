import { describe, expect, it } from "vitest";
import type { SessionInfoLite } from "@/lib/types";
import { upsertOptimisticSession } from "./optimistic";

const baseList = (): SessionInfoLite[] => [
  {
    id: "old-1",
    path: "/p/old-1.jsonl",
    cwd: "/p",
    created: "2024-01-01T00:00:00Z",
    modified: "2024-01-01T00:00:00Z",
    messageCount: 5,
    firstMessage: "已存在的会话",
  },
];

describe("upsertOptimisticSession (sidebar 即时显示)", () => {
  it("不存在 → 插到列表顶部，runtimeState=loading, isRunning=true", () => {
    const next = upsertOptimisticSession(baseList(), {
      id: "new-1",
      path: "/p/new-1.jsonl",
      cwd: "/p",
      firstMessage: "做一件事",
    });
    expect(next.length).toBe(2);
    expect(next[0].id).toBe("new-1");
    expect(next[0].runtimeState).toBe("loading");
    expect(next[0].isRunning).toBe(true);
    expect(next[0].messageCount).toBe(1);
    expect(next[0].firstMessage).toBe("做一件事");
    expect(next[1].id).toBe("old-1");
  });

  it("空 id / 空 path → 不修改", () => {
    const list = baseList();
    expect(
      upsertOptimisticSession(list, { id: "", path: "/x", cwd: "/p" })
    ).toBe(list);
    expect(
      upsertOptimisticSession(list, { id: "x", path: "", cwd: "/p" })
    ).toBe(list);
  });

  it("已存在 → 不覆盖 messageCount / modified", () => {
    const list = baseList();
    const next = upsertOptimisticSession(list, {
      id: "old-1",
      path: "/p/old-1.jsonl",
      cwd: "/p",
      firstMessage: "新内容",
    });
    expect(next.length).toBe(1);
    expect(next[0].messageCount).toBe(5);
    expect(next[0].modified).toBe("2024-01-01T00:00:00Z");
    expect(next[0].firstMessage).toBe("已存在的会话"); // 已有非空就不改
  });

  it("已存在但 firstMessage 为空 → 补空字段", () => {
    const list: SessionInfoLite[] = [
      {
        id: "old-1",
        path: "/p/old-1.jsonl",
        cwd: "/p",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        messageCount: 0,
        firstMessage: "",
      },
    ];
    const next = upsertOptimisticSession(list, {
      id: "old-1",
      path: "/p/old-1.jsonl",
      cwd: "/p",
      firstMessage: "刚发的",
    });
    expect(next[0].firstMessage).toBe("刚发的");
  });

  it("已存在但已经有 runtime（streaming）→ 不被打回 loading", () => {
    const list: SessionInfoLite[] = [
      {
        id: "x",
        path: "/p/x.jsonl",
        cwd: "/p",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        messageCount: 1,
        firstMessage: "x",
        isRunning: true,
        runtimeState: "streaming",
      },
    ];
    const next = upsertOptimisticSession(list, {
      id: "x",
      path: "/p/x.jsonl",
      cwd: "/p",
      firstMessage: "y",
    });
    expect(next[0].runtimeState).toBe("streaming");
  });

  it("firstMessage trim 到 200 字符", () => {
    const long = "a".repeat(500);
    const next = upsertOptimisticSession(baseList(), {
      id: "n",
      path: "/p/n.jsonl",
      cwd: "/p",
      firstMessage: long,
    });
    expect(next[0].firstMessage.length).toBe(200);
  });

  it("无变化时返回原引用（避免 setState 触发额外 render）", () => {
    const list: SessionInfoLite[] = [
      {
        id: "x",
        path: "/p/x.jsonl",
        cwd: "/p",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        messageCount: 5,
        firstMessage: "已有",
        isRunning: true,
        runtimeState: "streaming",
      },
    ];
    const next = upsertOptimisticSession(list, {
      id: "x",
      path: "/p/x.jsonl",
      cwd: "/p",
      firstMessage: "新",
    });
    expect(next).toBe(list);
  });

  it("parentSessionPath 透传（fork 场景）", () => {
    const next = upsertOptimisticSession(baseList(), {
      id: "fk",
      path: "/p/fk.jsonl",
      cwd: "/p",
      firstMessage: "fork it",
      parentSessionPath: "/p/old-1.jsonl",
    });
    expect(next[0].parentSessionPath).toBe("/p/old-1.jsonl");
  });
});
