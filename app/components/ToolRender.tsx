"use client";

/**
 * Tool 调用渲染器。
 * 按 toolName 分流到不同的 sub-renderer，未识别的走 GenericTool。
 *
 * SDK 的 tool args/result 结构基于具体 tool，所以这里都按 unknown 处理，
 * 内部用宽松的取值。后续可以根据 ToolRegistry 类型严格化。
 */
import { useState } from "react";
import type { MessagePart } from "@/lib/types";
import { unifiedDiff, isNoChange, type DiffLine } from "@/lib/diff-utils";

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

interface Props {
  tool: ToolPart;
}

export default function ToolRender({ tool }: Props) {
  const name = (tool.toolName || "").toLowerCase();
  switch (name) {
    case "read":
    case "read_file":
      return <ReadTool tool={tool} />;
    case "edit":
    case "edit_file":
    case "str_replace":
      return <EditTool tool={tool} />;
    case "write":
    case "write_file":
    case "create_file":
      return <WriteTool tool={tool} />;
    case "bash":
    case "shell":
    case "exec":
      return <BashTool tool={tool} />;
    case "grep":
    case "search":
      return <GrepTool tool={tool} />;
    case "find":
    case "glob":
      return <FindTool tool={tool} />;
    case "ls":
    case "list":
    case "list_directory":
      return <LsTool tool={tool} />;
    default:
      return <GenericTool tool={tool} />;
  }
}

/* ---------- 共用 ---------- */

function StatusDot({ status }: { status: ToolPart["status"] }) {
  const cls =
    status === "running"
      ? "bg-yellow-500 animate-pulse"
      : status === "error"
      ? "bg-red-500"
      : "bg-emerald-500";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />;
}

function ToolFrame({
  tool,
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  tool: ToolPart;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // 按状态染色：success 绿、error 红、running 黄；保留 idle/done 兜底
  const tone =
    tool.status === "error"
      ? {
          border: "rgba(248,113,113,0.45)",
          bg: "rgba(248,113,113,0.05)",
        }
      : tool.status === "running"
      ? {
          border: "rgba(234,179,8,0.35)",
          bg: "rgba(234,179,8,0.05)",
        }
      : {
          border: "rgba(34,197,94,0.25)",
          bg: "rgba(34,197,94,0.04)",
        };
  return (
    <div
      className="rounded border my-1 text-xs"
      style={{
        borderColor: tone.border,
        background: tone.bg,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2 py-1.5 flex items-center gap-2 text-left hover:opacity-80"
      >
        <StatusDot status={tool.status} />
        <span className="font-mono text-[11px] opacity-70">{tool.toolName}</span>
        <span className="truncate flex-1" style={{ color: "var(--fg)" }}>
          {title}
        </span>
        {subtitle && (
          <span className="text-[10px] opacity-60 shrink-0">{subtitle}</span>
        )}
        <span className="text-[10px] opacity-50 shrink-0">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && children && (
        <div
          className="px-2 py-1.5 border-t"
          style={{ borderColor: tone.border }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function CodeBlock({
  text,
  lang,
  maxHeight = 320,
}: {
  text: string;
  lang?: string;
  maxHeight?: number;
}) {
  return (
    <pre
      className="text-[11px] leading-[1.45] overflow-auto rounded p-2 whitespace-pre"
      style={{
        background: "var(--bg-app)",
        maxHeight,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      }}
      data-lang={lang}
    >
      {text}
    </pre>
  );
}

function ViewModeSwitch({
  mode,
  modes,
  onChange,
}: {
  mode: string;
  modes: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 mb-1.5">
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className="px-1.5 py-0.5 rounded text-[10px] border"
          style={{
            borderColor: "var(--border-soft)",
            background:
              mode === m.id ? "var(--bg-app)" : "transparent",
            color: mode === m.id ? "var(--fg)" : "var(--fg-faint)",
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div
      className="rounded overflow-auto text-[11px] leading-[1.45]"
      style={{
        background: "var(--bg-app)",
        maxHeight: 360,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      }}
    >
      {lines.map((l, i) => {
        const bg =
          l.kind === "add"
            ? "rgba(34,197,94,0.10)"
            : l.kind === "del"
            ? "rgba(239,68,68,0.10)"
            : "transparent";
        const fg =
          l.kind === "add"
            ? "rgb(134,239,172)"
            : l.kind === "del"
            ? "rgb(252,165,165)"
            : "var(--fg-faint)";
        const prefix =
          l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
        const oldNo = "oldNo" in l ? String(l.oldNo || "") : "";
        const newNo = "newNo" in l ? String(l.newNo || "") : "";
        return (
          <div
            key={i}
            className="flex whitespace-pre"
            style={{ background: bg, color: fg }}
          >
            <span
              className="select-none px-1 text-right shrink-0 opacity-50"
              style={{ width: 32 }}
            >
              {oldNo}
            </span>
            <span
              className="select-none px-1 text-right shrink-0 opacity-50"
              style={{ width: 32 }}
            >
              {newNo}
            </span>
            <span className="select-none px-1 shrink-0 opacity-70">
              {prefix}
            </span>
            <span className="flex-1 pr-2">{l.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function getArg(args: unknown, ...keys: string[]): unknown {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function errorBanner(tool: ToolPart) {
  if (!tool.isError) return null;
  return (
    <div className="mb-1 px-1.5 py-1 rounded text-[11px] text-red-200 bg-red-900/30 border border-red-700">
      tool error
    </div>
  );
}

interface ImageBlock {
  data: string;
  mimeType: string;
}

function extractImages(result: unknown): ImageBlock[] {
  if (!Array.isArray(result)) return [];
  const out: ImageBlock[] = [];
  for (const item of result) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "image"
    ) {
      const data = (item as { data?: unknown }).data;
      const mimeType = (item as { mimeType?: unknown }).mimeType;
      if (typeof data === "string" && typeof mimeType === "string") {
        out.push({ data, mimeType });
      }
    }
  }
  return out;
}

function ToolImages({ tool }: { tool: ToolPart }) {
  const images = extractImages(tool.result ?? tool.partialResult);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-1.5">
      {images.map((img, i) => {
        const src = `data:${img.mimeType};base64,${img.data}`;
        return (
          <a
            key={i}
            href={src}
            target="_blank"
            rel="noreferrer"
            className="block rounded overflow-hidden border"
            style={{ borderColor: "var(--border-soft)" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={`tool image ${i + 1}`}
              style={{ maxWidth: 320, maxHeight: 320, display: "block" }}
            />
          </a>
        );
      })}
    </div>
  );
}

/** 当 result 是 SDK content-block 数组（[{type:"text",text}, {type:"image",...}]），抽出 text 部分。 */
function extractTextFromResult(result: unknown): string {
  if (!Array.isArray(result)) return "";
  const texts: string[] = [];
  for (const item of result) {
    if (item && typeof item === "object") {
      const t = (item as { type?: unknown }).type;
      if (t === "text") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  return texts.join("\n");
}

/** 优先从 content-block 数组抽 text；否则走老逻辑。 */
function resultToText(result: unknown, fallback: string): string {
  if (typeof result === "string") return result;
  const fromBlocks = extractTextFromResult(result);
  if (fromBlocks) return fromBlocks;
  return fallback;
}

/* ---------- 具体渲染器 ---------- */

function ReadTool({ tool }: { tool: ToolPart }) {
  const path = asString(getArg(tool.args, "path", "file_path", "file"));
  const offset = getArg(tool.args, "offset");
  const limit = getArg(tool.args, "limit");
  const result = tool.result ?? tool.partialResult;
  const fallback = asString(
    (result as { content?: unknown; text?: unknown })?.content ??
      (result as { text?: unknown })?.text ??
      result
  );
  const content = resultToText(result, fallback);
  return (
    <ToolFrame
      tool={tool}
      title={path || "(no path)"}
      subtitle={
        offset != null || limit != null ? `lines ${offset ?? 0}+${limit ?? "?"}` : undefined
      }
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={content || "(empty)"} />
    </ToolFrame>
  );
}

function EditTool({ tool }: { tool: ToolPart }) {
  const path = asString(getArg(tool.args, "path", "file_path", "file"));
  const oldStr = asString(getArg(tool.args, "oldString", "old_string", "old"));
  const newStr = asString(getArg(tool.args, "newString", "new_string", "new"));
  const [mode, setMode] = useState<"diff" | "code" | "raw">("diff");
  const noChange = isNoChange(oldStr, newStr);
  return (
    <ToolFrame tool={tool} title={path || "(no path)"} subtitle="edit">
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <ViewModeSwitch
        mode={mode}
        modes={[
          { id: "diff", label: "Diff" },
          { id: "code", label: "Code" },
          { id: "raw", label: "Raw" },
        ]}
        onChange={(m) => setMode(m as typeof mode)}
      />
      {mode === "diff" &&
        (noChange ? (
          <div
            className="text-[11px] px-2 py-1 rounded"
            style={{ background: "var(--bg-app)", color: "var(--fg-faint)" }}
          >
            No changes
          </div>
        ) : (
          <DiffView lines={unifiedDiff(oldStr, newStr)} />
        ))}
      {mode === "code" && (
        <div className="space-y-1">
          <div className="text-[10px] opacity-60">- old</div>
          <pre
            className="text-[11px] overflow-auto rounded p-2 whitespace-pre"
            style={{
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.25)",
              maxHeight: 200,
            }}
          >
            {oldStr || "(empty)"}
          </pre>
          <div className="text-[10px] opacity-60">+ new</div>
          <pre
            className="text-[11px] overflow-auto rounded p-2 whitespace-pre"
            style={{
              background: "rgba(34,197,94,0.08)",
              border: "1px solid rgba(34,197,94,0.25)",
              maxHeight: 200,
            }}
          >
            {newStr || "(empty)"}
          </pre>
        </div>
      )}
      {mode === "raw" && (
        <CodeBlock
          text={JSON.stringify({ path, old: oldStr, new: newStr }, null, 2)}
        />
      )}
    </ToolFrame>
  );
}

function WriteTool({ tool }: { tool: ToolPart }) {
  const path = asString(getArg(tool.args, "path", "file_path", "file"));
  const content = asString(getArg(tool.args, "content", "text"));
  const isHtml = /\.(html?|xhtml)$/i.test(path);
  const [mode, setMode] = useState<"code" | "preview" | "raw">("code");
  const modes = isHtml
    ? [
        { id: "code", label: "Code" },
        { id: "preview", label: "Preview" },
        { id: "raw", label: "Raw" },
      ]
    : [
        { id: "code", label: "Code" },
        { id: "raw", label: "Raw" },
      ];
  return (
    <ToolFrame tool={tool} title={path || "(no path)"} subtitle="write">
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <ViewModeSwitch
        mode={mode}
        modes={modes}
        onChange={(m) => setMode(m as typeof mode)}
      />
      {mode === "code" && <CodeBlock text={content || "(empty)"} />}
      {mode === "preview" && isHtml && (
        <iframe
          title={path}
          srcDoc={content}
          sandbox=""
          style={{
            width: "100%",
            height: 320,
            border: "1px solid var(--border-soft)",
            background: "#fff",
            borderRadius: 4,
          }}
        />
      )}
      {mode === "raw" && (
        <CodeBlock text={JSON.stringify({ path, content }, null, 2)} />
      )}
    </ToolFrame>
  );
}

function BashTool({ tool }: { tool: ToolPart }) {
  const cmd = asString(getArg(tool.args, "command", "cmd"));
  const desc = asString(getArg(tool.args, "description", "desc"));
  const result = tool.result ?? tool.partialResult;
  const fallback = asString(
    (result as { stdout?: unknown })?.stdout ??
      (result as { output?: unknown })?.output ??
      result
  );
  const stdout = resultToText(result, fallback);
  return (
    <ToolFrame
      tool={tool}
      title={cmd ? `$ ${cmd}` : "(no command)"}
      subtitle={desc || undefined}
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={stdout || "(no output yet)"} />
    </ToolFrame>
  );
}

function GrepTool({ tool }: { tool: ToolPart }) {
  const pattern = asString(getArg(tool.args, "pattern", "query"));
  const path = asString(getArg(tool.args, "path", "dir"));
  const include = asString(getArg(tool.args, "include", "glob"));
  const result = tool.result ?? tool.partialResult;
  const fallback = asString(
    (result as { matches?: unknown })?.matches ??
      (result as { output?: unknown })?.output ??
      result
  );
  const text = resultToText(result, fallback);
  return (
    <ToolFrame
      tool={tool}
      title={pattern ? `/${pattern}/` : "(no pattern)"}
      subtitle={[path, include].filter(Boolean).join(" · ") || undefined}
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={text || "(no matches)"} />
    </ToolFrame>
  );
}

function FindTool({ tool }: { tool: ToolPart }) {
  const pattern = asString(getArg(tool.args, "pattern", "glob"));
  const path = asString(getArg(tool.args, "path", "dir"));
  const result = tool.result ?? tool.partialResult;
  const text = resultToText(result, asString(result));
  return (
    <ToolFrame tool={tool} title={pattern || "(no pattern)"} subtitle={path || undefined}>
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={text || "(none)"} />
    </ToolFrame>
  );
}

function LsTool({ tool }: { tool: ToolPart }) {
  const path = asString(getArg(tool.args, "path", "dir"));
  const result = tool.result ?? tool.partialResult;
  const text = resultToText(result, asString(result));
  return (
    <ToolFrame tool={tool} title={path || "."} subtitle="ls">
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={text || "(empty)"} />
    </ToolFrame>
  );
}

function GenericTool({ tool }: { tool: ToolPart }) {
  const argsStr = asString(tool.args);
  const result = tool.result ?? tool.partialResult;
  const hasImages = extractImages(result).length > 0;
  const textFromBlocks = extractTextFromResult(result);
  // 如果 result 已经是 SDK content-block 数组（含图片或纯 text 块），优先用文本部分；
  // 否则保留老的 JSON dump 行为，便于排查未知 tool 的结构。
  const resultStr = hasImages || textFromBlocks
    ? textFromBlocks
    : asString(result);
  return (
    <ToolFrame tool={tool} title={tool.toolName} subtitle={tool.status}>
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      {argsStr && argsStr !== "{}" && (
        <>
          <div className="text-[10px] opacity-60 mb-1">args</div>
          <CodeBlock text={argsStr} maxHeight={160} />
        </>
      )}
      {resultStr && (
        <>
          <div className="text-[10px] opacity-60 mt-1 mb-1">result</div>
          <CodeBlock text={resultStr} />
        </>
      )}
    </ToolFrame>
  );
}
