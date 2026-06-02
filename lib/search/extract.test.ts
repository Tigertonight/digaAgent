/**
 * RFC-3 Phase B / F2：extract.ts 纯函数单测。
 *
 * 覆盖 extractTextFromEntry + buildSearchDocFromSession。
 * IO 层 buildSearchIndexFromAllSessions（build-index.ts）走 SDK / fs，
 * 由后续 API 集成测试覆盖。
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  buildSearchDocFromSession,
  extractTextFromEntry,
} from "./extract";

function makeBase(id: string): { id: string; parentId: null; timestamp: string } {
  return { id, parentId: null, timestamp: "2026-06-02T00:00:00Z" };
}

describe("extractTextFromEntry()", () => {
  it("user message (string content)", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: {
        role: "user",
        content: "hello world",
        timestamp: 1,
      },
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "user", text: "hello world" },
    ]);
  });

  it("user message (array content) 拼接 text，跳过 image", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "part one" },
          { type: "image", data: "xxx", mimeType: "image/png" },
          { type: "text", text: "part two" },
        ],
        timestamp: 1,
      },
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "user", text: "part one\npart two" },
    ]);
  });

  it("user message 空 content 返回 []", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: { role: "user", content: "", timestamp: 1 },
    };
    expect(extractTextFromEntry(entry)).toEqual([]);
  });

  it("assistant message 只取 TextContent，跳过 thinking/toolCall", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret thoughts" },
          { type: "text", text: "visible answer" },
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { cmd: "ls" },
          },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "gpt-4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    };
    const out = extractTextFromEntry(entry);
    expect(out).toEqual([{ kind: "assistant", text: "visible answer" }]);
    expect(out[0].text).not.toContain("secret");
  });

  it("bashExecution → command + output", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      // 这里 message 是 BashExecutionMessage（custom role）
      message: {
        role: "bashExecution",
        command: "ls -la",
        output: "file1.txt\nfile2.txt",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      } as unknown as SessionEntry extends { type: "message" }
        ? SessionEntry["message"]
        : never,
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "bash", text: "ls -la | file1.txt\nfile2.txt" },
    ]);
  });

  it("bashExecution 超大 output 截断", () => {
    const huge = "x".repeat(5000);
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: {
        role: "bashExecution",
        command: "yes",
        output: huge,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      } as unknown as SessionEntry extends { type: "message" }
        ? SessionEntry["message"]
        : never,
    };
    const out = extractTextFromEntry(entry);
    expect(out).toHaveLength(1);
    // 截断到 2000 字符，加 "yes | " 前缀
    expect(out[0].text.length).toBeLessThanOrEqual(2000 + "yes | ".length);
    expect(out[0].kind).toBe("bash");
  });

  it("compactionSummary message → compaction kind", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: {
        role: "compactionSummary",
        summary: "前情提要",
        tokensBefore: 1000,
        timestamp: 1,
      } as unknown as SessionEntry extends { type: "message" }
        ? SessionEntry["message"]
        : never,
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "compaction", text: "前情提要" },
    ]);
  });

  it("CompactionEntry (entry-level) → compaction kind", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "compaction",
      summary: "branch compaction summary",
      firstKeptEntryId: "e0",
      tokensBefore: 500,
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "compaction", text: "branch compaction summary" },
    ]);
  });

  it("BranchSummaryEntry → branch-summary kind", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "branch_summary",
      fromId: "e0",
      summary: "another branch did X",
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "branch-summary", text: "another branch did X" },
    ]);
  });

  it("SessionInfoEntry → session-info kind", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "session_info",
      name: "我的会话",
    };
    expect(extractTextFromEntry(entry)).toEqual([
      { kind: "session-info", text: "我的会话" },
    ]);
  });

  it("SessionInfoEntry 无 name 返回 []", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "session_info",
    };
    expect(extractTextFromEntry(entry)).toEqual([]);
  });

  it("跳过 thinking_level_change", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "thinking_level_change",
      thinkingLevel: "high",
    };
    expect(extractTextFromEntry(entry)).toEqual([]);
  });

  it("跳过 model_change", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "model_change",
      provider: "openai",
      modelId: "gpt-4",
    };
    expect(extractTextFromEntry(entry)).toEqual([]);
  });

  it("跳过 label", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "label",
      targetId: "e0",
      label: "important",
    };
    expect(extractTextFromEntry(entry)).toEqual([]);
  });

  it("跳过 toolResult", () => {
    const entry: SessionEntry = {
      ...makeBase("e1"),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 1,
      },
    };
    expect(extractTextFromEntry(entry)).toEqual([]);
  });
});

describe("buildSearchDocFromSession()", () => {
  it("空 entries → 空 doc", () => {
    const doc = buildSearchDocFromSession(
      { id: "s1", path: "/tmp/s1.jsonl", cwd: "/tmp" },
      [],
      1_700_000_000_000,
    );
    expect(doc).toEqual({
      sessionId: "s1",
      path: "/tmp/s1.jsonl",
      cwd: "/tmp",
      indexedAt: 1_700_000_000_000,
      fullText: "",
      hits: [],
    });
  });

  it("多 entry 拼 fullText + hits", () => {
    const entries: SessionEntry[] = [
      {
        ...makeBase("e1"),
        type: "message",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        ...makeBase("e2"),
        type: "session_info",
        name: "我的标题",
      },
      // 跳过的 entry 不应出现在 hits
      {
        ...makeBase("e3"),
        type: "thinking_level_change",
        thinkingLevel: "low",
      },
    ];
    const doc = buildSearchDocFromSession(
      { id: "s1", path: "/tmp/s1.jsonl", cwd: "/tmp" },
      entries,
    );
    expect(doc.hits).toEqual([
      { entryId: "e1", kind: "user", text: "hello" },
      { entryId: "e2", kind: "session-info", text: "我的标题" },
    ]);
    expect(doc.fullText).toBe("hello\n我的标题");
  });
});
