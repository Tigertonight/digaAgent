/**
 * 粘贴自动识别为 mention（结构化 Composer Phase B）。
 *
 * 用户的常见行为：从其他地方复制 `@/Users/.../foo.ts @/Users/.../bar.ts` 这种
 * 旧格式的字符串粘贴回 Composer。我们识别出其中的 absolute path token，
 * 把它们提为 mention，剩下的文字保留到 textarea。
 *
 * 识别规则（保守）：
 *   - 必须是完整的 token（前后是空白 / 字符串边界）
 *   - 必须以 "@/" 开头
 *   - 路径不能含空白；遇到空白即结束
 *   - macOS / Linux 形态：/ 开头
 *
 * 不识别（避免误伤）：
 *   - 中间不带 @ 的"裸" /Users/... 路径（粘贴普通日志时常见）
 *   - 相对路径 @./foo（含义模糊）
 *   - Windows 形态（暂不处理；本应用主仓 macOS）
 */

export interface PasteMentionExtraction {
  /** 提取出的所有 absolute path（不含 "@" 前缀）。已 dedupe，按出现顺序。 */
  paths: string[];
  /** 原文中删除已提取 token 后的剩余文本（含 trim 多空白）。 */
  remainingText: string;
}

const MENTION_TOKEN_RE = /(^|\s)@(\/[^\s]+)/g;

export function extractMentionsFromPaste(input: string): PasteMentionExtraction {
  if (!input) return { paths: [], remainingText: input };
  const seen = new Set<string>();
  const paths: string[] = [];
  let modified = "";
  let last = 0;
  for (const m of input.matchAll(MENTION_TOKEN_RE)) {
    const matchStart = m.index ?? 0;
    const leadingWs = m[1] ?? "";
    const path = m[2] ?? "";
    if (!path) continue;
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
    // 保留 leading 空白；丢弃 "@<path>" token 本体
    modified += input.slice(last, matchStart) + leadingWs;
    last = matchStart + m[0].length;
  }
  modified += input.slice(last);
  // 折叠粘贴后多空白并 trim 末尾，避免出现 "        " 这种残留。
  // 同时 trim 连接处的 " " + EOL 以免接上原文后多一个空格。
  const remainingText = modified
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+/g, "")
    .replace(/[ \t]+$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return { paths, remainingText };
}
