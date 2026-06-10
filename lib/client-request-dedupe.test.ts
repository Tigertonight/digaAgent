import { describe, expect, it } from "vitest";
import { claimRecentClientRequest } from "./client-request-dedupe";

describe("claimRecentClientRequest", () => {
  it("dedupes repeated request ids within the ttl", () => {
    const requests = new Map<string, number>();
    expect(claimRecentClientRequest(requests, "abc", 1000, 5000)).toBe(true);
    expect(claimRecentClientRequest(requests, "abc", 1200, 5000)).toBe(false);
  });

  it("allows the same request id after ttl expiry and prunes stale entries", () => {
    const requests = new Map<string, number>([
      ["old", 1000],
      ["keep", 5800],
    ]);
    expect(claimRecentClientRequest(requests, "old", 7001, 5000)).toBe(true);
    expect(requests.has("keep")).toBe(true);
    expect(requests.get("old")).toBe(7001);
  });

  it("does not block requests without an id", () => {
    const requests = new Map<string, number>();
    expect(claimRecentClientRequest(requests, "", 1000, 5000)).toBe(true);
    expect(claimRecentClientRequest(requests, null, 1000, 5000)).toBe(true);
    expect(requests.size).toBe(0);
  });
});
