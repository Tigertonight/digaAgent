import { describe, expect, it } from "vitest";
import { inferEvaluationProfileId } from "./profile-selector";

describe("inferEvaluationProfileId", () => {
  it("selects external-action for irreversible or public actions", () => {
    expect(
      inferEvaluationProfileId({ objective: "Deploy and publish the release" })
    ).toBe("desktop.external-action");
    expect(inferEvaluationProfileId({ objective: "删除本地文件" })).toBe(
      "desktop.external-action"
    );
  });

  it("selects frontend UI for interface work", () => {
    expect(
      inferEvaluationProfileId({ objective: "Fix React component layout" })
    ).toBe("coding.frontend-ui");
  });

  it("selects coding default for code and tests", () => {
    expect(inferEvaluationProfileId({ objective: "Fix API tests" })).toBe(
      "coding.default"
    );
  });

  it("selects desktop default for local browser or desktop tasks", () => {
    expect(inferEvaluationProfileId({ objective: "Inspect browser state" })).toBe(
      "desktop.default"
    );
  });

  it("selects LXW analysis and workflow profiles", () => {
    expect(inferEvaluationProfileId({ objective: "同步上游 Diga 更新" })).toBe(
      "upstream.sync"
    );
    expect(inferEvaluationProfileId({ objective: "评测这个 skill 的负样本" })).toBe(
      "skill.eval"
    );
    expect(inferEvaluationProfileId({ objective: "帮老师做课堂练习" })).toBe(
      "teacher.workflow"
    );
    expect(inferEvaluationProfileId({ objective: "做一次问题归因复盘" })).toBe(
      "attribution.analysis"
    );
    expect(inferEvaluationProfileId({ objective: "做网页调研并标注证据" })).toBe(
      "analysis.research"
    );
  });

  it("falls back to workflow default", () => {
    expect(inferEvaluationProfileId({ objective: "Plan a harness checkpoint" })).toBe(
      "workflow.default"
    );
    expect(inferEvaluationProfileId({ objective: "General analysis" })).toBe(
      "workflow.default"
    );
  });
});
