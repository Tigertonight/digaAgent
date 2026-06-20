"use client";

/**
 * Tool 调用渲染器。
 * 按 toolName 分流到不同的 sub-renderer，未识别的走 GenericTool。
 *
 * SDK 的 tool args/result 结构基于具体 tool，所以这里都按 unknown 处理，
 * 内部用宽松的取值。后续可以根据 ToolRegistry 类型严格化。
 */
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { MessagePart } from "@/lib/types";
import { unifiedDiff, isNoChange, type DiffLine } from "@/lib/diff-utils";
import { previewStore } from "@/lib/preview-store";
import {
  asString,
  extractTextFromResult,
  getArg,
  isWorthNarrating,
  narrateTool,
  shouldHideTool,
} from "@/lib/narration/tool";
import { redactSecrets } from "@/lib/narration/redact";
import { toolStatusLabel } from "@/lib/i18n/phase-label";
import { diagnoseToolTruncation } from "@/lib/tool-recovery/truncation-diagnosis";
import { requestToolNarration } from "@/app/lib/narration-client";

type ToolPart = Extract<MessagePart, { kind: "tool" }>;
type ToolRenderProps = {
  tool: ToolPart;
  questionContext?: string;
  recovered?: boolean;
};

interface Props {
  tool: ToolPart;
  questionContext?: string;
  recovered?: boolean;
}

export default function ToolRender({ tool, questionContext, recovered = false }: Props) {
  // Phase 2 降噪：内部治理类 tool（update_progress / goal_update / Process: xxx 等）
  // 不在主视图里占一行。这些序列仍会被 CollapsedPartProcessGroup 计入组总数，
  // 但展开面上不会重复占位。
  if (shouldHideTool(tool)) return null;
  const name = (tool.toolName || "").toLowerCase();
  switch (name) {
    case "read":
    case "read_file":
      return <ReadTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    case "edit":
    case "edit_file":
    case "str_replace":
      return <EditTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    case "write":
    case "write_file":
    case "create_file":
      return <WriteTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    case "bash":
    case "shell":
    case "exec":
      return <BashTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    case "grep":
    case "search":
      return <GrepTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    case "find":
    case "glob":
      return <FindTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    case "ls":
    case "list":
    case "list_directory":
      return <LsTool tool={tool} questionContext={questionContext} recovered={recovered} />;
    default:
      return <GenericTool tool={tool} questionContext={questionContext} recovered={recovered} />;
  }
}

/* ---------- 共用 ---------- */

function StatusDot({
  status,
  recovered,
}: {
  status: ToolPart["status"];
  recovered?: boolean;
}) {
  const color =
    recovered
      ? "var(--text-dim)"
      : status === "queued"
      ? "var(--text-muted)"
      : status === "running"
      ? "var(--text-muted)"
      : status === "error"
        ? "var(--color-danger)"
        : status === "timeout"
          ? "var(--warning, #b8860b)"
          : status === "cancelled"
            ? "var(--text-dim)"
        : "var(--text-dim)";
  return (
    <span className="mt-[7px] inline-flex shrink-0 items-center">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      <span className="sr-only" role="status" aria-live="polite">
        {toolStatusLabel(status)}
      </span>
    </span>
  );
}

function ToolFrame({
  tool,
  title,
  subtitle,
  defaultOpen = false,
  children,
  questionContext,
  recovered = false,
}: {
  tool: ToolPart;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  questionContext?: string;
  recovered?: boolean;
}) {
  const shouldAutoOpen =
    defaultOpen ||
    tool.status === "error" ||
    tool.status === "timeout" ||
    tool.status === "cancelled" ||
    Boolean(tool.isError || tool.truncation);
  const [open, setOpen] = usePersistedDisclosure(
    `tool:${tool.toolName}:${tool.toolCallId}`,
    shouldAutoOpen
  );
  const narration = useMemo(() => narrateTool(tool), [tool]);
  const narrationKey = useMemo(
    () =>
      `${tool.toolCallId}:${tool.toolName}:${tool.status}:${JSON.stringify(tool.args ?? {})}:${questionContext ?? ""}`,
    [questionContext, tool.args, tool.status, tool.toolCallId, tool.toolName]
  );
  const [enhancedPrimary, setEnhancedPrimary] = useState<{
    key: string;
    text: string;
  } | null>(null);
  useEffect(() => {
    if (narration.hidden || !isWorthNarrating(tool)) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1400);
    requestToolNarration({
      id: narrationKey,
      question: questionContext || "",
      locale: navigator.language || "zh-CN",
      ruleText: narration.primary,
      tool: {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: tool.args,
        status: tool.status,
        isError: tool.isError,
      },
      signal: controller.signal,
    })
      .then((text) => {
        if (text) setEnhancedPrimary({ key: narrationKey, text });
      })
      .catch(() => {
        /* rule narration is the fallback */
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [narration.hidden, narration.primary, narrationKey, questionContext, tool]);
  if (narration.hidden) return null;
  const basePrimary =
    enhancedPrimary?.key === narrationKey
      ? enhancedPrimary.text
      : narration.primary;
  const displayPrimary = recovered ? recoveredNarration(basePrimary) : basePrimary;
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
        aria-busy={tool.status === "running" || tool.status === "queued"}
      >
        <StatusDot status={tool.status} recovered={recovered} />
        <span className="min-w-0 flex-1">
          <div className="text-token-sm leading-5" style={{ color: "var(--fg)" }}>
            {displayPrimary}
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
        {recovered ? (
          <span
            className="mt-0.5 shrink-0 rounded-token-sm border px-1.5 py-0.5 text-token-xs"
            style={{
              borderColor: "var(--border-soft)",
              color: "var(--text-muted)",
            }}
          >
            已处理
          </span>
        ) : null}
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
            <span>{toolStatusLabel(tool.status)}</span>
            {subtitle ? <span className="truncate">{subtitle}</span> : null}
            <span className="truncate">{title}</span>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

function recoveredNarration(primary: string): string {
  const label = primary.replace(/^执行失败：/, "").trim();
  return label ? `已处理失败：${label}` : "已处理失败";
}

function usePersistedDisclosure(
  key: string,
  defaultOpen: boolean
): [boolean, (updater: boolean | ((value: boolean) => boolean)) => void] {
  const storageKey = `diga:disclosure:${key}`;
  const [open, setOpenState] = useState(defaultOpen);
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      if (stored !== "1" && stored !== "0") return;
      window.queueMicrotask(() => setOpenState(stored === "1"));
    } catch {
      /* sessionStorage can be unavailable in restricted contexts */
    }
  }, [storageKey]);
  const setOpen = (updater: boolean | ((value: boolean) => boolean)) => {
    setOpenState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      try {
        window.sessionStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  return [open, setOpen];
}

function CodeBlock({
  text,
  lang,
  maxHeight = 320,
  redact = true,
}: {
  text: string;
  lang?: string;
  maxHeight?: number;
  redact?: boolean;
}) {
  const redactedText = redact ? redactSecrets(text) : text;
  const hasSensitiveRedaction = redact && redactedText !== text;
  const [showSensitiveRaw, setShowSensitiveRaw] = useState(false);
  const displayText = showSensitiveRaw ? text : redactedText;
  return (
    <div className="space-y-1">
      {hasSensitiveRedaction && (
        <div className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-token-xs"
          style={{
            borderColor: "var(--warning, #b8860b)",
            color: "var(--warning, #b8860b)",
            background: "var(--bg-subtle)",
          }}
        >
          <span>敏感内容已脱敏</span>
          <button
            type="button"
            className="rounded border px-1.5 py-0.5 hover:opacity-85"
            style={{
              borderColor: "var(--warning, #b8860b)",
              color: "var(--warning, #b8860b)",
            }}
            onClick={() => setShowSensitiveRaw((value) => !value)}
          >
            {showSensitiveRaw ? "隐藏原文" : "显示原文（敏感）"}
          </button>
        </div>
      )}
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
        {displayText}
      </pre>
    </div>
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
  const truncation =
    tool.truncation ??
    diagnoseToolTruncation({
      toolName: tool.toolName,
      isError: tool.isError,
      input: tool.args,
      result: tool.result ?? tool.partialResult,
    });
  if (truncation) {
    return (
      <div
        className="mb-1 rounded-[var(--radius-sm)] border px-2 py-1.5 text-token-xs leading-relaxed"
        style={{
          borderColor: "var(--warning, #b8860b)",
          background: "var(--bg-subtle)",
          color: "var(--text)",
        }}
      >
        <div className="font-semibold text-[color:var(--warning,#b8860b)]">
          工具参数被截断
        </div>
        <div>{truncation.userMessage}</div>
        <div className="mt-0.5 text-[color:var(--text-muted)]">
          {truncation.field ? `字段：${truncation.field} · ` : ""}
          策略：{truncation.recommendedStrategy}
        </div>
      </div>
    );
  }
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

function ReadTool({ tool, questionContext, recovered }: ToolRenderProps) {
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
      questionContext={questionContext}
      recovered={recovered}
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

function EditTool({ tool, questionContext, recovered }: ToolRenderProps) {
  const path = asString(getArg(tool.args, "path", "file_path", "file"));
  const oldStr = asString(getArg(tool.args, "oldString", "old_string", "old"));
  const newStr = asString(getArg(tool.args, "newString", "new_string", "new"));
  const redactedOld = redactSecrets(oldStr);
  const redactedNew = redactSecrets(newStr);
  const [mode, setMode] = useState<"diff" | "code" | "raw">("diff");
  const noChange = isNoChange(oldStr, newStr);
  return (
    <ToolFrame
      tool={tool}
      questionContext={questionContext}
      recovered={recovered}
      title={path || "(no path)"}
      subtitle="edit"
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <ViewModeSwitch
        mode={mode}
        modes={[
          { id: "diff", label: "差异" },
          { id: "code", label: "代码" },
          { id: "raw", label: "原始" },
        ]}
        onChange={(m) => setMode(m as typeof mode)}
      />
      {mode === "diff" &&
        (noChange ? (
          <div
            className="text-token-xs px-2 py-1 rounded"
            style={{ background: "var(--bg-app)", color: "var(--fg-faint)" }}
          >
            无变更
          </div>
        ) : (
          <DiffView lines={unifiedDiff(redactedOld, redactedNew)} />
        ))}
      {mode === "code" && (
        <div className="space-y-1">
          <div className="text-token-xs opacity-60">- 旧内容</div>
          <pre
            className="text-token-xs overflow-auto rounded p-2 whitespace-pre"
            style={{
              background: "var(--color-danger-bg)",
              border: "1px solid var(--color-danger)",
              maxHeight: 200,
            }}
          >
            {redactedOld || "(empty)"}
          </pre>
          <div className="text-token-xs opacity-60">+ 新内容</div>
          <pre
            className="text-token-xs overflow-auto rounded p-2 whitespace-pre"
            style={{
              background: "var(--color-success-bg)",
              border: "1px solid var(--color-success)",
              maxHeight: 200,
            }}
          >
            {redactedNew || "(empty)"}
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

function WriteTool({ tool, questionContext, recovered }: ToolRenderProps) {
  const path = asString(getArg(tool.args, "path", "file_path", "file"));
  const content = asString(getArg(tool.args, "content", "text"));
  const isHtml = /\.(html?|xhtml)$/i.test(path);
  const [mode, setMode] = useState<"code" | "preview" | "raw">("code");
  const modes = isHtml
    ? [
        { id: "code", label: "代码" },
        { id: "preview", label: "预览" },
        { id: "raw", label: "原始" },
      ]
    : [
        { id: "code", label: "代码" },
        { id: "raw", label: "原始" },
      ];
  return (
    <ToolFrame
      tool={tool}
      questionContext={questionContext}
      recovered={recovered}
      title={path || "(no path)"}
      subtitle="write"
    >
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

function BashTool({ tool, questionContext, recovered }: ToolRenderProps) {
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
      questionContext={questionContext}
      recovered={recovered}
      title={cmd ? `$ ${cmd}` : "(no command)"}
      subtitle={desc || undefined}
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={stdout || "(no output yet)"} />
    </ToolFrame>
  );
}

function GrepTool({ tool, questionContext, recovered }: ToolRenderProps) {
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
      questionContext={questionContext}
      recovered={recovered}
      title={pattern ? `/${pattern}/` : "(no pattern)"}
      subtitle={[path, include].filter(Boolean).join(" · ") || undefined}
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={text || "(no matches)"} />
    </ToolFrame>
  );
}

function FindTool({ tool, questionContext, recovered }: ToolRenderProps) {
  const pattern = asString(getArg(tool.args, "pattern", "glob"));
  const path = asString(getArg(tool.args, "path", "dir"));
  const result = tool.result ?? tool.partialResult;
  const text = resultToText(result, asString(result));
  return (
    <ToolFrame
      tool={tool}
      questionContext={questionContext}
      recovered={recovered}
      title={pattern || "(no pattern)"}
      subtitle={path || undefined}
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={text || "(none)"} />
    </ToolFrame>
  );
}

function LsTool({ tool, questionContext, recovered }: ToolRenderProps) {
  const path = asString(getArg(tool.args, "path", "dir"));
  const result = tool.result ?? tool.partialResult;
  const text = resultToText(result, asString(result));
  return (
    <ToolFrame
      tool={tool}
      questionContext={questionContext}
      recovered={recovered}
      title={path || "."}
      subtitle="ls"
    >
      {errorBanner(tool)}
      <ToolImages tool={tool} />
      <CodeBlock text={text || "(empty)"} />
    </ToolFrame>
  );
}

function GenericTool({ tool, questionContext, recovered }: ToolRenderProps) {
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
    <ToolFrame
      tool={tool}
      questionContext={questionContext}
      recovered={recovered}
      title={tool.toolName}
      subtitle={toolStatusLabel(tool.status)}
    >
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
