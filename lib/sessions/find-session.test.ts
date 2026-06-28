import { describe, expect, it } from "vitest";
import type { SessionInfoLite } from "@/lib/types";
import { findSessionForFile } from "./find-session";

function session(id: string, path: string): SessionInfoLite {
  return {
    id,
    path,
    cwd: "/repo",
    created: "2026-06-28T00:00:00.000Z",
    modified: "2026-06-28T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
  };
}

describe("findSessionForFile", () => {
  it("prefers exact path matches", () => {
    const target = session("target", "/tmp/member.jsonl");
    expect(findSessionForFile([target], "/tmp/member.jsonl")).toBe(target);
  });

  it("matches normalized equivalent paths", () => {
    const target = session("target", "/tmp/member.jsonl");
    expect(findSessionForFile([target], "/tmp//member.jsonl")).toBe(target);
  });

  it("matches by session id embedded in the file path", () => {
    const id = "97021f45-4574-4d0a-b305-bd96e7177308";
    const target = session(id, "/different/location/current.jsonl");
    expect(
      findSessionForFile(
        [target],
        `/Users/test/.pi/agent/sessions/team-${id}.jsonl`
      )
    ).toBe(target);
  });

  it("falls back to a unique basename", () => {
    const target = session("target", "/server/path/member.jsonl");
    expect(findSessionForFile([target], "/client/path/member.jsonl")).toBe(target);
  });

  it("does not match ambiguous basenames", () => {
    const first = session("first", "/a/member.jsonl");
    const second = session("second", "/b/member.jsonl");
    expect(findSessionForFile([first, second], "/c/member.jsonl")).toBeNull();
  });

  it("returns null for empty or missing matches", () => {
    expect(findSessionForFile([], "/tmp/member.jsonl")).toBeNull();
    expect(findSessionForFile([session("x", "/tmp/x.jsonl")], "")).toBeNull();
  });
});
