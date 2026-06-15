import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "./slash-command";

describe("parseSlashCommand (P1: 严格命令边界)", () => {
  it("命中 /goal 后跟空格", () => {
    expect(parseSlashCommand("/goal 实现 x", ["goal", "workflow"])).toEqual({
      name: "goal",
      rest: "实现 x",
    });
  });

  it("命中 /goal 单独一行", () => {
    expect(parseSlashCommand("/goal", ["goal"])).toEqual({
      name: "goal",
      rest: "",
    });
  });

  it("命中 /workflow 后跟换行", () => {
    expect(parseSlashCommand("/workflow\n做这件事", ["workflow"])).toEqual({
      name: "workflow",
      rest: "做这件事",
    });
  });

  it("不命中 /goalxxx 这种粘连写法", () => {
    expect(parseSlashCommand("/goalxxx 任务", ["goal"])).toBeNull();
    expect(parseSlashCommand("/goalabc", ["goal"])).toBeNull();
  });

  it("不命中 /workflowabc 这种粘连写法", () => {
    expect(parseSlashCommand("/workflowabc 任务", ["workflow"])).toBeNull();
    expect(parseSlashCommand("/workflow123", ["workflow"])).toBeNull();
  });

  it("不命中无前导 / 的纯文字", () => {
    expect(parseSlashCommand("goal 写代码", ["goal"])).toBeNull();
    expect(parseSlashCommand("写代码", ["goal"])).toBeNull();
  });

  it("接受 leading whitespace", () => {
    expect(parseSlashCommand("  /goal 写代码  ", ["goal"])).toEqual({
      name: "goal",
      rest: "写代码",
    });
  });

  it("多 candidate：返回先命中的（按数组顺序）", () => {
    expect(parseSlashCommand("/goal x", ["goal", "workflow"])).toEqual({
      name: "goal",
      rest: "x",
    });
    expect(parseSlashCommand("/workflow x", ["goal", "workflow"])).toEqual({
      name: "workflow",
      rest: "x",
    });
  });

  it("name 大小写不敏感（命中 /Goal /WORKFLOW），返回小写 name", () => {
    expect(parseSlashCommand("/Goal x", ["goal"])).toEqual({
      name: "goal",
      rest: "x",
    });
    expect(parseSlashCommand("/WORKFLOW x", ["workflow"])).toEqual({
      name: "workflow",
      rest: "x",
    });
  });

  it("空 / 单独 / / + 数字 都不命中", () => {
    expect(parseSlashCommand("/", ["goal"])).toBeNull();
    expect(parseSlashCommand("/123", ["goal"])).toBeNull();
    expect(parseSlashCommand("", ["goal"])).toBeNull();
  });
});
