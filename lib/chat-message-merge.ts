import type { ChatMessage, MessagePart } from "./types";

function stableJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, (_key, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.keys(item)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (item as Record<string, unknown>)[key];
          return acc;
        }, {});
    });
  } catch {
    return String(value);
  }
}

function partSignature(part: MessagePart): string {
  switch (part.kind) {
    case "text":
    case "thinking":
      return `${part.kind}:${part.text}`;
    case "agent_team_run":
      return `agent_team_run:${part.run.id}`;
    case "workflow_run":
      return `workflow_run:${part.id}`;
    case "subagent_batch":
      return `subagent_batch:${part.id}`;
    case "tool":
      return `tool:${part.toolCallId}:${part.toolName}:${part.status}`;
    case "approval":
      return `approval:${part.id}:${part.status}:${part.resolvedBy ?? ""}`;
    case "clarification":
      return `clarification:${part.id}:${part.status}:${part.selectedOptionId ?? ""}`;
    case "image":
      return `image:${part.mimeType}:${part.data.slice(0, 48)}`;
    default:
      return stableJson(part);
  }
}

export function chatMessageMergeKey(message: ChatMessage): string {
  const parts = message.parts?.length
    ? message.parts.map(partSignature).join("|")
    : `${message.text ?? ""}|${message.thinking ?? ""}|${stableJson(message.raw)}`;
  return [
    message.role,
    message.timestamp ?? "",
    message.stopReason ?? "",
    message.meta?.responseId ?? "",
    parts,
  ].join("\u001f");
}

function insertByTimestamp(
  messages: ChatMessage[],
  message: ChatMessage
): ChatMessage[] {
  const ts = message.timestamp;
  if (typeof ts !== "number") return [...messages, message];
  const insertAt = messages.findIndex(
    (candidate) =>
      typeof candidate.timestamp === "number" &&
      (candidate.timestamp as number) > ts
  );
  if (insertAt === -1) return [...messages, message];
  return [
    ...messages.slice(0, insertAt),
    message,
    ...messages.slice(insertAt),
  ];
}

export function mergeMissingChatMessages(
  current: ChatMessage[],
  restored: ChatMessage[]
): ChatMessage[] {
  if (restored.length === 0) return current;
  const seen = new Set(current.map(chatMessageMergeKey));
  let next = current;
  for (const message of restored) {
    const key = chatMessageMergeKey(message);
    if (seen.has(key)) continue;
    next = insertByTimestamp(next, message);
    seen.add(key);
  }
  return next;
}
