import { describe, expect, it } from "vitest";
import {
  agentTeamLeadStateLabel,
  agentTeamMemberLabel,
  agentTeamStatusLabel,
  subagentRoleLabel,
  subagentStatusLabel,
  workflowStatusLabel,
} from "./labels";

describe("workflowStatusLabel", () => {
  it("maps known statuses and falls back to raw value", () => {
    expect(workflowStatusLabel("running")).toBe("执行中");
    expect(workflowStatusLabel("completed_with_warnings")).toBe("已完成，有提醒");
    expect(workflowStatusLabel("needs_continue")).toBe("需要继续");
    // unknown value falls through
    expect(workflowStatusLabel("weird" as never)).toBe("weird");
  });
});

describe("agentTeamMemberLabel", () => {
  it("maps role names and handles undefined", () => {
    expect(agentTeamMemberLabel(undefined)).toBe("成员");
    expect(agentTeamMemberLabel("Lead")).toBe("负责人");
    expect(agentTeamMemberLabel("Critic")).toBe("质疑者");
    expect(agentTeamMemberLabel("Custom")).toBe("Custom");
  });
});

describe("agentTeamStatusLabel", () => {
  it("maps team run statuses", () => {
    expect(agentTeamStatusLabel("draft")).toBe("待确认");
    expect(agentTeamStatusLabel("running")).toBe("协作中");
    expect(agentTeamStatusLabel("finalizing")).toBe("综合中");
    expect(agentTeamStatusLabel("xyz")).toBe("xyz");
  });
});

describe("agentTeamLeadStateLabel", () => {
  it("maps lead states", () => {
    expect(agentTeamLeadStateLabel("exploring")).toBe("处理中");
    expect(agentTeamLeadStateLabel("needs_decision")).toBe("需要确认");
    expect(agentTeamLeadStateLabel("finalized")).toBe("已综合");
    expect(agentTeamLeadStateLabel("other")).toBe("other");
  });
});

describe("subagentRoleLabel", () => {
  it("maps roles and defaults to 通用", () => {
    expect(subagentRoleLabel("rag")).toBe("知识库");
    expect(subagentRoleLabel("code-review")).toBe("审计");
    expect(subagentRoleLabel(undefined)).toBe("通用");
    expect(subagentRoleLabel("anything")).toBe("通用");
  });
});

describe("subagentStatusLabel", () => {
  it("maps statuses including timeout", () => {
    expect(subagentStatusLabel("completed")).toBe("已完成");
    expect(subagentStatusLabel("timeout")).toBe("已超时");
    expect(subagentStatusLabel("unknown")).toBe("unknown");
  });
});
