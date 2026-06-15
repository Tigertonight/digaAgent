import { describe, expect, it } from "vitest";
import { extractModeFromInput, serializeModeAndText } from "./mode-chip";

describe("extractModeFromInput", () => {
  it("命中 /goal + 空格", () => {
    expect(extractModeFromInput("/goal 实现 X")).toEqual({
      mode: "goal",
      text: "实现 X",
    });
  });

  it("命中 /workflow + 空格", () => {
    expect(extractModeFromInput("/workflow 跑下这个")).toEqual({
      mode: "workflow",
      text: "跑下这个",
    });
  });

  it("命中后保留所有空白（不 trim 用户在意的尾随空格）", () => {
    // 用户敲完 "/goal " 还没继续打，正文 = ""
    expect(extractModeFromInput("/goal ")).toEqual({ mode: "goal", text: "" });
  });

  it("/goal 后非空白 → 不识别（避免 /goalxxx 误判）", () => {
    expect(extractModeFromInput("/goalxxx 任务")).toEqual({
      mode: null,
      text: "/goalxxx 任务",
    });
  });

  it("/goal 单独无空格（用户还在打）→ 不识别", () => {
    expect(extractModeFromInput("/goal")).toEqual({
      mode: null,
      text: "/goal",
    });
  });

  it("Tab 也算空白", () => {
    expect(extractModeFromInput("/workflow\tx")).toEqual({
      mode: "workflow",
      text: "x",
    });
  });

  it("普通文本不识别", () => {
    expect(extractModeFromInput("hello")).toEqual({ mode: null, text: "hello" });
    expect(extractModeFromInput("")).toEqual({ mode: null, text: "" });
  });

  it("只有第一个 token 算 mode；正文里再写 /goal 不影响", () => {
    expect(extractModeFromInput("hi /goal x")).toEqual({
      mode: null,
      text: "hi /goal x",
    });
  });
});

describe("serializeModeAndText", () => {
  it("无 mode → 原样", () => {
    expect(serializeModeAndText(null, "hi")).toBe("hi");
    expect(serializeModeAndText(null, "")).toBe("");
  });

  it("有 mode → 拼回 /<mode>", () => {
    expect(serializeModeAndText("goal", "实现 X")).toBe("/goal 实现 X");
    expect(serializeModeAndText("workflow", "")).toBe("/workflow");
  });
});
