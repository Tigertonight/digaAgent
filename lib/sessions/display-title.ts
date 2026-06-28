import type { SessionInfoLite } from "@/lib/types";

const TEAMMATE_PROMPT_MARKER = "You are a teammate in an Agent Team run.";

function readPromptLine(text: string, label: string): string {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

export function agentTeamMemberSessionTitleFromText(text: string | undefined): string | null {
  if (!text || !text.includes(TEAMMATE_PROMPT_MARKER)) return null;
  const taskTitle = readPromptLine(text, "Task title");
  const memberId = readPromptLine(text, "Your member id");
  const memberKey = memberId.split(":").pop()?.toLowerCase() ?? "";
  const memberName =
    memberKey.includes("research")
      ? "资料员"
      : memberKey.includes("critic")
        ? "质疑者"
        : memberKey.includes("synthesis")
          ? "整理者"
          : memberKey.includes("validation")
            ? "验收员"
            : memberKey.includes("builder")
              ? "Builder"
              : "团队成员";
  return taskTitle ? `${memberName}：${taskTitle}` : `${memberName}：团队协作记录`;
}

export function sessionDisplayTitle(
  session: Pick<SessionInfoLite, "meta" | "name" | "firstMessage">
): string {
  return (
    session.meta?.title ||
    session.name ||
    agentTeamMemberSessionTitleFromText(session.firstMessage) ||
    session.firstMessage ||
    "新会话"
  );
}
