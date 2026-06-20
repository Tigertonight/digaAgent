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

  it("redacts tool args and result details through the shared CodeBlock path", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/ToolRender.tsx"),
      "utf8",
    );

    expect(source).toContain("redactSecrets");
    expect(source).toContain("const redactedText = redact ? redactSecrets(text) : text");
    expect(source).toContain("<CodeBlock text={argsStr}");
    expect(source).toContain("<CodeBlock text={resultStr}");
    expect(source).toContain("显示原文（敏感）");
    expect(source).toContain("隐藏原文");
  });
});
