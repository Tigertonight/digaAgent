/**
 * RFC-3 Phase B / F2：分词器。
 *
 * 策略（v0，零依赖）：
 *   - lowercase
 *   - 英文/数字：按 [a-z0-9]+ 切出整词
 *   - 中日韩文：按 CJK 字符段做 ngram(n=2)，长度 1 的段也保留为单字
 *   - 其他字符（标点 / emoji / 空白）：作为分隔符
 *
 * 为什么字符级 ngram 而不是 jieba：
 *   - 零依赖，v0 < 100 session 性能足够
 *   - 用户搜「采购」时索引里有「采购单」的 bigram「采购」就能命中
 *   - 缺点是召回大于精确，相关性靠 score 排序兜底
 */

const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const ASCII_WORD_RE = /[a-z0-9]+/g;

/**
 * 把任意文本切成 token 数组（已 lowercase、已去重）。
 *
 * 例：
 *   tokenize("Hello 采购单 World") → ["hello", "world", "采", "购", "单", "采购", "购单"]
 *   tokenize("") → []
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  // 1) 英文 / 数字 token
  for (const match of lower.matchAll(ASCII_WORD_RE)) {
    if (match[0].length > 0) tokens.add(match[0]);
  }

  // 2) CJK 字符：先按"连续 CJK 段"切，段内做 ngram
  let cjkBuf = "";
  const flushCjk = () => {
    if (!cjkBuf) return;
    // 单字
    for (const ch of cjkBuf) tokens.add(ch);
    // bigram
    const chars = [...cjkBuf];
    for (let i = 0; i + 1 < chars.length; i++) {
      tokens.add(chars[i] + chars[i + 1]);
    }
    cjkBuf = "";
  };

  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      cjkBuf += ch;
    } else {
      flushCjk();
    }
  }
  flushCjk();

  return [...tokens];
}

/**
 * 把 query 切成 token 数组（保留出现顺序，去重）。
 * 与 tokenize() 的区别：query 不能丢序（用于 snippet 高亮匹配）。
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  const lower = query.trim().toLowerCase();
  if (!lower) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  // 用空格 / 标点切大块，每块再走 tokenize
  // 这样用户输入 "采购 单" 会拆成两个独立 token
  const chunks = lower.split(/[\s,，。.!?！？:;；：、]+/).filter(Boolean);
  for (const chunk of chunks) {
    for (const tok of tokenize(chunk)) {
      if (!seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }

  return out;
}
