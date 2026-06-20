import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("MessageView CoT/toolchain UX safeguards", () => {
  const source = () =>
    readFileSync(path.join(process.cwd(), "app/components/MessageView.tsx"), "utf8");

  it("keeps workflow runs traceable and does not hide older artifacts/checkpoints", () => {
    const text = source();

    expect(text).toContain("Workflow id:");
    expect(text).toContain("查看全部（{items.length}）");
    expect(text).toContain("Artifacts ({part.artifacts.length})");
    expect(text).toContain("Checkpoints ({part.checkpoints.length})");
    expect(text).toContain("WorkflowStageProgress");
    expect(text).toContain("Run timeline ({part.traceEvents.length})");
    expect(text).toContain("WorkflowValueContent");
    expect(text).toContain("item.badge === \"result\"");
    expect(text).toContain("item.badge === \"diff\"");
    expect(text).toContain("workflowWarningArtifactNames(warnings)");
    expect(text).toContain("data-quality-warning={item.invalid || undefined}");
    expect(text).toContain("需补强");
  });

  it("labels multi-part thinking and subagent task status in the collapsed header", () => {
    const text = source();

    expect(text).toContain("{index}/{total}");
    expect(text).toContain("subagentRoleLabel(task.role)");
    expect(text).toContain("subagentStatusLabel(task.status)");
    expect(text).toContain("失败子任务：");
    expect(text).toContain("data-testid=\"subagent-task-grid\"");
    expect(text).toContain("子任务状态汇总");
    expect(text).toContain("超时 ${timeoutCount}");
    expect(text).toContain("复制思考");
    expect(text).toContain("继续");
    expect(text).toContain("rawLabel.length > 64");
    expect(text).toContain("1px solid var(--border-soft)");
  });
});
