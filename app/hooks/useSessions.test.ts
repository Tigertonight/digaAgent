import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLastSeenPersistScheduler } from "./useSessions";

describe("createLastSeenPersistScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces repeated lastSeen writes for the same session", async () => {
    vi.useFakeTimers();
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = (input, init) => {
      calls.push([input, init]);
      return Promise.resolve(new Response("{}"));
    };
    const scheduler = createLastSeenPersistScheduler(fetcher, 100);

    scheduler.schedule("s1", "2026-06-19T10:00:00.000Z");
    scheduler.schedule("s1", "2026-06-19T10:00:01.000Z");
    scheduler.schedule("s1", "2026-06-19T10:00:02.000Z");

    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "/api/sessions/s1/meta",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          lastSeenAt: Date.parse("2026-06-19T10:00:02.000Z"),
        }),
      }),
    ]);
    scheduler.flushForTests();
  });

  it("does not let older timestamps replace a newer pending write", async () => {
    vi.useFakeTimers();
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = (input, init) => {
      calls.push([input, init]);
      return Promise.resolve(new Response("{}"));
    };
    const scheduler = createLastSeenPersistScheduler(fetcher, 100);

    scheduler.schedule("s1", "2026-06-19T10:00:03.000Z");
    scheduler.schedule("s1", "2026-06-19T10:00:01.000Z");
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        lastSeenAt: Date.parse("2026-06-19T10:00:03.000Z"),
      }),
    });
    scheduler.flushForTests();
  });
});

describe("useSessions selected session persistence", () => {
  it("remembers the selected session so Team workspaces can restore after reload", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/hooks/useSessions.ts"),
      "utf8"
    );

    expect(source).toContain("pi-selected-session-id");
    expect(source).toContain("readSelectedSessionFromStorage(initialSessions)");
    expect(source).toContain("if (!selectedId && sessions.length === 0) return;");
    expect(source).toContain("writeSelectedSessionToStorage(selectedId)");
    expect(source).toContain("readSelectedSessionFromStorage(next)");
  });
});
