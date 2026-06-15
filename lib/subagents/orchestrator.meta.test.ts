import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  __setMetaRootForTests,
  readMeta,
  writeMeta,
} from "@/lib/meta/store";
import { applyChildSessionTitle } from "./orchestrator";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "subagent-meta-"));
  __setMetaRootForTests(tmpRoot);
});

afterAll(() => {
  __setMetaRootForTests(null);
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个测试前清掉所有 meta 文件
  try {
    rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("applyChildSessionTitle (P2: child session sidebar title)", () => {
  it("写入 'Subagent: <task.title>' 到 meta", async () => {
    await applyChildSessionTitle("sess-1", "检查 Electron DMG release 启动链路");
    const meta = await readMeta("sess-1");
    expect(meta?.title).toBe("Subagent: 检查 Electron DMG release 启动链路");
  });

  it("空 sessionId 不抛错也不写", async () => {
    await applyChildSessionTitle("", "x");
    // 不该有任何文件
    const meta = await readMeta("any-id");
    expect(meta).toBeNull();
  });

  it("空 title 不写（避免落 'Subagent:' 这种空尾巴）", async () => {
    await applyChildSessionTitle("sess-2", "  ");
    const meta = await readMeta("sess-2");
    expect(meta).toBeNull();
  });

  it("超长 title 截断到 60 字符并加省略号", async () => {
    const long = "A".repeat(120);
    await applyChildSessionTitle("sess-long", long);
    const meta = await readMeta("sess-long");
    expect(meta?.title).toMatch(/^Subagent: A{60}…$/);
  });

  it("用户已经把 title 改成自定义（不以 'Subagent: ' 开头），不要覆盖", async () => {
    await writeMeta({ id: "sess-user", title: "我自己的标题" });
    await applyChildSessionTitle("sess-user", "随便什么任务");
    const meta = await readMeta("sess-user");
    expect(meta?.title).toBe("我自己的标题");
  });

  it("旧 'Subagent: xxx' 标题可以被新任务覆盖（视为系统生成）", async () => {
    await writeMeta({ id: "sess-up", title: "Subagent: 旧任务" });
    await applyChildSessionTitle("sess-up", "新任务");
    const meta = await readMeta("sess-up");
    expect(meta?.title).toBe("Subagent: 新任务");
  });

  it("title 完全相同时不重写（幂等）", async () => {
    await applyChildSessionTitle("sess-eq", "同一任务");
    const before = await readMeta("sess-eq");
    await applyChildSessionTitle("sess-eq", "同一任务");
    const after = await readMeta("sess-eq");
    expect(after?.title).toBe(before?.title);
    expect(after?.title).toBe("Subagent: 同一任务");
  });

  it("保留其他 meta 字段（pinned / lastSeenAt）", async () => {
    await writeMeta({
      id: "sess-merge",
      pinned: true,
      lastSeenAt: 12345,
    });
    await applyChildSessionTitle("sess-merge", "新分支");
    const meta = await readMeta("sess-merge");
    expect(meta?.title).toBe("Subagent: 新分支");
    expect(meta?.pinned).toBe(true);
    expect(meta?.lastSeenAt).toBe(12345);
  });
});
