"use client";

/**
 * Markdown 渲染（带 GFM + code highlight）。
 * 用 light/dark 两套主题，根据 documentElement 上的 data-theme 切。
 */
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { memo, useMemo, useState, useSyncExternalStore } from "react";
import { previewStore } from "@/lib/preview-store";

// Prism 按需注册 —— 默认 Prism 会带全部语言(几 MB);PrismLight 只 ship 已注册的。
// 列表覆盖编程/配置/查询/标记主流语言;未命中的语言代码块会显示为无高亮纯文本(不影响阅读)。
import langBash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import langC from "react-syntax-highlighter/dist/esm/languages/prism/c";
import langCpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import langCsharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import langCss from "react-syntax-highlighter/dist/esm/languages/prism/css";
import langDiff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import langDocker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import langGo from "react-syntax-highlighter/dist/esm/languages/prism/go";
import langGraphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import langJava from "react-syntax-highlighter/dist/esm/languages/prism/java";
import langJavascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import langJson from "react-syntax-highlighter/dist/esm/languages/prism/json";
import langJsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import langKotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import langMarkdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import langMarkup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import langPhp from "react-syntax-highlighter/dist/esm/languages/prism/php";
import langPython from "react-syntax-highlighter/dist/esm/languages/prism/python";
import langRust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import langScss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import langSql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import langSwift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import langToml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import langTsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import langTypescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import langYaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

// 别名:常见的 lang 写法都映射到同一个 syntax
SyntaxHighlighter.registerLanguage("bash", langBash);
SyntaxHighlighter.registerLanguage("sh", langBash);
SyntaxHighlighter.registerLanguage("shell", langBash);
SyntaxHighlighter.registerLanguage("zsh", langBash);
SyntaxHighlighter.registerLanguage("c", langC);
SyntaxHighlighter.registerLanguage("cpp", langCpp);
SyntaxHighlighter.registerLanguage("c++", langCpp);
SyntaxHighlighter.registerLanguage("csharp", langCsharp);
SyntaxHighlighter.registerLanguage("cs", langCsharp);
SyntaxHighlighter.registerLanguage("css", langCss);
SyntaxHighlighter.registerLanguage("diff", langDiff);
SyntaxHighlighter.registerLanguage("docker", langDocker);
SyntaxHighlighter.registerLanguage("dockerfile", langDocker);
SyntaxHighlighter.registerLanguage("go", langGo);
SyntaxHighlighter.registerLanguage("graphql", langGraphql);
SyntaxHighlighter.registerLanguage("java", langJava);
SyntaxHighlighter.registerLanguage("javascript", langJavascript);
SyntaxHighlighter.registerLanguage("js", langJavascript);
SyntaxHighlighter.registerLanguage("json", langJson);
SyntaxHighlighter.registerLanguage("json5", langJson);
SyntaxHighlighter.registerLanguage("jsx", langJsx);
SyntaxHighlighter.registerLanguage("kotlin", langKotlin);
SyntaxHighlighter.registerLanguage("kt", langKotlin);
SyntaxHighlighter.registerLanguage("markdown", langMarkdown);
SyntaxHighlighter.registerLanguage("md", langMarkdown);
SyntaxHighlighter.registerLanguage("markup", langMarkup);
SyntaxHighlighter.registerLanguage("html", langMarkup);
SyntaxHighlighter.registerLanguage("xml", langMarkup);
SyntaxHighlighter.registerLanguage("svg", langMarkup);
SyntaxHighlighter.registerLanguage("php", langPhp);
SyntaxHighlighter.registerLanguage("python", langPython);
SyntaxHighlighter.registerLanguage("py", langPython);
SyntaxHighlighter.registerLanguage("rust", langRust);
SyntaxHighlighter.registerLanguage("rs", langRust);
SyntaxHighlighter.registerLanguage("scss", langScss);
SyntaxHighlighter.registerLanguage("sass", langScss);
SyntaxHighlighter.registerLanguage("sql", langSql);
SyntaxHighlighter.registerLanguage("swift", langSwift);
SyntaxHighlighter.registerLanguage("toml", langToml);
SyntaxHighlighter.registerLanguage("tsx", langTsx);
SyntaxHighlighter.registerLanguage("typescript", langTypescript);
SyntaxHighlighter.registerLanguage("ts", langTypescript);
SyntaxHighlighter.registerLanguage("yaml", langYaml);
SyntaxHighlighter.registerLanguage("yml", langYaml);

/**
 * 主题(light/dark)单例 store。
 * 之前每个 <Markdown> 实例都会建一个 MutationObserver,一屏 50 条消息 = 50 个 observer;
 * 改成模块级单例 + useSyncExternalStore,所有订阅者共享一份观察器。
 */
const themeStore = (() => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  let cached = false;
  let observer: MutationObserver | null = null;

  const compute = () =>
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";

  const ensureObserver = () => {
    if (observer || typeof document === "undefined") return;
    cached = compute();
    observer = new MutationObserver(() => {
      const next = compute();
      if (next !== cached) {
        cached = next;
        for (const l of listeners) l();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  };

  return {
    subscribe(l: Listener): () => void {
      ensureObserver();
      listeners.add(l);
      return () => {
        listeners.delete(l);
        // 没人订阅了就拆掉 observer,留好资源(下次有人订阅再 ensureObserver)
        if (listeners.size === 0 && observer) {
          observer.disconnect();
          observer = null;
        }
      };
    },
    getSnapshot(): boolean {
      // SSR 期不能访问 DOM,用 cached 默认 false
      return cached;
    },
    getServerSnapshot(): boolean {
      return false;
    },
  };
})();

function useIsLight(): boolean {
  return useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    themeStore.getServerSnapshot
  );
}

interface Props {
  text: string;
  /** small=用于 tool 渲染器里，字体小一号 */
  size?: "normal" | "small";
  /**
   * 流式中:该消息还在 token-by-token 接收。此时不走 ReactMarkdown,
   * 直接 <pre> 显示纯文本。流完(message_end)后切回完整 markdown。
   * 收益:每 token 不再全文 re-parse + Prism re-tokenize。
   */
  streaming?: boolean;
  /** 当前会话 cwd:用于把消息里出现的相对图片路径解析成绝对路径并自动渲染 */
  cwd?: string;
  /** http(s) 链接点击处理；聊天区用于改走右侧 Browser Panel */
  onOpenUrl?: (href: string) => void;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)\b/i;
/**
 * 识别消息文本中的本地图片绝对路径,把它(以及 `路径`、 ![](路径) 形态)
 * 统一规范为 ![](api-url) ,让 ReactMarkdown 自然渲染成图片。
 *
 * 规则:
 * - 已经是 ![](...) 的不动
 * - inline code(反引号)里若是本地图片绝对路径,展开成图片
 * - 裸文本里独立成"词"的本地绝对路径(/ 开头,以图片扩展名结尾) → 图片
 * - 其他形式(URL 链接、相对路径)不处理,交给 markdown 原生处理
 */
function inlineLocalImages(input: string, cwd?: string): string {
  // 把"路径"规范成绝对路径:绝对路径直接用,相对路径前面拼 cwd
  const toAbs = (p: string): string | null => {
    if (p.startsWith("/")) return p;
    if (!cwd) return null;
    const clean = p.replace(/^\.\/+/, "");
    return cwd.endsWith("/") ? cwd + clean : cwd + "/" + clean;
  };
  const toUrl = (abs: string): string =>
    `/api/files?path=${encodeURIComponent(abs)}&raw=1`;

  // 1) inline code 形态:`abs.png` 或 `relative/path.png`
  let out = input.replace(/`([^`\n]+\.[a-z0-9]+)`/gi, (m, p1: string) => {
    if (!IMAGE_EXT_RE.test(p1)) return m;
    if (/^https?:\/\//i.test(p1)) return m;
    const abs = toAbs(p1);
    if (!abs) return m;
    return `![](${toUrl(abs)})`;
  });
  // 2) 裸路径:绝对路径(/ 开头)
  out = out.replace(
    /(^|\s)(\/[^\s)\]]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif))(?=\s|$|[)\].,;])/gi,
    (_m, pre: string, p1: string) => `${pre}![](${toUrl(p1)})`
  );
  // 3) 裸路径:相对路径(只有给了 cwd 才认),要求至少一个斜杠避免误伤纯文件名
  if (cwd) {
    out = out.replace(
      /(^|\s)((?:\.\/)?[\w][\w./-]*\/[\w./-]*\.(?:png|jpe?g|gif|webp|svg|bmp|avif))(?=\s|$|[)\].,;])/gi,
      (m, pre: string, p1: string) => {
        if (p1.startsWith("/")) return m;
        const abs = toAbs(p1);
        if (!abs) return m;
        return `${pre}![](${toUrl(abs)})`;
      }
    );
  }
  return out;
}

function MarkdownInner({
  text,
  size = "normal",
  streaming = false,
  cwd,
  onOpenUrl,
}: Props) {
  const isLight = useIsLight();
  const codeStyle = isLight ? oneLight : oneDark;
  const proseSize = size === "small" ? "prose-xs" : "prose-sm";
  const processedText = useMemo(
    () => (streaming ? text : inlineLocalImages(text, cwd)),
    [text, cwd, streaming]
  );

  return (
    <div
      className={`prose ${proseSize} max-w-none break-words
        prose-pre:!bg-transparent prose-pre:!p-0
        prose-code:before:hidden prose-code:after:hidden
        ${isLight ? "prose-neutral" : "prose-invert"}`}
    >
      {streaming ? (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            fontFamily: "inherit",
            fontSize: size === "small" ? 12 : 14,
            lineHeight: 1.65,
            color: "var(--text)",
          }}
        >
          {processedText}
        </pre>
      ) : (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: {
            inline?: boolean;
            className?: string;
            children?: React.ReactNode;
          }) {
            const match = /language-(\w+)/.exec(className || "");
            const codeText = String(children ?? "").replace(/\n$/, "");
            const isBlockCode = Boolean(match) || codeText.includes("\n");
            if (!inline && isBlockCode) {
              return (
                <CodeBlockWithHeader
                  code={codeText}
                  lang={match?.[1] ?? "text"}
                  style={codeStyle}
                  fontSize={size === "small" ? 11 : 12.5}
                />
              );
            }
            return (
              <code
                {...props}
                style={{
                  background: "var(--bg-selected)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.9em",
                  padding: "1px 4px",
                  borderRadius: 3,
                }}
              >
                {children}
              </code>
            );
          },
          a({ children, href, ...props }) {
            const isHttp = typeof href === "string" && /^https?:\/\//i.test(href);
            return (
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
                <a
                  {...props}
                  href={href}
                  target={onOpenUrl && isHttp ? undefined : "_blank"}
                  rel={onOpenUrl && isHttp ? undefined : "noopener noreferrer"}
                  onClick={
                    onOpenUrl && isHttp
                      ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenUrl(href);
                        }
                      : undefined
                  }
                  className="text-[color:var(--accent)] hover:underline"
                >
                  {children}
                </a>
                {isHttp && !onOpenUrl && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      previewStore.openUrl(href!);
                    }}
                    title="在右侧预览"
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--accent)",
                      cursor: "pointer",
                      fontSize: "0.85em",
                      padding: 0,
                    }}
                  >
                    ⧉
                  </button>
                )}
              </span>
            );
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          img({ src, alt, node: _node, ...rest }) {
            const s = typeof src === "string" ? src : "";
            return (
               
              <Image
                {...rest}
                src={s}
                alt={alt ?? ""}
                width={960}
                height={640}
                unoptimized
                onClick={() => {
                  if (s) previewStore.openImage(s, alt || "图片");
                }}
                style={{
                  cursor: "zoom-in",
                  maxWidth: "100%",
                  borderRadius: 6,
                  ...(rest.style || {}),
                }}
              />
            );
          },
        }}
      >
        {processedText}
      </ReactMarkdown>
      )}
    </div>
  );
}

// P2-H: 包一层 React.memo。默认 shallow 比较 props（text/cwd/streaming/size/onOpenUrl），
// 不变则跳过重新渲染。主题变化仍由 useIsLight 的订阅触发。
const Markdown = memo(MarkdownInner);
export default Markdown;

const COLLAPSED_LINES = 12;

function CodeBlockWithHeader({
  code,
  lang,
  style,
  fontSize,
}: {
  code: string;
  lang: string;
  style: { [k: string]: React.CSSProperties };
  fontSize: number;
}) {
  const [copied, setCopied] = useState(false);
  const totalLines = useMemo(() => code.split("\n").length, [code]);
  const canCollapse = totalLines > COLLAPSED_LINES;
  const [expanded, setExpanded] = useState(!canCollapse);
  const [inlineRender, setInlineRender] = useState(false);
  const isHtml = /^x?html?$/i.test(lang);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const lineHeight = 1.6;
  const collapsedHeight =
    Math.round(fontSize * lineHeight * COLLAPSED_LINES) + 20; // padding 10*2

  return (
    <div
      style={{
        position: "relative",
        marginTop: 4,
        marginBottom: 4,
        borderRadius: 6,
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          padding: "3px 10px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>
          {lang}
          {canCollapse && (
            <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
              · {totalLines} 行
            </span>
          )}
        </span>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {isHtml && (
            <>
              <button
                type="button"
                onClick={() => setInlineRender((v) => !v)}
                style={btnStyle(inlineRender ? "var(--accent)" : "var(--text-muted)")}
                title={inlineRender ? "隐藏内联渲染" : "在此处渲染 HTML"}
              >
                {inlineRender ? "源码" : "渲染"}
              </button>
              <button
                type="button"
                onClick={() => previewStore.openHtml(code)}
                style={btnStyle("var(--accent)")}
                title="在右侧预览渲染结果(可独立大屏查看)"
              >
                preview →
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onCopy}
            style={btnStyle("var(--text-muted)")}
          >
            {copied ? "copied" : "copy"}
          </button>
        </span>
      </div>

      {inlineRender && isHtml ? (
        <iframe
          title={`inline-html-preview`}
          srcDoc={code}
          // fix-S4.a：安全收敛。模型输出的 HTML 仅用于预览，不应该能提交
          // 表单（重鬼鱼遇模型出的链接）或将 referrer 泄漏到第三方。
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            height: 360,
            border: "none",
            background: "var(--browser-preview-bg)",
            display: "block",
          }}
        />
      ) : (
        <div
          style={{
            position: "relative",
            maxHeight: expanded ? undefined : collapsedHeight,
            overflow: expanded ? "visible" : "hidden",
          }}
        >
          <SyntaxHighlighter
            language={lang || "text"}
            style={style}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: "10px 12px",
              fontSize,
              lineHeight,
              borderRadius: 0,
              background: "var(--bg)",
            }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
          >
            {code}
          </SyntaxHighlighter>
          {!expanded && canCollapse && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 64,
                pointerEvents: "none",
                background:
                  "linear-gradient(to bottom, color-mix(in srgb, var(--bg) 0%, transparent) 0%, var(--bg) 90%)",
              }}
            />
          )}
        </div>
      )}

      {canCollapse && !inlineRender && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            width: "100%",
            padding: "4px 10px",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
            border: 0,
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "var(--border)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            display: "block",
            textAlign: "center",
          }}
        >
          {expanded
            ? `▲ 收起(显示前 ${COLLAPSED_LINES} 行)`
            : `▼ 展开剩余 ${totalLines - COLLAPSED_LINES} 行`}
        </button>
      )}
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: "none",
    border: "none",
    color,
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    padding: 0,
  };
}
