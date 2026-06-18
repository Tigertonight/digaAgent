/**
 * "假性失败"识别。
 *
 * 背景：用户在 chat 里跑 `grep | head` / `rg pattern -g '*.test.ts'` 之类命令，
 * 当 grep/rg 没有匹配项时 shell exit code = 1（这是 grep/rg 的"no match"惯例，
 * 不是真的运行失败）。pi SDK 的 bash tool 看见 exitCode!=0 就 throw，结果被
 * UI 当成 errored tool；后续这条 message 又出 text，触发 process group 的
 * "recovered" 渲染，把整条 grep 命令塞进折叠 title，显示成红框长字符串，
 * 看起来像报错——其实只是没匹配。
 *
 * 这个 helper 在 chat-reducer 写入 isError 时统一兜一道：grep/rg + "Command
 * exited with code 1" + 没有真实 stderr → 当作 done，不再标 isError。
 *
 * 注意只兜 exit code 1，2 及以上仍当真错（rg=2 通常是参数错误 / 路径不存在）。
 */

interface ResultContentItem {
  type?: unknown;
  text?: unknown;
}

function extractResultText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const out: string[] = [];
    for (const item of result as ResultContentItem[]) {
      if (item && typeof item === "object" && item.type === "text") {
        if (typeof item.text === "string") out.push(item.text);
      }
    }
    return out.join("\n");
  }
  if (typeof result === "object") {
    const obj = result as { content?: unknown; text?: unknown; message?: unknown };
    if (Array.isArray(obj.content)) return extractResultText(obj.content);
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.message === "string") return obj.message;
  }
  return "";
}

function getCommandFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as { command?: unknown; cmd?: unknown };
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.cmd === "string") return obj.cmd;
  return "";
}

const GREP_LIKE_RE = /(^|[\s|;&(])(grep|rg|egrep|fgrep|ripgrep)(\s|$)/;

/**
 * 判断这次工具调用是不是 "grep/rg no-match" 这种假性失败。
 *
 * 规则（必须全部满足）：
 *   1. toolName 是 bash/shell/exec（grep 工具本身 no-match 时返回 "No matches
 *      found"，SDK 不会标 isError；我们只处理 bash 包 grep 的情况）。
 *   2. result 文本包含 "Command exited with code 1"（不能是 2/3/127 等其它码）。
 *   3. command 里出现 grep / rg / egrep / fgrep / ripgrep 单词。
 *   4. 输出里没有典型的 stderr 报错关键字（避免吃掉真错）。
 */
export function isFalseGrepNoMatch(
  toolName: string | undefined,
  args: unknown,
  result: unknown
): boolean {
  const name = (toolName ?? "").toLowerCase();
  if (name !== "bash" && name !== "shell" && name !== "exec") return false;

  const text = extractResultText(result);
  if (!/Command exited with code 1\b/.test(text)) return false;

  const command = getCommandFromArgs(args);
  if (!command || !GREP_LIKE_RE.test(command)) return false;

  // 真错关键字：rg 自身的报错通常是 exit code 2，但 head/tail 等管道命令也可能
  // 让 grep 的 SIGPIPE 被掩盖；这里只看输出里有没有明显错误信号。
  if (
    /\b(error|Error|ERROR|cannot|Cannot|No such file|Permission denied|invalid)\b/.test(
      text.replace(/Command exited with code 1\b/, "")
    )
  ) {
    return false;
  }

  return true;
}
