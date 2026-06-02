/**
 * RFC-3 Phase B / F2：从 SessionEntry 抽取可索引文本的纯函数层。
 *
 * 此文件不 import 任何带副作用的运行时模块（不依赖 lib/sessions /
 * server-only / SDK 运行时），仅依赖 SDK 的类型声明。
 * 这样可以独立单测，也可以被 worker 复用。
 *
 * 索引来源（v0）：
 *   - SessionMessageEntry
 *     - user message: content.text （array 时拼接）
 *     - assistant message: 只取 TextContent.text（跳过 thinking / toolCall）
 *     - bashExecution: command + " | " + output（output 截断 BASH_OUTPUT_MAX）
 *     - custom: content.text （array 时拼接）
 *     - branchSummary / compactionSummary: summary
 *   - CompactionEntry: summary
 *   - BranchSummaryEntry: summary
 *   - SessionInfoEntry: name
 * 跳过：
 *   - thinking / toolCall / toolResult / image
 *   - ThinkingLevelChangeEntry / ModelChangeEntry / CustomEntry / LabelEntry / CustomMessageEntry
 */

import type {
  SessionEntry,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";

import type { SearchDoc, SearchHit } from "./types";

const BASH_OUTPUT_MAX = 2000;

interface ExtractedHit {
  kind: SearchHit["kind"];
  text: string;
}

/** 从 content（string | (TextContent|ImageContent)[]）抽 text，跳过 image */
function flattenTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { type?: string; text?: string };
    if (obj.type === "text" && typeof obj.text === "string") {
      parts.push(obj.text);
    }
    // image / 其他类型跳过
  }
  return parts.join("\n");
}

/**
 * 把单条 entry 抽成 0..N 条可索引片段。
 * 纯函数，便于单测。
 */
export function extractTextFromEntry(entry: SessionEntry): ExtractedHit[] {
  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      switch (msg.role) {
        case "user": {
          const text = flattenTextContent(msg.content);
          return text ? [{ kind: "user", text }] : [];
        }
        case "assistant": {
          if (!Array.isArray(msg.content)) return [];
          const parts: string[] = [];
          for (const item of msg.content) {
            if (
              item &&
              typeof item === "object" &&
              (item as { type?: string }).type === "text" &&
              typeof (item as { text?: string }).text === "string"
            ) {
              parts.push((item as { text: string }).text);
            }
          }
          const text = parts.join("\n");
          return text ? [{ kind: "assistant", text }] : [];
        }
        case "bashExecution": {
          const m = msg as unknown as {
            command?: string;
            output?: string;
          };
          const cmd = m.command ?? "";
          const out = (m.output ?? "").slice(0, BASH_OUTPUT_MAX);
          const text = [cmd, out].filter(Boolean).join(" | ");
          return text ? [{ kind: "bash", text }] : [];
        }
        case "custom": {
          const m = msg as unknown as { content?: unknown };
          const text = flattenTextContent(m.content);
          return text ? [{ kind: "custom", text }] : [];
        }
        case "branchSummary": {
          const m = msg as unknown as { summary?: string };
          const text = m.summary ?? "";
          return text ? [{ kind: "branch-summary", text }] : [];
        }
        case "compactionSummary": {
          const m = msg as unknown as { summary?: string };
          const text = m.summary ?? "";
          return text ? [{ kind: "compaction", text }] : [];
        }
        // toolResult 暂不索引
        default:
          return [];
      }
    }

    case "compaction": {
      const text = entry.summary ?? "";
      return text ? [{ kind: "compaction", text }] : [];
    }

    case "branch_summary": {
      const text = entry.summary ?? "";
      return text ? [{ kind: "branch-summary", text }] : [];
    }

    case "session_info": {
      const text = entry.name ?? "";
      return text ? [{ kind: "session-info", text }] : [];
    }

    // 跳过：thinking_level_change / model_change / custom / label / custom_message
    default:
      return [];
  }
}

/**
 * 把 session 全部 entries → SearchDoc。
 * 纯函数。
 */
export function buildSearchDocFromSession(
  info: Pick<SessionInfo, "id" | "path" | "cwd">,
  entries: SessionEntry[],
  now: number = Date.now(),
): SearchDoc {
  const hits: SearchDoc["hits"] = [];
  const fullParts: string[] = [];

  for (const entry of entries) {
    const extracted = extractTextFromEntry(entry);
    for (const { kind, text } of extracted) {
      hits.push({ entryId: entry.id, kind, text });
      fullParts.push(text);
    }
  }

  return {
    sessionId: info.id,
    path: info.path,
    cwd: info.cwd,
    indexedAt: now,
    fullText: fullParts.join("\n"),
    hits,
  };
}
