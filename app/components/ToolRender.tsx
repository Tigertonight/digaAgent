"use client";

/**
 * Tool 调用渲染器。
 * 按 toolName 分流到不同的 sub-renderer，未识别的走 GenericTool。
 *
 * SDK 的 tool args/result 结构基于具体 tool，所以这里都按 unknown 处理，
 * 内部用宽松的取值。后续可以根据 ToolRegistry 类型严格化。
 */
import Image from "next/image";
import { useState } from "react";
import type { MessagePart } from "@/lib/types";
import { unifiedDiff, isNoChange, type DiffLine } from "@/lib/diff-utils";
import { previewStore } from "@/lib/preview-store";
import {
  asString,
  extractTextFromResult,
  getArg,
  narrateTool,
} from "@/lib/narration/tool";

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
  const color =
    status === "running"
      ? "var(--text-muted)"
      : status === "error"
        ? "var(--color-danger)"
        : "var(--text-dim)";
  return (
    <span
      className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
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
  const narration = narrateTool(tool);
  if (narration.hidden) return null;
  return (
    <div
      className="group/tool rounded-md border text-xs transition-colors"
      style={{
        borderColor: open ? "var(--border-soft)" : "transparent",
        background: "transparent",
      }}
      data-testid="tool-frame"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-[color:var(--bg-hover)]"
        aria-expanded={open}
      >
        <StatusDot status={tool.status} />
        <span className="min-w-0 flex-1">
          <div className="text-token-sm leading-5" style={{ color: "var(--fg)" }}>
            {narration.primary}
          </div>
          {narration.secondary ? (
            <div
              className="mt-0.5 text-token-xs leading-4"
              style={{ color: "var(--fg-faint)" }}
            >
              {narration.secondary}
            </div>
          ) : null}
          {narration.recovery ? (
            <div
              className="mt-0.5 text-token-xs leading-4"
              style={{
                color: "var(--text-muted)",
              }}
            >
              {narration.recovery}
            </div>
          ) : null}
        </span>
        <span
          className="mt-0.5 flex shrink-0 items-center gap-1 text-token-xs opacity-0 transition-opacity group-hover/tool:opacity-100"
          style={{ color: "var(--text-muted)" }}
        >
          {open ? "收起" : "详情"}
          <span aria-hidden>{open ? "⌄" : "›"}</span>
        </span>
      </button>
      {open && children && (
        <div
          className="mx-4 mb-2 mt-0.5 border-l pl-3"
          style={{ borderColor: "var(--border-soft)" }}
          data-testid="tool-detail"
        >
          <div className="mb-1 flex items-center gap-2 text-token-xs" style={{ color: "var(--text-muted)" }}>
            <span className="font-mono">{tool.toolName}</span>
            <span>{tool.status}</span>
            {subtitle ? <span className="truncate">{subtitle}</span> : null}
            <span className="truncate">{title}</span>
          </div>
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
      className="text-token-xs leading-[1.45] overflow-auto rounded p-2 whitespace-pre"
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
          className="px-1.5 py-0.5 rounded text-token-xs border"
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
      className="rounded overflow-auto text-token-xs leading-[1.45]"
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
            ? "var(--color-success-bg)"
            : l.kind === "del"
            ? "var(--color-danger-bg)"
            : "transparent";
        const fg =
          l.kind === "add"
            ? "var(--color-success)"
            : l.kind === "del"
            ? "var(--color-danger)"
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

function errorBanner(tool: ToolPart) {
  if (!tool.isError) return null;
  return (
    <div className="mb-1 rounded-[var(--radius-sm)] border border-[color:var(--color-danger)] bg-[color:var(--color-danger-bg)] px-1.5 py-1 text-token-xs text-[color:var(--color-danger)]">
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
          <button
            key={i}
            type="button"
            onClick={() => previewStore.openImage(src, `tool image ${i + 1}`)}
            className="block rounded overflow-hidden border p-0"
            style={{ borderColor: "var(--border-soft)", background: "none", cursor: "zoom-in" }}
          >
            <Image
              src={src}
              alt={`tool image ${i + 1}`}
              width={320}
              height={320}
              unoptimized
              style={{ maxWidth: 320, maxHeight: 320, display: "block", objectFit: "contain" }}
            />
          </button>
        );
      })}
    </div>
  );
}

/** 当 result 是 SDK content-block 数组（[{type:"text",text}, {type:"image",...}]），抽出 text 部分。 */
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
            className="text-token-xs px-2 py-1 rounded"
            style={{ background: "var(--bg-app)", color: "var(--fg-faint)" }}
          >
            No changes
          </div>
        ) : (
          <DiffView lines={unifiedDiff(oldStr, newStr)} />
        ))}
      {mode === "code" && (
        <div className="space-y-1">
          <div className="text-token-xs opacity-60">- old</div>
          <pre
            className="text-token-xs overflow-auto rounded p-2 whitespace-pre"
            style={{
              background: "var(--color-danger-bg)",
              border: "1px solid var(--color-danger)",
              maxHeight: 200,
            }}
          >
            {oldStr || "(empty)"}
          </pre>
          <div className="text-token-xs opacity-60">+ new</div>
          <pre
            className="text-token-xs overflow-auto rounded p-2 whitespace-pre"
            style={{
              background: "var(--color-success-bg)",
              border: "1px solid var(--color-success)",
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
            background: "var(--browser-preview-bg)",
            borderRadius: "var(--radius-xs)",
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
          <div className="text-token-xs opacity-60 mb-1">args</div>
          <CodeBlock text={argsStr} maxHeight={160} />
        </>
      )}
      {resultStr && (
        <>
          <div className="text-token-xs opacity-60 mt-1 mb-1">result</div>
          <CodeBlock text={resultStr} />
        </>
      )}
    </ToolFrame>
  );
}
