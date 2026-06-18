/**
 * P2 修复：统一 prompt / steer / follow_up 的「发送文本组装」。
 *
 * 设计：
 *   - displayText：用户在气泡上看到的「干净原话」（去 @agent mention 之后）。
 *   - finalText：实际发给 SDK 的文本（displayText + CONTEXT_ASIDE 包裹的附件 / 委托指令）。
 *
 * 前端渲染 user 气泡时会 stripContextAside，重建出 displayText（不含 aside），
 * 所以「展示=原文，发送=带上下文」两个目标统一。
 *
 * 不依赖 SDK / Next / agent-registry，纯函数 + 单测友好。
 */

import {
  CONTEXT_ASIDE_CLOSE,
  CONTEXT_ASIDE_OPEN,
} from "@/lib/context-aside";
import {
  buildAgentMentionDirective,
  stripAgentMentions,
} from "@/lib/subagents/router";

export interface ComposeAsideOptions {
  /**
   * 已知的 specialist agent id 列表。空数组 = 不解析 @agent mention（steer/follow_up 路径）。
   */
  specialistIds: string[];
}

export interface ComposeAsideResult {
  displayText: string;
  finalText: string;
  mentionDirective: ReturnType<typeof buildAgentMentionDirective>;
}

/**
 * 把用户原话 + 附件 + @agent mention 组装成最终的 finalText。
 */
export function composePromptWithAside(
  text: string,
  attachments: string[],
  options: ComposeAsideOptions = { specialistIds: [] }
): ComposeAsideResult {
  const mentionDirective = buildAgentMentionDirective(
    text,
    options.specialistIds
  );
  const displayText = mentionDirective
    ? stripAgentMentions(text, options.specialistIds) || text
    : text;
  const asideSections: string[] = [];
  if (attachments.length > 0) {
    asideSections.push(
      `Referenced files/folders (read or list as needed):\n${attachments
        .map((p) => `@${p}`)
        .join(" ")}`
    );
  }
  if (mentionDirective) {
    asideSections.push(mentionDirective.directive);
  }
  const asideContext = asideSections.join("\n\n");
  const finalText = asideContext
    ? `${displayText}\n\n${CONTEXT_ASIDE_OPEN}\n${asideContext}\n${CONTEXT_ASIDE_CLOSE}`
    : displayText;
  return { displayText, finalText, mentionDirective };
}

/** body.attachments 解析（过滤非 string）。 */
export function parseAttachments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string");
}
