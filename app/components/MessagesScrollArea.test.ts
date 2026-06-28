import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCollapsedProcessItems,
  dedupeAdjacentRestoredMessages,
  selectVisibleRenderItemsForWindow,
  shouldForceProcessGroupExecuting,
} from "./MessagesScrollArea";
import type { ChatMessage } from "@/lib/types";
import { createInitialAgentTeamRun } from "@/lib/agent-team/initial-run";

function user(text: string, timestamp: number): ChatMessage {
  return {
    role: "user",
    text,
    timestamp,
    parts: [{ kind: "text", text }],
  };
}

function assistantProcess(timestamp: number): ChatMessage {
  return {
    role: "assistant",
    text: "",
    timestamp,
    stopReason: "tool_use",
    parts: [
      {
        kind: "tool",
        toolCallId: `tool-${timestamp}`,
        toolName: "read",
        status: "done",
      },
    ],
  };
}

function assistantText(text: string, timestamp: number): ChatMessage {
  return {
    role: "assistant",
    text,
    timestamp,
    parts: [{ kind: "text", text }],
  };
}

describe("MessagesScrollArea process grouping", () => {
  it("renders a later user before assistant process items that arrived after it", () => {
    const messages = [
      user("first question", 1000),
      assistantProcess(3000),
      user("follow up", 2000),
    ];

    const items = buildCollapsedProcessItems({ messages });

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "process_group",
    ]);
    expect(items[1]).toMatchObject({
      kind: "message",
      index: 2,
    });
  });

  it("does not force an old process group into running once a later user exists", () => {
    const messages = [
      user("first question", 1000),
      assistantProcess(1500),
      user("done yet?", 2000),
    ];

    expect(shouldForceProcessGroupExecuting(messages, 1, true)).toBe(false);
  });

  it("still forces the tail process group while the current turn is streaming", () => {
    const messages = [
      user("first question", 1000),
      assistantText("working on it", 1100),
      assistantProcess(1500),
    ];

    expect(shouldForceProcessGroupExecuting(messages, 2, true)).toBe(true);
  });

  it("dedupes adjacent restored user messages with the same content", () => {
    const messages = [
      user("same prompt", 1000),
      user("same prompt", 1000),
      assistantText("answer", 1100),
    ];

    const deduped = dedupeAdjacentRestoredMessages(messages);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toMatchObject({ role: "user", text: "same prompt" });

    const items = buildCollapsedProcessItems({ messages });
    expect(items.filter((item) => item.kind === "message")).toHaveLength(2);
  });

  it("keeps message rendering behind UI shape guards", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );

    expect(source).toContain("normalizeMessageParts");
    expect(source).toContain("<UiFaultBoundary");
    expect(source).toContain("消息渲染异常，已隔离该消息");
  });

  it("keeps Agent Team run cards visible instead of folding them into process groups", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );

    expect(source).toContain('part.kind === "agent_team_run"');
    expect(source).toContain("return false");
  });

  it("keeps a restored Agent Team run card visible before the final assistant answer", () => {
    const run = createInitialAgentTeamRun("restored team");
    const messages: ChatMessage[] = [
      user("start team", 1000),
      {
        role: "assistant",
        timestamp: 1500,
        parts: [{ kind: "agent_team_run", run }],
      },
      assistantText("final answer", 2000),
    ];

    const items = buildCollapsedProcessItems({ messages });

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
    ]);
    expect(items[1]).toMatchObject({ kind: "message", index: 1 });
  });

  it("keeps an Agent Team final answer visible even when a restored run card follows it", () => {
    const run = createInitialAgentTeamRun("restored team");
    const messages: ChatMessage[] = [
      user("start team", 1000),
      assistantText("结论\n\n存在。<!-- agent-team-final:team-1 -->", 2000),
      {
        role: "assistant",
        timestamp: 2100,
        parts: [{ kind: "agent_team_run", run }],
      },
    ];

    const items = buildCollapsedProcessItems({ messages });

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
    ]);
    expect(items[1]).toMatchObject({ kind: "message", index: 1 });
  });

  it("keeps old Agent Team final answers visible when the message window is clipped", () => {
    const messages: ChatMessage[] = [
      user("start team", 1000),
      assistantText("结论\n\n存在。<!-- agent-team-final:team-1 -->", 1100),
    ];
    for (let index = 0; index < 8; index += 1) {
      messages.push(user(`follow up ${index}`, 2000 + index * 2));
      messages.push(assistantText(`later answer ${index}`, 2001 + index * 2));
    }
    const items = buildCollapsedProcessItems({ messages });

    const selected = selectVisibleRenderItemsForWindow(items, 3);

    expect(selected.hiddenItemCount).toBeGreaterThan(0);
    expect(selected.visibleRenderItems.length).toBe(4);
    expect(selected.visibleRenderItems[0]).toMatchObject({
      kind: "message",
      index: 1,
    });
  });

  it("passes latest Agent Team runs into message cards so final conclusions do not use stale snapshots", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );

    expect(source).toContain("latestAgentTeamRunById");
    expect(source).toContain("agentTeamRunsById={latestAgentTeamRunById}");
    expect(source).toContain("onOpenAgentTeamMember={onOpenAgentTeamMember}");
  });

  it("captures Agent Team action button clicks at the message list boundary", () => {
    const listSource = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );
    const cardSource = readFileSync(
      path.join(process.cwd(), "app/components/MessageView.tsx"),
      "utf8"
    );
    const appSource = readFileSync(
      path.join(process.cwd(), "app/ChatApp.tsx"),
      "utf8"
    );

    expect(listSource).toContain("handleAgentTeamActionCapture");
    expect(listSource).toContain("onClickCapture={handleAgentTeamActionCapture}");
    expect(listSource).toContain("onPointerDownCapture={handleAgentTeamActionCapture}");
    expect(listSource).toContain("lastAgentTeamActionRef");
    expect(listSource).toContain("addEventListener(\"pointerdown\"");
    expect(listSource).toContain("dispatchAgentTeamActionFromButton");
    expect(listSource).toContain("button[data-agent-team-id][data-agent-team-action]");
    expect(listSource).toContain("button.dataset.agentTeamLeadId");
    expect(cardSource).toContain("data-agent-team-action=\"stop\"");
    expect(cardSource).toContain("data-agent-team-action=\"finalize\"");
    expect(cardSource).toContain("data-agent-team-lead-id={run.leadAgentId}");
    expect(cardSource).toContain("onPointerDown={(event) =>");
    expect(appSource).toContain("const ensured = await ensureAgent();");
    expect(appSource).toContain("const targetAgentId = ensured?.aid;");
    expect(appSource).toContain("type: \"finalize_with_risks\"");
    expect(appSource).toContain("knownRun?.settings.mode !== \"audit\"");
    expect(appSource).toContain("[agent-team-ui] action requested");
    expect(appSource).toContain("fetch(`/api/agent/${targetAgentId}/teams`");
  });

  it("opens the Team member side view from Agent Team member timeline clicks", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/ChatApp.tsx"),
      "utf8"
    );

    expect(source).toContain("openAgentTeamMemberFromCard");
    expect(source).toContain("openWorkbench({ type: \"team\", teamId, memberId })");
    expect(source).toContain("setError(null)");
    expect(source).toContain("onOpenAgentTeamMember={openAgentTeamMemberFromCard}");
    expect(source).toContain("(teamId: string, memberId: string) =>");
    expect(source).toContain("openAgentTeamMemberSessionFromSidebar");
    expect(source).toContain("openSubagentSessionFromCard(sessionFile, { quiet: true })");
  });

  it("preserves Composer local text when sending from Agent Team sessions", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/ChatApp.tsx"),
      "utf8"
    );

    expect(source).toContain("async (textOverride?: string)");
    expect(source).toContain("const current = textOverride ?? getCurrentInput()");
    expect(source).toContain("await send(current)");
  });

  it("auto-continues Agent Team after creation so users do not need to click Continue", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/ChatApp.tsx"),
      "utf8"
    );

    expect(source).toContain('type: "run_until_idle"');
    expect(source).toContain("teamId: run.id");
    expect(source).toContain("maxDispatches: 4");
    expect(source).toContain("团队暂时没有新的自动动作");
  });
});
