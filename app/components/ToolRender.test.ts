import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ToolRender truncation UX", () => {
  it("renders a dedicated truncation banner instead of a generic tool error", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/ToolRender.tsx"),
      "utf8",
    );

    expect(source).toContain("diagnoseToolTruncation");
    expect(source).toContain("工具参数被截断");
    expect(source).toContain("truncation.userMessage");
    expect(source).toContain("truncation.recommendedStrategy");
  });
});
