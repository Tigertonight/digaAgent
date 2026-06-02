/**
 * 内置审批规则。
 *
 * Phase B 只硬编码 1 条最高危险（毁灭性 bash 命令）—— 先把链路打通、保证日常 99% 工具调用
 * 不被打断；其余规则（force push / sudo / 网络下载 / 大量 edit 等）留后续小迭代或
 * 等 RFC §F1 的 JSON 配置文件接入再补。
 *
 * 顺序敏感：matcher 按数组顺序短路。当前只有 1 条所以无所谓，将来加规则时
 * 「更具体的放前面」。
 */
import type { ApprovalRule } from "./types";

export const DEFAULT_RULES: ApprovalRule[] = [
  {
    id: "dangerous-bash-destructive",
    name: "危险 bash 命令（rm -rf / git reset --hard / fork bomb）",
    match: {
      toolName: "bash",
      inputMatch: {
        command: {
          // 关键词命中其一即算危险——故意宽松，宁错杀也要弹审批。
          contains: [
            "rm -rf",
            "rm -fr",
            "git reset --hard",
            ":(){:|:&};:", // 经典 fork bomb
          ],
        },
      },
    },
    on: "ask",
    denyReason: "Permission denied by user (potentially destructive command).",
  },
];
