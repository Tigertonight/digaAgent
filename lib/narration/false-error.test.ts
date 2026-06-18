/**
 * isFalseGrepNoMatch —— 判断一次 bash tool 是不是 grep/rg "no match"。
 * "no match" 不该被当成失败，否则后续 message 会触发 process group 的
 * recovered 渲染，把整条命令塞进折叠 title。
 */
import { describe, expect, it } from "vitest";
import { isFalseGrepNoMatch } from "./false-error";

const result = (text: string) => [{ type: "text", text }];

describe("isFalseGrepNoMatch", () => {
  it("bash 跑 grep 没匹配，exit 1 → 假性失败", () => {
    expect(
      isFalseGrepNoMatch(
        "bash",
        { command: 'grep -n "foo" lib/' },
        result("(no output)\n\nCommand exited with code 1")
      )
    ).toBe(true);
  });

  it("bash 跑 rg 没匹配 + glob → 假性失败", () => {
    expect(
      isFalseGrepNoMatch(
        "bash",
        { command: "rg -n 'foo' -g '*.test.ts' lib/" },
        result("\nCommand exited with code 1")
      )
    ).toBe(true);
  });

  it("bash 真错（exit 2 / 路径不存在）→ 不算假性失败", () => {
    expect(
      isFalseGrepNoMatch(
        "bash",
        { command: "rg foo /not/exists" },
        result("rg: /not/exists: No such file or directory\nCommand exited with code 2")
      )
    ).toBe(false);
  });

  it("非 grep/rg 命令 → 不算假性失败", () => {
    expect(
      isFalseGrepNoMatch(
        "bash",
        { command: "ls /tmp" },
        result("Command exited with code 1")
      )
    ).toBe(false);
  });

  it("grep 工具自己（不是 bash 包的）no-match SDK 已经标 done → 不在这个 helper 范畴", () => {
    // grep 工具 no-match 时 SDK 返回 "No matches found" 且 isError=false，
    // 这里输入 toolName=grep 时直接返回 false，由调用方决定是否触发。
    expect(
      isFalseGrepNoMatch(
        "grep",
        { pattern: "foo" },
        result("No matches found")
      )
    ).toBe(false);
  });

  it("output 里出现 Permission denied / cannot 等关键字 → 不吃", () => {
    expect(
      isFalseGrepNoMatch(
        "bash",
        { command: "grep foo /root/secret" },
        result("grep: /root/secret: Permission denied\nCommand exited with code 1")
      )
    ).toBe(false);
  });
});
