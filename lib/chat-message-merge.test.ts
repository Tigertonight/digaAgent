import { describe, expect, it } from "vitest";
import { mergeMissingChatMessages } from "./chat-message-merge";
import type { ChatMessage } from "./types";

function textMessage(
  role: ChatMessage["role"],
  text: string,
  timestamp: number
): ChatMessage {
  return {
    role,
    timestamp,
    parts: [{ kind: "text", text }],
  };
}

describe("mergeMissingChatMessages", () => {
  it("appends messages that exist in restored context but not current UI state", () => {
    const current = [textMessage("user", "first", 1000)];
    const restored = [
      textMessage("user", "first", 1000),
      textMessage("assistant", "second", 2000),
    ];

    expect(mergeMissingChatMessages(current, restored)).toEqual(restored);
  });

  it("keeps restored messages in timestamp order when filling a gap", () => {
    const current = [
      textMessage("user", "first", 1000),
      textMessage("assistant", "third", 3000),
    ];
    const restored = [
      textMessage("user", "first", 1000),
      textMessage("assistant", "second", 2000),
      textMessage("assistant", "third", 3000),
    ];

    expect(mergeMissingChatMessages(current, restored).map((message) => message.parts?.[0])).toEqual([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
      { kind: "text", text: "third" },
    ]);
  });

  it("does not duplicate existing agent team run messages", () => {
    const teamMessage: ChatMessage = {
      role: "assistant",
      timestamp: 1000,
      parts: [
        {
          kind: "agent_team_run",
          run: {
            id: "team-1",
            objective: "test",
            status: "completed",
            leadState: "finalized",
            leadAgentId: "lead",
            settings: {
              mode: "collaboration",
              memberScale: "small",
              allowNetwork: false,
              allowWorktree: false,
              allowChallenges: true,
              requirePlanApproval: false,
              allowWrite: false,
              displayMode: "workspace",
              stopConditions: {
                requiredTasksComplete: true,
                noOpenBlockingChallenges: true,
                leadFinalSynthesis: true,
              },
            },
            members: [],
            board: {
              summary: "",
              tasks: [],
              results: [],
              plans: [],
              findings: [],
              challenges: [],
              decisions: [],
              messages: [],
              fileLocks: [],
              hooks: [],
              qualityGates: [],
              capabilityAudit: [],
              events: [],
            },
            blockReasons: [],
            recoveryAttempts: [],
            createdAt: 1000,
            updatedAt: 2000,
          },
        },
      ],
    };

    const merged = mergeMissingChatMessages([teamMessage], [teamMessage]);

    expect(merged).toHaveLength(1);
  });

  it("treats status snapshots for the same agent team run as the same message", () => {
    const running: ChatMessage = {
      role: "assistant",
      timestamp: 1000,
      parts: [
        {
          kind: "agent_team_run",
          run: {
            id: "team-1",
            objective: "test",
            status: "running",
            leadState: "exploring",
            leadAgentId: "lead",
            settings: {
              mode: "collaboration",
              memberScale: "small",
              allowNetwork: false,
              allowWorktree: false,
              allowChallenges: true,
              requirePlanApproval: false,
              allowWrite: false,
              displayMode: "workspace",
              stopConditions: {
                requiredTasksComplete: true,
                noOpenBlockingChallenges: true,
                leadFinalSynthesis: true,
              },
            },
            members: [],
            board: {
              summary: "",
              tasks: [],
              results: [],
              plans: [],
              findings: [],
              challenges: [],
              decisions: [],
              messages: [],
              fileLocks: [],
              hooks: [],
              qualityGates: [],
              capabilityAudit: [],
              events: [],
            },
            blockReasons: [],
            recoveryAttempts: [],
            createdAt: 1000,
            updatedAt: 1000,
          },
        },
      ],
    };
    const completed: ChatMessage = {
      ...running,
      parts: [
        {
          kind: "agent_team_run",
          run: {
            ...(running.parts?.[0].kind === "agent_team_run"
              ? running.parts[0].run
              : (() => {
                  throw new Error("unexpected test fixture");
                })()),
            status: "completed",
            leadState: "finalized",
            updatedAt: 2000,
          },
        },
      ],
    };

    const merged = mergeMissingChatMessages([running], [completed]);

    expect(merged).toHaveLength(1);
  });
});
