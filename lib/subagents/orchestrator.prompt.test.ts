import { describe, expect, it } from "vitest";
import { makeSubagentPrompt } from "./orchestrator";
import type { SubagentTaskRuntime } from "./types";

const baseTask = (over: Partial<SubagentTaskRuntime> = {}): SubagentTaskRuntime => ({
  id: "t-1",
  title: "检查 Electron DMG release 启动链路",
  prompt:
    "检查 release 包在干净用户环境下可能失败的启动、资源、keytar、asar 问题。\n范围：electron/main.js / scripts/build-electron.mjs / package.json build 配置。",
  role: "general",
  status: "pending",
  ...over,
});

describe("makeSubagentPrompt (sidebar title 同质化修复)", () => {
  it("第一行就是 '子任务：<task.title>'，不再以 '你是一个 subagent' 开头", () => {
    const out = makeSubagentPrompt(baseTask());
    const firstLine = out.split("\n")[0];
    expect(firstLine).toBe("子任务：检查 Electron DMG release 启动链路");
    expect(out.startsWith("你是一个 subagent")).toBe(false);
  });

  it("通用规则仍然存在，但放在分隔线之后", () => {
    const out = makeSubagentPrompt(baseTask());
    const ruleIdx = out.indexOf("你是一个 subagent");
    const sepIdx = out.indexOf("\n---\n");
    const taskIdx = out.indexOf("子任务：");
    expect(ruleIdx).toBeGreaterThan(0);
    expect(sepIdx).toBeGreaterThan(taskIdx);
    expect(ruleIdx).toBeGreaterThan(sepIdx);
    expect(out).toContain("- 只回答当前子任务");
    expect(out).toContain("- 最终输出包含：结论、依据、注意事项");
  });

  it("任务内容紧跟在 '任务内容：' 后；写入边界 / 角色设定 / 长期记忆都在分隔线之前", () => {
    const out = makeSubagentPrompt(
      baseTask({ writePaths: ["src/", "docs/"] }),
      "你是 release 验证 expert。",
      "上次发现 keytar 在隔离 keychain 下静默失败。"
    );
    const sepIdx = out.indexOf("\n---\n");
    const writeIdx = out.indexOf("写入边界：");
    const specialistIdx = out.indexOf("你的角色设定：");
    const memoryIdx = out.indexOf("你的长期记忆");
    expect(writeIdx).toBeGreaterThan(0);
    expect(specialistIdx).toBeGreaterThan(0);
    expect(memoryIdx).toBeGreaterThan(0);
    // 全在分隔线之前
    expect(writeIdx).toBeLessThan(sepIdx);
    expect(specialistIdx).toBeLessThan(sepIdx);
    expect(memoryIdx).toBeLessThan(sepIdx);
    expect(out).toContain("- src/");
    expect(out).toContain("- docs/");
  });

  it("不传 writePaths / specialist / memory 时 prompt 仍合法且结构稳定", () => {
    const out = makeSubagentPrompt(baseTask());
    expect(out).toContain("子任务：");
    expect(out).toContain("角色：general");
    expect(out).toContain("任务内容：");
    expect(out).toContain("\n---\n");
    expect(out).not.toContain("写入边界：");
    expect(out).not.toContain("你的角色设定：");
    expect(out).not.toContain("你的长期记忆");
  });

  it("'第一屏' 摘录前 80 字符不再撞车（不同 task title 产出不同前缀）", () => {
    const a = makeSubagentPrompt(baseTask({ title: "检查 Electron 启动" }));
    const b = makeSubagentPrompt(baseTask({ title: "审查 Keytar 凭据" }));
    expect(a.slice(0, 80)).not.toBe(b.slice(0, 80));
    expect(a.slice(0, 80)).toContain("Electron");
    expect(b.slice(0, 80)).toContain("Keytar");
  });

  it("title 为空时不会让 prompt 整体崩坏（只是 title 行变成空），仍能跑", () => {
    const out = makeSubagentPrompt(baseTask({ title: "" }));
    // 第一行就是 "子任务："（空标题）
    expect(out.split("\n")[0]).toBe("子任务：");
    // 仍然包含规则
    expect(out).toContain("你是一个 subagent");
  });
});
