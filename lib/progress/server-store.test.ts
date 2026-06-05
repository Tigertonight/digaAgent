import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetProgressStoreForTest,
  failOpenProgress,
  updateProgress,
} from "./server-store";

describe("progress server store", () => {
  beforeEach(() => {
    __resetProgressStoreForTest();
  });

  it("marks running and pending steps failed when aborted", () => {
    updateProgress("agent-1", {
      replaceSteps: true,
      steps: [
        { id: "done", title: "Done", status: "completed" },
        { id: "run", title: "Running", status: "running" },
        { id: "next", title: "Next", status: "pending" },
      ],
    });

    const progress = failOpenProgress("agent-1", "User stopped it.");

    expect(progress.steps.map((step) => [step.id, step.status])).toEqual([
      ["done", "completed"],
      ["run", "failed"],
      ["next", "failed"],
    ]);
    expect(progress.groups[0]?.endedAt).toEqual(expect.any(Number));
    expect(progress.steps[1]?.summary).toContain("User stopped it.");
    expect(progress.steps[2]?.completedAt).toEqual(expect.any(Number));
  });
});
