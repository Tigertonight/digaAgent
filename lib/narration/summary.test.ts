import { describe, expect, it } from "vitest";
import { dedupeToolLabels, leadingVerb } from "./summary";

describe("dedupeToolLabels", () => {
  it("collapses 3+ consecutive same-verb labels", () => {
    expect(
      dedupeToolLabels([
        "正在查看 a.ts",
        "正在查看 b.ts",
        "正在查看 c.ts",
      ])
    ).toEqual(["正在查看 3 个项目"]);
  });

  it("keeps short runs as-is", () => {
    expect(
      dedupeToolLabels(["正在查看 a.ts", "正在查看 b.ts"])
    ).toEqual(["正在查看 a.ts", "正在查看 b.ts"]);
  });

  it("does not collapse different verbs", () => {
    expect(
      dedupeToolLabels([
        "正在查看 a.ts",
        "正在写入 b.ts",
        "正在查看 c.ts",
      ])
    ).toEqual([
      "正在查看 a.ts",
      "正在写入 b.ts",
      "正在查看 c.ts",
    ]);
  });

  it("compresses trailing runs and keeps preceding solo entries", () => {
    expect(
      dedupeToolLabels([
        "正在搜索 hello",
        "正在查看 a.ts",
        "正在查看 b.ts",
        "正在查看 c.ts",
        "正在查看 d.ts",
      ])
    ).toEqual(["正在搜索 hello", "正在查看 4 个项目"]);
  });

  it("ignores labels without leading 正在", () => {
    expect(
      dedupeToolLabels(["read /tmp/a", "read /tmp/b", "read /tmp/c"])
    ).toEqual(["read /tmp/a", "read /tmp/b", "read /tmp/c"]);
  });
});

describe("leadingVerb", () => {
  it("captures Chinese verb prefix", () => {
    expect(leadingVerb("正在查看 file.ts")).toBe("正在查看");
    expect(leadingVerb("正在帮你查询 知识库")).toBe("正在帮你查询");
  });
  it("returns empty for non-narration label", () => {
    expect(leadingVerb("read /tmp/a")).toBe("");
  });
});
