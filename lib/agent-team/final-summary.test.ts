import { describe, expect, it } from "vitest";
import {
  agentTeamFinalAnswerPromptGuidelines,
  classifyAgentTeamFinalAnswerIntent,
  getAgentTeamFinalSummary,
  wantsConciseAgentTeamFinalAnswer,
} from "./final-summary";
import { createInitialAgentTeamRun } from "./initial-run";

describe("agent team final summary", () => {
  it("extracts a visible conclusion from the accepted decision", () => {
    const base = createInitialAgentTeamRun("final summary");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "完成态分支会屏蔽需要裁决、阻塞诊断和继续推进。",
            evidenceRefs: ["file:app/components/MessageView.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        challenges: [
          {
            id: "c1",
            targetFindingId: "f1",
            authorAgentId: base.leadAgentId,
            reason: "只做了静态检查，未跑完整 UI。",
            severity: "low" as const,
            status: "dismissed" as const,
            resolution: "风险已记录，不影响本次最小回归结论。",
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "通过：完成态不会再显示需要裁决、阻塞诊断或继续推进。关键证据来自 MessageView 和 WorkbenchSidebar 的完成态分支。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/components/MessageView.tsx"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("通过：完成态不会再显示需要裁决、阻塞诊断或继续推进。");
    expect(summary?.bullets.join(" ")).toContain("完成态分支");
    expect(summary?.risk).toContain("风险已记录");
  });

  it("adapts internal failure details into a user-facing verification answer", () => {
    const base = createInitialAgentTeamRun("这个修复是否已经通过验收？");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "不通过：成员结果为空或供应商断流，无法形成真实可采纳发现；本次只能带风险收束。",
            evidenceRefs: ["task:validation"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale: "用户选择带风险生成最终综合。未完成关键任务已由负责人接管：验收与回归核查。Finalize blocked by quality gates.",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["task:validation"],
            sourceResultIds: [],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const text = [
      summary?.verdict,
      summary?.rationale,
      ...(summary?.bullets ?? []),
      summary?.risk,
    ].join(" ");

    expect(summary?.intent).toBe("verification");
    expect(summary?.verdict).toBe("无法确认通过。");
    expect(text).not.toMatch(/供应商断流|用户选择|负责人强制收束|quality gates|质量门禁|共享白板|主聊天/i);
    expect(text).toContain("部分检查没有拿到可采纳结果");
  });

  it("turns provider-only failures into an actionable open-ended answer", () => {
    const base = createInitialAgentTeamRun("帮我看看 agent team 这个能力整体怎么样。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "没有拿到可采纳的成员结论。",
            evidenceRefs: ["task:evidence"],
            confidence: "low" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale: "用户选择带风险生成最终综合。No teammate output was captured. provider stream error.",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["task:evidence"],
            sourceResultIds: [],
            confidence: "low" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const text = [
      summary?.verdict,
      summary?.rationale,
      ...(summary?.bullets ?? []),
      summary?.risk,
    ].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toBe("这次没有拿到足够可靠的团队结论；建议重试自动处理，或切换到稳定模型后再跑一次。");
    expect(text).not.toMatch(/No teammate output|provider stream|用户选择|共享白板|主聊天|quality gates/i);
  });

  it("does not force pass/fail wording for recommendation requests", () => {
    const base = createInitialAgentTeamRun("这个能力后续应该怎么优化？");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "建议优先把最终回答改成面向用户问题的 Answer Adapter，再补充风险提示和下一步建议。",
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.intent).toBe("recommendation");
    expect(summary?.verdict).toContain("建议优先");
    expect(summary?.verdict).not.toMatch(/^通过|^不通过|无法确认通过/);
  });

  it("does not split file paths as sentence endings", () => {
    const base = createInitialAgentTeamRun("只读检查 app/ChatApp.tsx 是否存在。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "结论: 存在 — `app/ChatApp.tsx` 存在于工作目录，证据一致。",
            evidenceRefs: ["file:app/ChatApp.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "结论: 存在 — `app/ChatApp.tsx` 存在于工作目录，证据一致。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/ChatApp.tsx"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("存在 — 已确认 `app/ChatApp.tsx` 在当前项目中。");
  });

  it("treats one evidence sentence requests as concise final answers", () => {
    const base = createInitialAgentTeamRun("只读确认 app/page.tsx 是否存在。请直接回答存在/不存在，并给一句证据。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "存在 — 已确认 app/page.tsx 在当前项目中。",
            evidenceRefs: ["file:app/page.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "存在 — 已确认 app/page.tsx 在当前项目中。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/page.tsx"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.concise).toBe(true);
    expect(summary?.verdict).toBe("存在 — 已确认 `app/page.tsx` 在当前项目中。");
  });

  it("converts English conclusion labels into a concise Chinese existence answer", () => {
    const base = createInitialAgentTeamRun("只读检查 app/ChatApp.tsx 是否存在。最后只回答：存在/不存在 + 一句话原因。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "Conclusion: 存在。",
            evidenceRefs: [
              "file:/Users/yuanzexiang/Documents/pi-agent/diga-agent/app/ChatApp.tsx",
              "file:app/ChatApp.tsx",
            ],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "Reason: `app/ChatApp.tsx` 是仓库根 app/ 下的普通文件。",
            evidenceRefs: ["file:app/ChatApp.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "Conclusion: 存在。",
            acceptedFindingIds: ["f1", "f2"],
            rejectedFindingIds: [],
            evidenceRefs: [
              "file:/Users/yuanzexiang/Documents/pi-agent/diga-agent/app/ChatApp.tsx",
              "file:app/ChatApp.tsx",
            ],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("存在 — 已确认 `app/ChatApp.tsx` 在当前项目中。");
    expect(summary?.verdict).not.toContain("Conclusion");
  });

  it("keeps existence answers anchored to the file from the user query", () => {
    const base = createInitialAgentTeamRun(
      "只读确认 app/page.tsx 是否存在，并用一句中文回答“存在/不存在 + 原因”。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "存在 — 已确认 Next.js 在当前项目中。",
            evidenceRefs: ["file:app/page.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "存在 — 已确认 Next.js 在当前项目中。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/page.tsx"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("存在 — 已确认 `app/page.tsx` 在当前项目中。");
    expect(summary?.verdict).not.toContain("Next.js");
  });

  it("uses proposed answer findings when the final decision only recorded risk closure", () => {
    const base = createInitialAgentTeamRun("只读检查 app/page.tsx 是否存在。最后只回答：存在/不存在 + 一句话原因。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "当前是 Agent Team 模式：过程会进入共享白板，主聊天只保留摘要和决策入口。",
            evidenceRefs: ["workspace:board"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "存在。`app/page.tsx` 是一个普通文件，位于 Next.js App Router 根路由。",
            evidenceRefs: ["file:app/page.tsx"],
            confidence: "high" as const,
            status: "proposed" as const,
            challengeIds: [],
          },
          {
            id: "f3",
            authorAgentId: base.leadAgentId,
            claim: "风险/开放点：无；本次仅做只读校验。",
            evidenceRefs: ["file:app/page.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "风险/开放点：无；本次仅做只读校验。",
            acceptedFindingIds: ["f3"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/page.tsx"],
            sourceResultIds: ["r1"],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("存在 — 已确认 `app/page.tsx` 在当前项目中。");
    expect(summary?.verdict).not.toBe("无法确认通过。");
    expect(summary?.concise).toBe(true);
  });

  it("detects explicit concise final-answer requests", () => {
    expect(
      wantsConciseAgentTeamFinalAnswer("最终只回答：存在/不存在 + 一句话原因。")
    ).toBe(true);
    expect(
      wantsConciseAgentTeamFinalAnswer("并用一句中文回答“存在/不存在 + 原因”。")
    ).toBe(true);
    expect(
      wantsConciseAgentTeamFinalAnswer("请出一份审核报告，列出主要风险和证据。")
    ).toBe(false);
  });

  it("keeps audit bullets short when a teammate submits a long evidence-heavy finding", () => {
    const base = createInitialAgentTeamRun(
      "小范围审计：判断最终结论是否会过度输出细节。请给出最多3条结论和必要风险。"
    );
    const longFinding =
      "审计结论（最多 3 条 + 必要风险）：结论 1：最终结论不会过度输出细节。`getAgentTeamFinalSummary` 已做了三层收紧：bullets 限到 3 条、每条 bullet 的 evidence 限到 2 条、risk 只取一条、verdict 走 firstSentence 截单句，因此面板实际看到的是受控内容。定位完成。已读取 `lib/agent-team/final-summary.ts` 和 `app/components/MessageView.tsx`。";
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        decisions: [],
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: longFinding,
            evidenceRefs: [
              "file:lib/agent-team/final-summary.ts",
              "file:app/components/MessageView.tsx",
              "session:current",
            ],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const visibleText = [summary?.verdict, ...(summary?.bullets ?? [])].join("\n");

    expect(summary?.verdict).toBe("最终结论不会过度输出细节。");
    expect(summary?.bullets).toHaveLength(1);
    expect(summary?.bullets[0].length).toBeLessThanOrEqual(240);
    expect(visibleText).not.toContain("定位完成");
    expect(visibleText).not.toContain("已读取");
    expect(visibleText).not.toContain("证据来源");
  });

  it("shapes overall assessment answers into capability, gap, and next-step bullets", () => {
    const base = createInitialAgentTeamRun(
      "帮我看一下 agent team 相关链路整体怎么样，目前主要问题和下一步是什么。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "基础协作链路已经跑通，成员记录、任务流和最终回答都已经有可用入口。",
            evidenceRefs: ["file:app/components/WorkbenchSidebar.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "主要问题是自动推进、最终回答质量和状态解释仍不够稳定，用户容易误以为团队卡住。",
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f3",
            authorAgentId: base.leadAgentId,
            claim: "建议下一步优先补齐后端自动推进兜底、最终回答 adapter 和任务流降噪的端到端验收。",
            evidenceRefs: ["file:docs/agent-team-remaining-technical-plan.md"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale:
              "整体完成度中等偏上：基础链路可用，但还没有到稳定产品态。",
            acceptedFindingIds: ["f1", "f2", "f3"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/components/WorkbenchSidebar.tsx"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const bullets = summary?.bullets ?? [];

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toBe("整体完成度中等偏上：基础链路可用，但还没有到稳定产品态。");
    expect(bullets[0]).toContain("已具备：");
    expect(bullets[1]).toContain("主要缺口：");
    expect(bullets[2]).toContain("下一步：");
    expect([summary?.verdict, ...bullets].join(" ")).not.toMatch(/quality gates|provider stream|TEAM_RESULT_JSON|共享白板/i);
  });

  it("combines multiple file existence findings into the visible verdict", () => {
    const base = createInitialAgentTeamRun(
      "只读确认 app/page.tsx 是否存在，以及 definitely-not-a-real-file-xyz.ts 是否不存在。最后用两句话回答。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim:
              "`app/page.tsx` 存在（ls app/page.tsx 直接命中）。`definitely-not-a-real-file-xyz.ts` 不存在（ls 返回 No such file）。",
            evidenceRefs: ["file:app/page.tsx", "file:definitely-not-a-real-file-xyz.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toContain("存在 — 已确认 `app/page.tsx` 在当前项目中。");
    expect(summary?.verdict).toContain("不存在 — 当前项目里没有找到 `definitely-not-a-real-file-xyz.ts`。");
  });

  it("preserves root json filenames in file existence verdicts", () => {
    const base = createInitialAgentTeamRun(
      "只读确认 package.json 是否存在。最终只用一句中文回答。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f-package",
            authorAgentId: base.leadAgentId,
            claim: "存在 — 已确认 `package.json` 在当前项目中。",
            evidenceRefs: ["file:package.json"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("存在 — 已确认 `package.json` 在当前项目中。");
    expect(summary?.verdict).not.toContain("`package.js`");
  });

  it("uses matching file evidence as existence proof even when the claim is process wording", () => {
    const base = createInitialAgentTeamRun(
      "只读确认 app/page.tsx 是否存在。最终只用一句中文回答：存在/不存在 + 一句话证据。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "已读取 app/page.tsx，但没有找到与本次问题直接对应的实现线索。",
            evidenceRefs: ["file:app/page.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "已读取 app/page.tsx，但没有找到与本次问题直接对应的实现线索。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/page.tsx"],
            sourceResultIds: [],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("存在 — 已确认 `app/page.tsx` 在当前项目中。");
    expect(summary?.verdict).not.toContain("无法确认");
  });

  it("uses unknown wording for existence checks when evidence is insufficient", () => {
    const base = createInitialAgentTeamRun("只读检查 app/page.tsx 是否存在。最后只回答：存在/不存在 + 一句话原因。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "不通过：成员结果为空或供应商断流，无法形成真实可采纳发现；本次只能带风险收束。",
            evidenceRefs: ["task:synthesis"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale: "用户点击生成总结；现有成员结果不足，未完成关键任务已由负责人接管。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["task:synthesis"],
            sourceResultIds: [],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.intent).toBe("verification");
    expect(summary?.verdict).toBe("暂无法确认：现有信息不足以支撑明确判断。");
    expect(summary?.verdict).not.toMatch(/^通过|^不通过|无法确认通过/);
  });

  it("does not treat generic validation labels as pass/fail questions", () => {
    const base = createInitialAgentTeamRun("手动总结修复验证：只读检查 app/page.tsx 是否存在。");
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "不通过：当前无法形成可靠结论，现有信息不足以支撑最终判断。",
            evidenceRefs: ["task:synthesis"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale: "不通过：当前无法形成可靠结论，现有信息不足以支撑最终判断。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["task:synthesis"],
            sourceResultIds: [],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.verdict).toBe("暂无法确认：现有信息不足以支撑明确判断。");
  });

  it("exposes prompt guidance for intent-aware final answers", () => {
    const prompt = agentTeamFinalAnswerPromptGuidelines();

    expect(classifyAgentTeamFinalAnswerIntent("是否已经修复？")).toBe("verification");
    expect(classifyAgentTeamFinalAnswerIntent("接下来怎么优化？")).toBe("recommendation");
    expect(prompt).toContain("First classify the user's original request");
    expect(prompt).toContain("Use pass/fail/unknown only for verification-style requests");
    expect(prompt).toContain("Do not mention internal mechanics");
  });

  it("classifies '审核报告' requests as audit even when they contain 是否/有没有", () => {
    // 复现 issue：审核类需求里夹带“是否”不应被误判为 verification。
    expect(
      classifyAgentTeamFinalAnswerIntent(
        "帮我检查一下全部和会话相关的功能点 看下是否有异常不合理的逻辑。出一个审核报告"
      )
    ).toBe("audit");
    expect(
      classifyAgentTeamFinalAnswerIntent("看下代码有没有 bug，出个审查报告")
    ).toBe("audit");
    // 纯验证表述仍归 verification，不被误伤。
    expect(classifyAgentTeamFinalAnswerIntent("这个功能完成了吗")).toBe("verification");
    expect(classifyAgentTeamFinalAnswerIntent("是否已经修复？")).toBe("verification");
  });

  it("surfaces reported findings for an audit request instead of '暂无法确认'", () => {
    // 复现 issue：子 agent 已上报发现，audit 需求应给出发现，而不是落到
    // “现有信息不足以支撑明确判断”的兜底。这里模拟 synthesize 之后的盘面
    // （finding accepted + 有 decision），与真实运行链路一致。
    const base = createInitialAgentTeamRun(
      "帮我检查一下全部和会话相关的功能点 看下是否有异常不合理的逻辑。出一个审核报告"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "F1 代码重复降级为命名约定，真正的问题归到 F2 的状态机分支。",
            evidenceRefs: ["file:lib/agent-team/runtime.ts"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        challenges: [],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale: "基于当前已有发现给出阶段性结论，并保留未完成部分的风险。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:lib/agent-team/runtime.ts"],
            sourceResultIds: ["r1"],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).not.toContain("暂无法确认");
    expect(summary?.verdict).toContain("F1");
  });

  it("keeps concrete reasons and evidence for audit requests that ask for code positions", () => {
    const base = createInitialAgentTeamRun(
      "小范围只读审计：检查 app/components/MessageView.tsx 和 app/components/WorkbenchSidebar.tsx 里 Agent Team 卡片/侧栏的信息展示是否还有明显重复、机器文案或状态不一致。最终请给出：通过/不通过 + 1-3 条具体原因，必须引用具体文件或代码位置。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim:
              "不通过：MessageView 的最终结论只展示 verdict，没有把 bullets/rationale 渲染到会话里，导致用户要求的具体原因丢失。",
            evidenceRefs: ["file:app/components/MessageView.tsx:563-574"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim:
              "WorkbenchSidebar 的任务流仍可能把成员启动、任务完成等过程事件平铺出来，信息密度偏高，需要聚合静态节点。",
            evidenceRefs: ["file:app/components/WorkbenchSidebar.tsx:1214-1225"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale:
              "不通过：仍有最终结论原因丢失和侧栏过程信息密度过高的问题，需要继续修。",
            acceptedFindingIds: ["f1", "f2"],
            rejectedFindingIds: [],
            evidenceRefs: [
              "file:app/components/MessageView.tsx:563-574",
              "file:app/components/WorkbenchSidebar.tsx:1214-1225",
            ],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const bullets = summary?.bullets.join(" ") ?? "";

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toContain("不通过");
    expect(summary?.bullets.length).toBeGreaterThanOrEqual(2);
    expect(bullets).toContain("MessageView");
    expect(bullets).toContain("WorkbenchSidebar");
    expect(bullets).toContain("app/components/MessageView.tsx:563-574");
    expect(bullets).toContain("app/components/WorkbenchSidebar.tsx:1214-1225");
  });

  it("filters low-value section headings from adapted audit bullets", () => {
    const base = createInitialAgentTeamRun(
      "小范围只读审计：检查 Agent Team 展示是否还有明显问题。最终请给出具体原因。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "同一触发条件在主卡和侧栏文案不一致，用户会难以判断是否需要操作。",
            evidenceRefs: ["file:app/components/MessageView.tsx", "file:app/components/WorkbenchSidebar.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "风险/建议（不修改文件，仅供参考）",
            evidenceRefs: ["file:app/components/MessageView.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f3",
            authorAgentId: base.leadAgentId,
            claim: "证据来源（已读、未修改）：",
            evidenceRefs: ["file:app/components/WorkbenchSidebar.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f4",
            authorAgentId: base.leadAgentId,
            claim: "`app/components/MessageView.tsx`",
            evidenceRefs: ["file:app/components/MessageView.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");
    const bullets = summary?.bullets.join(" ") ?? "";

    expect(answer).toContain("同一触发条件");
    expect(bullets).not.toContain("风险/建议");
    expect(bullets).not.toContain("证据来源");
    expect(summary?.bullets).not.toContain("`app/components/MessageView.tsx`");
  });

  it("keeps team process noise out of audit final answers", () => {
    const base = createInitialAgentTeamRun(
      "帮我检查一下 agent team 相关代码，看目前功能是否完整，agent 之间协同链路是否有明显问题，并引用代码位置。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim:
              "当前是 Agent Team 模式：过程会进入共享白板，主聊天只保留摘要和决策入口。",
            evidenceRefs: ["workspace:board"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim:
              "成员创建后仍需要额外推进才会领取任务，容易让用户误以为团队卡住。",
            evidenceRefs: ["file:lib/agent-team/runtime.ts", "file:app/components/MessageView.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale:
              "用户选择带风险生成最终综合。基于当前团队过程，已有信息足以给出阶段性综合；Finalize blocked by quality gates.",
            acceptedFindingIds: ["f1", "f2"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:lib/agent-team/runtime.ts"],
            sourceResultIds: ["r1"],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [
      summary?.verdict,
      summary?.rationale,
      ...(summary?.bullets ?? []),
      summary?.risk,
    ].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toBe("成员创建后仍需要额外推进才会领取任务，容易让用户误以为团队卡住。");
    expect(answer).not.toMatch(/共享白板|主聊天|Agent Team 模式|用户选择|quality gates|质量门禁|阶段性综合|Finalize/i);
    expect(answer).toContain("lib/agent-team/runtime.ts");
  });

  it("keeps multiple concrete findings for open audit questions", () => {
    const base = createInitialAgentTeamRun(
      "帮我看看 agent team 这个能力整体是否完整，有哪些主要问题。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "自动推进链路已经可用，但成员创建后仍可能停在待分配状态，用户会误以为卡住。",
            evidenceRefs: ["file:lib/agent-team/runtime.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "完成态展示仍需要过滤历史恢复噪音，否则会让用户以为任务还在等待重派。",
            evidenceRefs: ["file:app/components/MessageView.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f3",
            authorAgentId: base.leadAgentId,
            claim: "成员分工和任务流需要降低默认信息密度，把排查细节收进展开态。",
            evidenceRefs: ["file:app/components/WorkbenchSidebar.tsx"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale: "整体可用但还没到稳定产品化：自动推进、完成态表达和默认信息密度仍是主要问题。",
            acceptedFindingIds: ["f1", "f2", "f3"],
            rejectedFindingIds: [],
            evidenceRefs: [
              "file:lib/agent-team/runtime.ts",
              "file:app/components/MessageView.tsx",
              "file:app/components/WorkbenchSidebar.tsx",
            ],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toBe("整体可用但还没到稳定产品化：自动推进、完成态表达和默认信息密度仍是主要问题。");
    expect(summary?.bullets.length).toBeGreaterThanOrEqual(2);
    expect(answer).toContain("自动推进链路已经可用");
    expect(answer).toContain("完成态展示");
    expect(answer).toContain("成员分工和任务流");
    expect(answer).not.toMatch(/共享白板|quality gates|lead override|provider stream/i);
  });

  it("leads with an overall assessment for broad capability questions", () => {
    const base = createInitialAgentTeamRun(
      "帮我看下 agent team 目前整体完成度如何，协同链路还有哪些缺口。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "成员启动和记录追溯已经具备基础链路。",
            evidenceRefs: ["file:lib/agent-team/runtime.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "自动推进和最终回答仍不够稳定，会让用户误以为团队卡住或没有给出真实结论。",
            evidenceRefs: ["file:app/components/MessageView.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale:
              "整体完成度中等偏上：基础协作链路已经跑通，但自动推进、最终回答和状态解释还需要继续打磨。",
            acceptedFindingIds: ["f1", "f2"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:lib/agent-team/runtime.ts"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toBe(
      "整体完成度中等偏上：基础协作链路已经跑通，但自动推进、最终回答和状态解释还需要继续打磨。"
    );
    expect(answer).toContain("成员启动和记录追溯");
    expect(answer).toContain("自动推进和最终回答");
    expect(answer).not.toMatch(/quality gates|provider stream|TEAM_RESULT_JSON|共享白板/i);
  });

  it("does not reduce mixed existence and capability checks to file existence only", () => {
    const base = createInitialAgentTeamRun(
      "请确认 lib/agent-team/final-summary.ts 是否存在，并判断最终回答 adapter 是否能区分整体评估类问题。最终用两句话回答结论和证据。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim: "存在 — 已确认 lib/agent-team/final-summary.ts 在当前项目中。",
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim: "最终回答 adapter 已能把“整体是否完整、主要问题是什么”这类问题识别为审计/评估，而不是简单通过/不通过验证。",
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale:
              "final-summary.ts 存在，且 adapter 已能区分整体评估类问题；证据来自 classifyAgentTeamFinalAnswerIntent 的评估分支。",
            acceptedFindingIds: ["f1", "f2"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            sourceResultIds: ["r1"],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.concise).toBe(false);
    expect(summary?.verdict).toContain("最终回答 adapter");
    expect(answer).toContain("存在");
    expect(answer).toContain("lib/agent-team/final-summary.ts");
    expect(answer).toContain("整体是否完整");
  });

  it("keeps evidence when a two-sentence mixed audit answer comes from a compact verdict", () => {
    const base = createInitialAgentTeamRun(
      "请确认 lib/agent-team/final-summary.ts 是否存在，并判断最终回答 adapter 是否能区分整体评估类问题。最终用两句话回答结论和证据。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim:
              "部分通过：已在 lib/agent-team/final-summary.ts 找到成员结果整理、最终回答生成的相关实现线索。",
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "Team 最终综合",
            rationale:
              "部分通过：已在 lib/agent-team/final-summary.ts 找到成员结果整理、最终回答生成的相关实现线索。",
            acceptedFindingIds: ["f1"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:lib/agent-team/final-summary.ts"],
            sourceResultIds: ["r1"],
            confidence: "medium" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.concise).toBe(false);
    expect(summary?.verdict).toContain("部分通过");
    expect(answer).toContain("lib/agent-team/final-summary.ts");
    expect(summary?.bullets.length).toBeGreaterThanOrEqual(1);
    expect(summary?.bullets.join("\n")).not.toMatch(/final-summary\s*$/m);
    expect(summary?.bullets.join("\n")).not.toMatch(/^ts\s+/m);
  });

  it("does not fake a pass/fail audit conclusion when only process fallback remains", () => {
    const base = createInitialAgentTeamRun(
      "帮我审计一下 Agent Team 能力整体是否完整，指出主要问题。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      board: {
        ...base.board,
        findings: [
          {
            id: "f1",
            authorAgentId: base.leadAgentId,
            claim:
              "不通过：成员结果为空或供应商断流，无法形成真实可采纳发现；本次只能带风险收束。",
            evidenceRefs: ["task:collect-evidence"],
            confidence: "low" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
          {
            id: "f2",
            authorAgentId: base.leadAgentId,
            claim:
              "当前是 Agent Team 模式：过程会进入共享白板，主聊天只保留摘要和决策入口。",
            evidenceRefs: ["workspace:board"],
            confidence: "low" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "d1",
            title: "使用已有结果生成最终综合",
            rationale:
              "用户选择带风险生成最终综合。No teammate output was captured. provider stream error.",
            acceptedFindingIds: ["f1", "f2"],
            rejectedFindingIds: [],
            evidenceRefs: ["task:collect-evidence"],
            sourceResultIds: [],
            confidence: "low" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const summary = getAgentTeamFinalSummary(run);
    const answer = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(summary?.intent).toBe("audit");
    expect(summary?.verdict).toBe("这次没有拿到足够可靠的团队结论；建议重试自动处理，或切换到稳定模型后再跑一次。");
    expect(answer).not.toMatch(/不通过|No teammate output|provider stream|共享白板|用户选择/i);
  });
});
