import { describe, it, expect } from "vitest";
import {
  CONTEXT_ASIDE_OPEN,
  CONTEXT_ASIDE_CLOSE,
  stripContextAside,
} from "./context-aside";

describe("stripContextAside", () => {
  it("无标记时完全原样返回（不改动用户原文）", () => {
    expect(stripContextAside("你好世界")).toBe("你好世界");
    // 无标记时不应 trim，保留用户可能故意输入的空格
    expect(stripContextAside("  hi  ")).toBe("  hi  ");
  });

  it("空字符串安全", () => {
    expect(stripContextAside("")).toBe("");
  });

  it("剥离一对完整标记及其内容，只留原话", () => {
    const original = "请搜索迪迦奥特曼";
    const aside = "browser_search: baidu ...\nbrowser_extract: ...";
    const full = `${original}\n\n${CONTEXT_ASIDE_OPEN}\n${aside}\n${CONTEXT_ASIDE_CLOSE}`;
    expect(stripContextAside(full)).toBe(original);
  });

  it("未闭合的开标记也会被截断", () => {
    const full = `请搜索迪迦奥特曼\n\n${CONTEXT_ASIDE_OPEN}\n一些上下文没有闭合`;
    expect(stripContextAside(full)).toBe("请搜索迪迦奥特曼");
  });

  it("整条都是 aside（原话为空）时返回空串", () => {
    const full = `${CONTEXT_ASIDE_OPEN}\n只有上下文\n${CONTEXT_ASIDE_CLOSE}`;
    expect(stripContextAside(full)).toBe("");
  });

  it("折叠剥离后产生的多余空行", () => {
    const full = `第一行\n\n\n${CONTEXT_ASIDE_OPEN}\nx\n${CONTEXT_ASIDE_CLOSE}\n\n\n`;
    expect(stripContextAside(full)).toBe("第一行");
  });
});
