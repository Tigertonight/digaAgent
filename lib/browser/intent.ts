export type BrowserSearchEngine = "baidu" | "google" | "bing";

export type BrowserIntent =
  | { kind: "none" }
  | {
      kind: "open_url";
      url: string;
      verifyText?: string;
      expectation?: string;
      resultIndex?: number;
      copyResult?: boolean;
    }
  | {
      kind: "search";
      query: string;
      engine: BrowserSearchEngine;
      expectation?: string;
      resultIndex?: number;
      copyResult?: boolean;
    }
  | {
      kind: "ui_verify";
      url?: string;
      expectation: string;
      verifyText?: string;
    }
  | {
      kind: "navigate";
      instruction: string;
      url?: string;
      clickText?: string;
      fillText?: string;
      pressEnter?: boolean;
    };

const URL_RE = /https?:\/\/[^\s"'<>，。！？、)）\]]+/i;

export function extractFirstUrl(text: string): string | null {
  return text.match(URL_RE)?.[0] ?? null;
}

export function extractSearchQuery(text: string): string | null {
  const quoted =
    text.match(/(?:搜索|search)\s*[“"']([^”"']{1,120})[”"']/i)?.[1] ??
    text.match(/[“"']([^”"']{1,120})[”"']\s*(?:相关|的信息|资料|搜索)?/i)?.[1];
  if (quoted) return quoted.trim();

  const plain = text.match(/(?:搜索|search)\s+([^\n，。！？]{1,120})/i)?.[1];
  return plain?.trim() ?? null;
}

export function extractVerifyText(text: string): string | undefined {
  const quoted =
    text.match(/(?:看到|包含|是否有|是否看到)\s*[“"']([^”"']{1,120})[”"']/i)?.[1] ??
    text.match(/(?:看到|包含|是否有|是否看到)\s+([A-Za-z0-9][^，。！？\n]{0,80})/i)?.[1];
  return quoted?.trim();
}

export function extractClickText(text: string): string | undefined {
  const quoted =
    text.match(/(?:点击|click)\s*[“"']([^”"']{1,120})[”"']/i)?.[1] ??
    text.match(/(?:点击|click)\s+([^，。！？\n]{1,80})/i)?.[1];
  return quoted?.trim();
}

export function extractFillText(text: string): string | undefined {
  const quoted =
    text.match(/(?:输入|填入|填写|type|fill)\s*[“"']([^”"']{1,160})[”"']/i)?.[1] ??
    text.match(
      /(?:输入|填入|填写|type|fill)\s+([^，。！？\n]{1,120})(?:\s*(?:并|然后|后|$))/i
    )?.[1];
  return quoted?.trim();
}

function inferSearchEngine(text: string): BrowserSearchEngine {
  if (/google/i.test(text)) return "google";
  if (/bing/i.test(text)) return "bing";
  return "baidu";
}

function wantsFirstResult(text: string) {
  return /第一条|第一个|首个|first\s+(result|link)|top\s+(result|link)/i.test(
    text
  );
}

function wantsCopy(text: string) {
  return /复制|拷贝|剪切板|clipboard|copy/i.test(text);
}

function wantsEnter(text: string) {
  return /按\s*(?:Enter|回车)|press\s+enter|回车|提交|搜索/i.test(text);
}

function isBrowserTask(text: string): boolean {
  return /(浏览器|browser|browser-use|打开\s*https?:\/\/|访问\s*https?:\/\/|搜索|search|网页验收|页面验收|browser_open|browser_search|点击.+链接|提取.+链接|复制.+链接)/i.test(
    text
  );
}

export function parseBrowserIntent(text: string): BrowserIntent {
  if (!isBrowserTask(text)) return { kind: "none" };

  const url = extractFirstUrl(text) ?? undefined;
  const query = extractSearchQuery(text) ?? undefined;
  const verifyText = extractVerifyText(text);
  const clickText = extractClickText(text);
  const fillText = extractFillText(text);
  const pressEnter = wantsEnter(text);
  const resultIndex = wantsFirstResult(text) ? 0 : undefined;
  const copyResult = wantsCopy(text);
  const expectation = /验收|verify|是否看到|看到|包含|确认/i.test(text)
    ? verifyText ?? (url ? `page opened at ${url}` : query)
    : undefined;

  if (url && (clickText || fillText)) {
    return {
      kind: "navigate",
      instruction: text,
      url,
      clickText,
      fillText,
      pressEnter,
    };
  }

  if (query && /(搜索|search)/i.test(text)) {
    return {
      kind: "search",
      query,
      engine: inferSearchEngine(text),
      expectation,
      resultIndex,
      copyResult,
    };
  }

  if (url && (typeof resultIndex === "number" || copyResult)) {
    return {
      kind: "open_url",
      url,
      verifyText,
      expectation,
      resultIndex,
      copyResult,
    };
  }

  if (url && /验收|verify|是否看到|看到|包含|确认/i.test(text)) {
    return {
      kind: "ui_verify",
      url,
      expectation: expectation ?? `page opened at ${url}`,
      verifyText,
    };
  }

  if (url) {
    return {
      kind: "open_url",
      url,
      verifyText,
      expectation,
      resultIndex,
      copyResult,
    };
  }

  if (/点击|输入|复制|打开.+链接|提取.+链接/i.test(text)) {
    return { kind: "navigate", instruction: text, url, clickText, fillText, pressEnter };
  }

  return { kind: "none" };
}
