import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("UiFaultBoundary", () => {
  it("exposes an isolated fallback with diagnostics actions", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/UiFaultBoundary.tsx"),
      "utf8"
    );

    expect(source).toContain("数据结构异常，已隔离该模块");
    expect(source).toContain("复制诊断 JSON");
    expect(source).toContain("重新加载当前 session");
    expect(source).toContain("componentDidCatch");
  });
});
