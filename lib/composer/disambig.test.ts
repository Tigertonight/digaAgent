import { describe, expect, it } from "vitest";
import { computeDisambigByPath } from "./disambig";

describe("computeDisambigByPath", () => {
  it("无冲突 → map 为空", () => {
    const r = computeDisambigByPath(["/a/foo.ts", "/b/bar.ts"]);
    expect(r.size).toBe(0);
  });

  it("两条同名 → 取最少区分父级", () => {
    const r = computeDisambigByPath([
      "/a/agent/[id]/route.ts",
      "/a/auth/login/route.ts",
    ]);
    // 最少区分：[id] vs login 已判不同，1 段就够。
    expect(r.get("/a/agent/[id]/route.ts")).toBe("[id]");
    expect(r.get("/a/auth/login/route.ts")).toBe("login");
  });

  it("多条同名，公共后缀长度不同", () => {
    const r = computeDisambigByPath([
      "/p/a/b/c/route.ts",
      "/p/x/b/c/route.ts",
      "/p/y/q/c/route.ts",
    ]);
    // a/b/c 和 x/b/c 的 c 相同、b 相同、a vs x 不同；
    // 但要能与 y/q/c 区分 → 必须包含 b。
    expect(r.get("/p/a/b/c/route.ts")).toBe("a/b/c");
    expect(r.get("/p/x/b/c/route.ts")).toBe("x/b/c");
    // y/q/c 与 a/b/c 、x/b/c 只要一段 q vs b 就能区分。
    expect(r.get("/p/y/q/c/route.ts")).toBe("q/c");
  });

  it("仅一条 → 无冲突", () => {
    const r = computeDisambigByPath(["/x/y/route.ts"]);
    expect(r.size).toBe(0);
  });

  it("空入参", () => {
    expect(computeDisambigByPath([]).size).toBe(0);
  });

  it("不同 basename 共存：只对冲突组生效", () => {
    const r = computeDisambigByPath([
      "/a/route.ts",
      "/b/route.ts",
      "/c/foo.ts",
    ]);
    expect(r.get("/a/route.ts")).toBe("a");
    expect(r.get("/b/route.ts")).toBe("b");
    expect(r.has("/c/foo.ts")).toBe(false);
  });

  it("无父目录的 basename（如 /route.ts）也不崩", () => {
    const r = computeDisambigByPath(["/route.ts", "/x/route.ts"]);
    // 一条无父目录 → 没法 disambig，但另一条仍能给出 "x"
    expect(r.get("/x/route.ts")).toBe("x");
  });
});
