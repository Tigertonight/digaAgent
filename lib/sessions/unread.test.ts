import { describe, expect, it } from "vitest";
import type { SessionInfoLite } from "@/lib/types";
import { deriveSessionUnreadAt, isSessionUnread } from "./unread";

const base: SessionInfoLite = {
  id: "s1",
  path: "/tmp/s1.jsonl",
  cwd: "/tmp",
  created: "2026-06-15T00:00:00.000Z",
  modified: "2026-06-16T10:00:00.000Z",
  messageCount: 4,
  firstMessage: "hi",
};

describe("deriveSessionUnreadAt", () => {
  it("uses lastAgentEndAt when present", () => {
    const ts = Date.parse("2026-06-16T11:30:00.000Z");
    expect(
      deriveSessionUnreadAt({ ...base, lastAgentEndAt: ts })
    ).toBe("2026-06-16T11:30:00.000Z");
  });

  it("falls back to modified when lastAgentEndAt is missing", () => {
    expect(deriveSessionUnreadAt(base)).toBe(base.modified);
  });

  it("falls back to modified when lastAgentEndAt is 0/null", () => {
    expect(
      deriveSessionUnreadAt({ ...base, lastAgentEndAt: null })
    ).toBe(base.modified);
    expect(
      deriveSessionUnreadAt({ ...base, lastAgentEndAt: 0 })
    ).toBe(base.modified);
  });
});

describe("isSessionUnread", () => {
  const session: SessionInfoLite = {
    ...base,
    lastAgentEndAt: Date.parse("2026-06-16T12:00:00.000Z"),
  };

  it("not unread while running", () => {
    expect(
      isSessionUnread({
        session,
        seenAt: undefined,
        isRunning: true,
        isWaitingUser: false,
      })
    ).toBe(false);
  });

  it("not unread while waiting user", () => {
    expect(
      isSessionUnread({
        session,
        seenAt: undefined,
        isRunning: false,
        isWaitingUser: true,
      })
    ).toBe(false);
  });

  it("unread when never seen", () => {
    expect(
      isSessionUnread({
        session,
        seenAt: null,
        isRunning: false,
        isWaitingUser: false,
      })
    ).toBe(true);
  });

  it("unread when seenAt is older than the latest agent_end", () => {
    expect(
      isSessionUnread({
        session,
        seenAt: "2026-06-16T11:59:59.000Z",
        isRunning: false,
        isWaitingUser: false,
      })
    ).toBe(true);
  });

  it("not unread when seenAt is at or after lastAgentEndAt", () => {
    expect(
      isSessionUnread({
        session,
        seenAt: "2026-06-16T12:00:00.000Z",
        isRunning: false,
        isWaitingUser: false,
      })
    ).toBe(false);
    expect(
      isSessionUnread({
        session,
        seenAt: "2026-06-16T12:30:00.000Z",
        isRunning: false,
        isWaitingUser: false,
      })
    ).toBe(false);
  });

  it("falls back to modified when lastAgentEndAt missing — covers turn-end ≠ agent-end semantics for legacy sessions", () => {
    expect(
      isSessionUnread({
        session: base,
        seenAt: "2026-06-16T09:00:00.000Z",
        isRunning: false,
        isWaitingUser: false,
      })
    ).toBe(true);
    expect(
      isSessionUnread({
        session: base,
        seenAt: "2026-06-17T00:00:00.000Z",
        isRunning: false,
        isWaitingUser: false,
      })
    ).toBe(false);
  });
});
