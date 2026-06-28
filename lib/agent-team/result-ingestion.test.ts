import { describe, expect, it } from "vitest";
import {
  createAgentTeamResultPrompt,
  isUsableAgentTeamResultText,
  normalizeAgentTeamResult,
  parseAgentTeamResultText,
} from "./result-ingestion";

describe("agent team result ingestion", () => {
  it("parses TEAM_RESULT_JSON fenced output", () => {
    const parsed = parseAgentTeamResultText([
      "Done.",
      "```TEAM_RESULT_JSON",
      JSON.stringify({
        summary: "Evidence gathered.",
        findings: [
          {
            claim: "The board needs accepted findings.",
            evidenceRefs: ["session:/tmp/team.jsonl"],
            confidence: "high",
          },
        ],
        challenges: [
          {
            reason: "Check whether evidence is sufficient.",
            severity: "low",
            requiredEvidenceRefs: ["session:/tmp/team.jsonl"],
          },
        ],
        needsFollowUp: false,
      }),
      "```",
    ].join("\n"));

    expect(parsed.summary).toBe("Evidence gathered.");
    expect(parsed.findings[0]?.claim).toBe("The board needs accepted findings.");
    expect(parsed.challenges[0]?.severity).toBe("low");
    expect(parsed.warnings).toEqual([]);
  });

  it("warns when structured findings are missing evidence", () => {
    const parsed = parseAgentTeamResultText(JSON.stringify({
      summary: "Weak result.",
      findings: [{ claim: "No evidence here." }],
    }));

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.warnings.some((warning) => warning.includes("evidence"))).toBe(true);
    expect(parsed.reasonCodes).toContain("missing_evidence");
  });

  it("uses task target filenames as evidence when model omits file: prefix", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: "结论：不存在。没有找到 definitely-not-a-real-file-xyz.ts。",
      mode: "audit",
      taskTitle: "定位代码与证据",
      taskDescription: "只读确认 definitely-not-a-real-file-xyz.ts 是否存在。",
    });

    expect(parsed.source).toBe("adapter");
    expect(parsed.findings[0]?.evidenceRefs).toContain(
      "file:definitely-not-a-real-file-xyz.ts"
    );
    expect(parsed.reasonCodes).not.toContain("missing_evidence");
  });

  it("classifies missing and invalid structured output", () => {
    const missing = parseAgentTeamResultText("Done.");
    const invalid = parseAgentTeamResultText("TEAM_RESULT_JSON:\n```json\n{\"summary\":");

    expect(missing.reasonCodes).toContain("missing_structured_result");
    expect(invalid.reasonCodes).toContain("invalid_result_json");
  });

  it("adapts natural language teammate replies into findings", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "发现：Team runtime 会在 lib/agent-team/runtime.ts 中根据 teammate result 更新 board。",
        "风险：如果没有 evidence，严格审计模式应该继续要求复核。",
      ].join("\n"),
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(parsed.source).toBe("adapter");
    expect(parsed.adaptedFromNaturalLanguage).toBe(true);
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:lib/agent-team/runtime.ts");
  });

  it("strengthens audit prompts with mandatory evidence instructions", () => {
    const prompt = createAgentTeamResultPrompt("检查目标文件是否存在。", {
      mode: "audit",
      evidenceRequired: true,
    });

    expect(prompt).toContain("Evidence is required");
    expect(prompt).toContain("file:app/example.ts");
    expect(prompt).toContain("If the target is missing");
  });

  it("adapts acceptance-style verification replies into findings", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "1. **新建 Team 后是否会自动分配任务 → 通过。**",
        "证据：app/ChatApp.tsx:2689-2706 中启动 Team 后会调用 run_until_idle。",
        "2. **侧栏是否不再要求用户主动点继续推进 → 通过。**",
        "证据：app/components/WorkbenchSidebar.tsx:1013-1018 只在没有活跃任务和成员时显示兜底按钮。",
      ].join("\n"),
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(parsed.source).toBe("adapter");
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]?.claim).toContain("通过");
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:app/ChatApp.tsx:2689-2706");
    expect(parsed.findings[1]?.evidenceRefs).toContain(
      "file:app/components/WorkbenchSidebar.tsx:1013-1018"
    );
  });

  it("adapts markdown reports with numbered findings instead of misreading code braces as JSON", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "## Task: 定位代码与证据",
        "",
        "**Summary**: `app/ChatApp.tsx` 在仓库中存在，组件签名为 `ChatApp({ initialSessions, defaultCwd }: Props)`。",
        "",
        "**Findings**:",
        "- F1. 文件存在：仓库根下 `app/ChatApp.tsx`，4589 行 / 172,460 字节。",
        "- F2. 形态正确：首行 `\"use client\";`，并存在 `export default function ChatApp({ initialSessions, defaultCwd }: Props)`。",
        "- F3. 消费方存在：`app/page.tsx:1` 存在 `import ChatApp from \"./ChatApp\";`。",
        "",
        "**Evidence**:",
        "- file:app/ChatApp.tsx:768",
        "- file:app/page.tsx:1",
        "",
        "**Risks / Open Questions**:",
        "- R1. 本次只验证文件存在，未跑 build。",
      ].join("\n"),
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(parsed.source).toBe("adapter");
    expect(parsed.reasonCodes).not.toContain("invalid_result_json");
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.findings[0]?.claim).toContain("文件存在");
    expect(parsed.findings[0]?.claim).not.toContain("F1");
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:app/ChatApp.tsx:768");
    expect(parsed.findings[1]?.evidenceRefs).toContain("file:app/page.tsx:1");
  });

  it("adapts model markdown headings with parenthesized findings labels", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "### Findings (critic 视角)",
        "- F1. 不通过：成员结果为空，无法形成真实可采纳发现。",
        "- F2. 风险：provider stream 提前结束，最终总结只能带风险收束。",
        "",
        "### Evidence",
        "- file:lib/agent-team/result-ingestion.ts:1",
      ].join("\n"),
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(parsed.source).toBe("adapter");
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]?.claim).toContain("不通过");
    expect(parsed.findings[0]?.claim).not.toContain("F1");
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:lib/agent-team/result-ingestion.ts:1");
  });

  it("accepts common model JSON variants from team_submit_result", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "TEAM_RESULT_JSON",
        JSON.stringify({
          summary: "验收完成。",
          findings: [
            {
              title: "新建 Team 后会自动触发 run_until_idle",
              evidence: ["file:app/ChatApp.tsx:2685-2706"],
            },
            {
              title: "侧栏 happy path 不再展示手动推进按钮",
              evidence: ["file:app/components/WorkbenchSidebar.tsx:1013-1017"],
            },
          ],
          evidenceRefs: ["file:app/api/agent/[id]/teams/route.ts:1087-1200"],
        }),
      ].join("\n"),
      mode: "collaboration",
    });

    expect(parsed.source).toBe("contract");
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]?.claim).toContain("run_until_idle");
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:app/ChatApp.tsx:2685-2706");
  });

  it("does not adapt captured empty/provider-error output into findings", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: "No teammate output was captured.",
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(isUsableAgentTeamResultText("No teammate output was captured.")).toBe(false);
    expect(parsed.summary).toBe("没有拿到可采纳的成员结果。");
    expect(parsed.summary).not.toContain("No teammate output");
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.reasonCodes).toContain("provider_stream_error");
    expect(parsed.warnings.join(" ")).toContain("provider stream ended");
  });

  it("recovers a usable deterministic outcome even if provider error text is present", () => {
    const rawText = [
      "存在：app/page.tsx 在当前项目中。",
      "证据：file:app/page.tsx",
      "说明：Dispatch failed: Member model error: Stream ended without finish_reason",
    ].join("\n");
    const parsed = normalizeAgentTeamResult({
      rawText,
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(isUsableAgentTeamResultText(rawText)).toBe(true);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.claim).toContain("app/page.tsx");
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:app/page.tsx");
    expect(parsed.reasonCodes).not.toContain("provider_stream_error");
  });

  it("does not turn evidence or explanatory lines into separate findings", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "存在：app/page.tsx 在当前项目中。",
        "证据：file:app/page.tsx",
        "说明：团队负责人使用本地文件检查收束这个简单存在性任务。",
      ].join("\n"),
      mode: "collaboration",
    });

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.claim).toBe("存在：app/page.tsx 在当前项目中。");
  });

  it("does not adapt provider auth errors into findings", () => {
    const rawText = "Dispatch failed: Member model error: No API key for provider: openai-codex";
    const parsed = normalizeAgentTeamResult({
      rawText,
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(isUsableAgentTeamResultText(rawText)).toBe(false);
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.reasonCodes).toContain("provider_stream_error");
  });

  it("does not adapt late coordination-tool rejection into findings", () => {
    const rawText = "未完成提交：团队 协调工具拒绝，原因是 `team run is not running`；无法把 validation 结果写回白板。";
    const parsed = normalizeAgentTeamResult({
      rawText,
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(isUsableAgentTeamResultText(rawText)).toBe(false);
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.reasonCodes).toContain("provider_stream_error");
  });

  it("strips internal thinking before adapting teammate replies", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "<think>The submission was successfully recorded. The Lead will pick it up for synthesis.</think>",
        "",
        "**结论：`app/ChatApp.tsx` 存在。**",
        "证据：`file:app/ChatApp.tsx`，并且 app/ChatApp.tsx 首行是 use client。",
      ].join("\n"),
      mode: "collaboration",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.summary).toContain("app/ChatApp.tsx");
    expect(parsed.findings[0]?.claim).not.toContain("<think>");
    expect(parsed.findings[0]?.claim).not.toContain("submission was successfully recorded");
    expect(parsed.findings[0]?.evidenceRefs).toContain("file:app/ChatApp.tsx");
    expect(parsed.findings[0]?.evidenceRefs).not.toContain("file:app/ChatApp.tsx`");
  });

  it("does not turn explicit no-risk notes into user decisions", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: [
        "Summary: 端到端最小验收已通过 — `app/ChatApp.tsx` 存在。",
        "Evidence: file:app/ChatApp.tsx",
        "Risks / Open Questions: 无。验收范围仅限文件存在性，未做内容或运行验证。",
      ].join("\n"),
      mode: "collaboration",
    });

    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.challenges).toHaveLength(0);
  });

  it("ignores process self-talk and empty headings in structured results", () => {
    const parsed = normalizeAgentTeamResult({
      rawText: JSON.stringify({
        summary: "<think>My critic submission has been accepted.</think>",
        findings: [
          { claim: "Risks / Open Questions:", evidenceRefs: ["file:app/ChatApp.tsx`"] },
          {
            claim: "My job is done — I provided concrete file evidence.",
            evidenceRefs: ["file:app/ChatApp.tsx`"],
          },
          {
            claim: "核心结论：app/ChatApp.tsx 文件存在。",
            evidenceRefs: ["file:app/ChatApp.tsx`"],
          },
        ],
        challenges: [
          { reason: "<think>The board now shows my review.</think>" },
          { reason: "风险：这里只验证文件存在，没有验证 UI 行为。", requiredEvidenceRefs: ["file:app/ChatApp.tsx`"] },
        ],
      }),
      mode: "collaboration",
    });

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.claim).toContain("核心结论");
    expect(parsed.findings[0]?.evidenceRefs).toEqual(["file:app/ChatApp.tsx"]);
    expect(parsed.challenges).toHaveLength(1);
    expect(parsed.summary).toContain("核心结论");
  });

  it("warns when the model copied the placeholder scaffold", () => {
    const parsed = parseAgentTeamResultText([
      "TEAM_RESULT_JSON:",
      "```json",
      JSON.stringify({
        summary: "Concise task outcome.",
        findings: [
          {
            claim: "Specific claim from your work.",
            confidence: "medium",
            evidenceRefs: ["session:current", "file:path-or-artifact"],
          },
        ],
        challenges: [
          {
            targetFindingId: "",
            reason: "Risk, contradiction, or missing evidence.",
            severity: "medium",
            requiredEvidenceRefs: [],
          },
        ],
        needsFollowUp: [],
      }),
      "```",
    ].join("\n"));

    expect(parsed.warnings).toContain("finding appears to be a copied template placeholder");
    expect(parsed.warnings.some((warning) => warning.includes("placeholder evidence"))).toBe(true);
    expect(parsed.warnings).toContain("challenge appears to be a copied template placeholder");
    expect(parsed.reasonCodes).toContain("placeholder_result");
  });

  it("adds the team result contract to dispatch prompts", () => {
    const prompt = createAgentTeamResultPrompt("Do the task.");

    expect(prompt).toContain("Do the task.");
    expect(prompt).toContain("natural language");
    expect(prompt).toContain("evidence sources");
    expect(prompt).toContain("targeted search");
    expect(prompt).toContain("Do not inspect git history/status/diff");
    expect(prompt).not.toContain("TEAM_RESULT_JSON");
    expect(prompt).not.toContain("Specific claim from your work.");
    expect(prompt).not.toContain("file:path-or-artifact");
  });
});
