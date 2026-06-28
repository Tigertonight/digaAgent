import { describe, expect, it } from "vitest";
import {
  correctNamedFileReviewVerdict,
  correctSimpleFileExistenceVerdict,
} from "./deterministic-verdict";
import { getAgentTeamFinalSummary } from "./final-summary";
import { createInitialAgentTeamRun } from "./initial-run";

describe("agent team deterministic verdict guard", () => {
  it("corrects a completed simple file existence run when the member answer was wrong", () => {
    const base = createInitialAgentTeamRun(
      "只读确认 app/__definitely_missing_agent_team_probe.ts 是否存在。最终只回答：存在/不存在 + 一句话证据。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      leadState: "finalized" as const,
      board: {
        ...base.board,
        tasks: base.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completionSource: "teammate_result" as const,
        })),
        findings: [
          {
            id: "wrong-finding",
            authorAgentId: base.leadAgentId,
            claim:
              "存在 — 已确认 `app/__definitely_missing_agent_team_probe.ts` 在当前项目中。",
            evidenceRefs: ["file:app/__definitely_missing_agent_team_probe.ts"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "wrong-decision",
            title: "最终判断",
            rationale:
              "存在 — 已确认 `app/__definitely_missing_agent_team_probe.ts` 在当前项目中。",
            acceptedFindingIds: ["wrong-finding"],
            rejectedFindingIds: [],
            evidenceRefs: ["file:app/__definitely_missing_agent_team_probe.ts"],
            sourceResultIds: [],
            confidence: "high" as const,
            status: "accepted" as const,
            madeByAgentId: base.leadAgentId,
          },
        ],
      },
    };

    const corrected = correctSimpleFileExistenceVerdict(run, {
      cwd: "/repo",
      existsSync: () => false,
      now: 123,
    });
    const summary = getAgentTeamFinalSummary(corrected.run);

    expect(corrected.corrected).toBe(true);
    expect(corrected.exists).toBe(false);
    expect(corrected.run.board.findings).toHaveLength(1);
    expect(corrected.run.board.findings[0]?.claim).toContain("不存在");
    expect(corrected.run.board.decisions.at(-1)?.rationale).toContain("不存在");
    expect(summary?.verdict).toBe(
      "不存在 — 当前项目里没有找到 `app/__definitely_missing_agent_team_probe.ts`。"
    );
  });

  it("does not touch non-completed runs", () => {
    const run = createInitialAgentTeamRun("只读确认 app/page.tsx 是否存在。");

    const corrected = correctSimpleFileExistenceVerdict(run, {
      cwd: "/repo",
      existsSync: () => true,
    });

    expect(corrected.corrected).toBe(false);
    expect(corrected.run).toBe(run);
  });

  it("does not overwrite a simple file existence verdict with named-file review fallback", () => {
    const base = createInitialAgentTeamRun(
      "只读确认 app/page.tsx 是否存在。最终只回答：存在/不存在 + 一句话证据。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      leadState: "finalized" as const,
      board: {
        ...base.board,
        tasks: base.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completionSource: "lead_override" as const,
        })),
      },
    };

    const simple = correctSimpleFileExistenceVerdict(run, {
      cwd: "/repo",
      existsSync: (absolute) => absolute.endsWith("/app/page.tsx"),
      now: 123,
    });
    const named = correctNamedFileReviewVerdict(simple.run, {
      cwd: "/repo",
      existsSync: () => true,
      readFileSync: () => "export default function Page() { return null; }",
      now: 124,
    });
    const summary = getAgentTeamFinalSummary(named.run);

    expect(simple.corrected).toBe(true);
    expect(named.corrected).toBe(false);
    expect(summary?.verdict).toBe("存在 — 已确认 `app/page.tsx` 在当前项目中。");
  });

  it("adds a named-file review verdict when provider failures left a code review empty", () => {
    const base = createInitialAgentTeamRun(
      "端到端验收 Agent Team Result Adapter 修复。只读检查 lib/agent-team/result-ingestion.ts 和 lib/agent-team/runtime.ts，确认：1 空成员输出不能整理成 finding；2 provider stream error 不会被当作完成；3 最终必须产出通过/不通过结论。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      leadState: "finalized" as const,
      blockReasons: [
        {
          code: "provider_stream_error" as const,
          severity: "warning" as const,
          message: "模型连接提前结束，服务没有返回完成标记。",
          recommendedAction: "重试自动处理。",
          entityRefs: {},
          autoActions: ["recover_team" as const],
          manualActions: ["finalize_with_risks" as const],
        },
      ],
      board: {
        ...base.board,
        tasks: base.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completionSource: "lead_override" as const,
        })),
        findings: [
          {
            id: "empty-finding",
            authorAgentId: base.leadAgentId,
            claim: "不通过：成员结果为空或供应商断流，无法形成真实可采纳发现；本次只能带风险收束。",
            evidenceRefs: ["task:evidence"],
            confidence: "low" as const,
            status: "accepted" as const,
            challengeIds: [],
          },
        ],
        decisions: [
          {
            id: "empty-decision",
            title: "使用已有结果生成最终综合",
            rationale: "用户选择带风险生成最终综合。No teammate output was captured. provider stream error.",
            acceptedFindingIds: ["empty-finding"],
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

    const files = new Map<string, string>([
      [
        "/repo/lib/agent-team/result-ingestion.ts",
        [
          "export function normalizeAgentTeamResult() {}",
          "const source = \"adapter\";",
          "const missing = \"missing_evidence\";",
        ].join("\n"),
      ],
      [
        "/repo/lib/agent-team/runtime.ts",
        [
          "const completionSource = \"lead_override\";",
          "const error = \"provider_stream_error\";",
          "function isRecoverableAgentTeamProviderFailure() {}",
        ].join("\n"),
      ],
    ]);

    const corrected = correctNamedFileReviewVerdict(run, {
      cwd: "/repo",
      existsSync: (file) => files.has(file),
      readFileSync: (file) => files.get(file) ?? "",
      now: 456,
    });
    const summary = getAgentTeamFinalSummary(corrected.run);
    const text = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(corrected.corrected).toBe(true);
    expect(corrected.run.blockReasons).toEqual([]);
    expect(corrected.run.board.findings.at(-1)?.claim).toContain("lib/agent-team/runtime.ts");
    expect(corrected.run.board.findings.at(-1)?.claim).not.toContain("lib/agent-team/.ts");
    expect(corrected.run.board.findings.some((finding) => finding.id === "empty-finding")).toBe(false);
    expect(summary?.verdict).toContain("部分通过");
    expect(text).toContain("成员结果整理");
    expect(text).toContain("模型断流处理");
    expect(text).toContain("lib/agent-team/result-ingestion.ts:1");
    expect(text).toContain("lib/agent-team/runtime.ts:2");
  });

  it("does not present issue-review fallback as partially passed", () => {
    const base = createInitialAgentTeamRun(
      "请只读审查 lib/agent-team/final-summary.ts 和 lib/agent-team/result-ingestion.ts，判断 Agent Team 最终结论和成员结果整理是否有明显体验问题。"
    );
    const run = {
      ...base,
      status: "completed" as const,
      leadState: "finalized" as const,
      board: {
        ...base.board,
        tasks: base.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completionSource: "lead_override" as const,
        })),
        decisions: [
          {
            id: "empty-decision",
            title: "使用已有结果生成最终综合",
            rationale: "provider stream error. No teammate output was captured.",
            acceptedFindingIds: [],
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

    const files = new Map<string, string>([
      [
        "/repo/lib/agent-team/final-summary.ts",
        [
          "export function getAgentTeamFinalSummary() {}",
          "export function agentTeamFinalAnswerPromptGuidelines() {}",
        ].join("\n"),
      ],
      [
        "/repo/lib/agent-team/result-ingestion.ts",
        [
          "export function normalizeAgentTeamResult() {}",
          "const source = \"adapter\";",
        ].join("\n"),
      ],
    ]);

    const corrected = correctNamedFileReviewVerdict(run, {
      cwd: "/repo",
      existsSync: (file) => files.has(file),
      readFileSync: (file) => files.get(file) ?? "",
      now: 789,
    });
    const summary = getAgentTeamFinalSummary(corrected.run);
    const text = [summary?.verdict, ...(summary?.bullets ?? [])].join(" ");

    expect(corrected.corrected).toBe(true);
    expect(text).toContain("无法完整判断");
    expect(text).toContain("体验审查");
    expect(text).not.toContain("部分通过");
  });
});
