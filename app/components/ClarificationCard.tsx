"use client";

import { memo, useMemo, useState } from "react";
import { Check, HelpCircle, Send } from "lucide-react";
import type { MessagePart } from "@/lib/types";

type ClarificationPart = Extract<MessagePart, { kind: "clarification" }>;

export interface ClarificationCardProps {
  part: ClarificationPart;
  onChoose?: (requestId: string, optionId: string) => void;
  onRespond?: (requestId: string, customText: string) => void;
}

export const ClarificationCard = memo(function ClarificationCard({
  part,
  onChoose,
  onRespond,
}: ClarificationCardProps) {
  const [customText, setCustomText] = useState("");
  const selected = useMemo(
    () => part.options.find((o) => o.id === part.selectedOptionId),
    [part.options, part.selectedOptionId]
  );

  const originBadge = part.taskTitle ? (
    <span
      className="rounded-token-sm px-1.5 py-0.5 text-token-xs font-medium"
      style={{
        background: "color-mix(in srgb, var(--accent) 16%, var(--bg-panel))",
        color: "var(--accent)",
      }}
      title={`来自子任务${part.originAgentId ? `（${part.originAgentId.slice(0, 8)}）` : ""}`}
    >
      来自子任务：{part.taskTitle}
    </span>
  ) : null;

  if (part.status === "resolved") {
    return (
      <div
        className="rounded-md px-3 py-2 text-xs"
        style={{
          background: "var(--bg-panel-2)",
          color: "var(--text-muted)",
          borderLeft: "3px solid var(--accent)",
        }}
      >
        <div className="inline-flex items-center gap-2 flex-wrap">
          <Check size={13} style={{ color: "var(--accent)" }} />
          {originBadge}
          <span>
            已确认：
            {selected?.label ?? part.customText ?? "自定义回复"}
          </span>
        </div>
        {part.customText && (
          <div
            className="ml-5 mt-1 whitespace-pre-wrap text-token-xs"
            style={{ color: "var(--text-dim)" }}
          >
            {part.customText}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md p-3 text-sm space-y-3"
      style={{
        background: "var(--bg-panel-2)",
        borderLeft: "3px solid var(--accent)",
      }}
    >
      <div className="flex items-start gap-2">
        <HelpCircle
          size={15}
          className="mt-0.5 shrink-0"
          style={{ color: "var(--accent)" }}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold" style={{ color: "var(--text)" }}>
              {part.title}
            </span>
            {originBadge}
          </div>
          <div
            className="mt-1 text-sm whitespace-pre-wrap"
            style={{ color: "var(--text)" }}
          >
            {part.question}
          </div>
          {part.context && (
            <div
              className="mt-1 text-xs whitespace-pre-wrap"
              style={{ color: "var(--text-muted)" }}
            >
              {part.context}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {part.options.map((opt) => {
          const recommended = opt.id === part.recommendedOptionId;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChoose?.(part.requestId, opt.id)}
              className="w-full rounded-md border px-3 py-2 text-left hover:opacity-90 transition-opacity"
              style={{
                background: recommended
                  ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))"
                  : "var(--bg-panel)",
                borderColor: recommended
                  ? "var(--accent)"
                  : "var(--border-soft)",
                color: "var(--text)",
              }}
            >
              <div className="flex items-center gap-2">
                {recommended && (
                  <span
                    className="rounded-token-sm px-1.5 py-0.5 text-token-xs font-semibold"
                    style={{
                      background: "var(--accent)",
                      color: "var(--color-bg)",
                    }}
                  >
                    推荐
                  </span>
                )}
                <span className="font-medium">{opt.label}</span>
              </div>
              {opt.description && (
                <div
                  className="mt-1 text-xs leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  {opt.description}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex gap-2">
        <input
          value={customText}
          onChange={(e) => setCustomText(e.target.value.slice(0, 500))}
          placeholder="自定义回复..."
          className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs outline-none"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border-soft)",
            color: "var(--text)",
          }}
        />
        <button
          type="button"
          onClick={() => {
            const text = customText.trim();
            if (!text) return;
            onRespond?.(part.requestId, text);
            setCustomText("");
          }}
          disabled={!customText.trim()}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--color-bg)" }}
        >
          <Send size={12} />
          发送
        </button>
      </div>
    </div>
  );
});
