import { describe, expect, it } from "vitest";
import { buildFileItems } from "./useAutocomplete";

describe("buildFileItems", () => {
  it("builds absolute mention values for directory entries without path", () => {
    const items = buildFileItems(
      [
        { name: "app", isDir: true },
        { name: "package.json", isDir: false },
      ],
      "",
      "/Users/me/project"
    );

    expect(items.map((item) => item.value)).toEqual([
      "@/Users/me/project/app",
      "@/Users/me/project/package.json",
    ]);
  });

  it("preserves explicit paths from search results", () => {
    const items = buildFileItems(
      [{ name: "route.ts", isDir: false, path: "/Users/me/project/app/route.ts" }],
      "route",
      "/Users/me/project"
    );

    expect(items[0]?.value).toBe("@/Users/me/project/app/route.ts");
  });
});
