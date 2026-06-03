/**
 * ask_user clarification tool.
 *
 * 让模型在信息不足或存在多条可行路径时主动请求用户选择。
 * Web UI 通过 clarification_request / resolved SSE 事件展示卡片并提交响应。
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type {
  ClarificationOption,
  ClarificationRequest,
  ClarificationResponse,
} from "./types";

const OptionSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Stable option id. If omitted, one is generated.",
    })
  ),
  label: Type.String({ description: "Short option label shown to the user." }),
  description: Type.Optional(
    Type.String({ description: "Brief tradeoff or impact for this option." })
  ),
  value: Type.Optional(
    Type.String({
      description:
        "Instruction sent back to the agent if selected. Defaults to label.",
    })
  ),
});

const AskUserParams = Type.Object({
  title: Type.Optional(
    Type.String({ description: "Short title, e.g. '需要你确认下一步'." })
  ),
  question: Type.String({ description: "The decision or missing info." }),
  context: Type.Optional(
    Type.String({ description: "Why this confirmation is needed." })
  ),
  options: Type.Array(OptionSchema, {
    description: "Two to four concrete options.",
  }),
  recommendedOptionId: Type.Optional(
    Type.String({ description: "Option id that the agent recommends." })
  ),
});

export interface ClarificationExtensionOptions {
  getAgentId: () => string;
  onClarificationNeeded: (
    req: ClarificationRequest
  ) => Promise<ClarificationResponse>;
}

interface AskUserDetails {
  requestId?: string;
  selectedOptionId?: string;
  customText?: string;
  answer: string | null;
}

function normalizeOptionId(label: string, index: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || `option-${index + 1}`;
}

function normalizeOptions(
  raw: Array<{
    id?: string;
    label: string;
    description?: string;
    value?: string;
  }>
): ClarificationOption[] {
  return raw.slice(0, 4).map((opt, index) => ({
    id: opt.id?.trim() || normalizeOptionId(opt.label, index),
    label: opt.label.slice(0, 48),
    description: opt.description?.slice(0, 160),
    value: (opt.value?.trim() || opt.label).slice(0, 500),
  }));
}

export function createClarificationExtension(
  opts: ClarificationExtensionOptions
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool<typeof AskUserParams, AskUserDetails>({
        name: "ask_user",
        label: "Ask User",
        description:
          "Ask the user to clarify requirements or choose the next implementation path. Use only when you cannot safely continue without a user decision.",
        promptSnippet:
          "ask_user: ask the user to choose between concrete next steps when blocked by ambiguity.",
        promptGuidelines: [
          "Use ask_user only when a user decision is required to continue safely.",
          "Provide 2-4 concrete options and mark the recommended option when one path is best.",
          "Do not ask for confirmation after every step; keep it for meaningful ambiguity or risk.",
        ],
        parameters: AskUserParams,
        executionMode: "sequential",

        async execute(toolCallId, params) {
          const options = normalizeOptions(params.options ?? []);
          if (options.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No options were provided, so no user clarification was requested.",
                },
              ],
              details: { answer: null },
            };
          }

          const recommendedOptionId =
            params.recommendedOptionId &&
            options.some((opt) => opt.id === params.recommendedOptionId)
              ? params.recommendedOptionId
              : options[0]?.id;
          const agentId = opts.getAgentId();
          const req: ClarificationRequest = {
            id: `${agentId}:${toolCallId}`,
            agentId,
            requestId: toolCallId,
            title: params.title?.slice(0, 80) || "需要你确认下一步",
            question: params.question.slice(0, 500),
            context: params.context?.slice(0, 500),
            options,
            recommendedOptionId,
            createdAt: Date.now(),
          };

          const resp = await opts.onClarificationNeeded(req);
          const selected = resp.selectedOptionId
            ? options.find((opt) => opt.id === resp.selectedOptionId)
            : null;
          const answer = resp.customText?.trim() || selected?.value || "";

          return {
            content: [
              {
                type: "text",
                text: answer
                  ? `User clarified: ${answer}`
                  : "User did not provide a clarification.",
              },
            ],
            details: {
              requestId: req.requestId,
              selectedOptionId: resp.selectedOptionId,
              customText: resp.customText,
              answer,
            },
          };
        },
      })
    );
  };
}
