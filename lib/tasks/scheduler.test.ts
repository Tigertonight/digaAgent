import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runner", () => ({
  runDueLongTasks: vi.fn(),
}));

describe("long task scheduler", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const scheduler = await import("./scheduler");
    scheduler.__resetLongTaskSchedulerForTest();
    const runner = await import("./runner");
    vi.mocked(runner.runDueLongTasks).mockReset();
  });

  afterEach(async () => {
    const scheduler = await import("./scheduler");
    scheduler.__resetLongTaskSchedulerForTest();
    vi.useRealTimers();
  });

  it("starts a background timer and records scheduler state", async () => {
    const scheduler = await import("./scheduler");
    const runner = await import("./runner");
    vi.mocked(runner.runDueLongTasks).mockResolvedValue([]);

    const state = scheduler.ensureLongTaskScheduler();
    await vi.runOnlyPendingTimersAsync();

    expect(state.enabled).toBe(true);
    expect(scheduler.getLongTaskSchedulerState()).toMatchObject({
      enabled: true,
      running: false,
      lastStartedCount: 0,
    });
    expect(runner.runDueLongTasks).toHaveBeenCalled();
  });

  it("does not re-enter while a scan is already running", async () => {
    const scheduler = await import("./scheduler");
    const runner = await import("./runner");
    let resolveRun: (value: []) => void = () => {};
    vi.mocked(runner.runDueLongTasks).mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      })
    );

    const first = scheduler.tickLongTaskScheduler();
    const second = scheduler.tickLongTaskScheduler();

    expect(runner.runDueLongTasks).toHaveBeenCalledTimes(1);
    resolveRun([]);
    await first;
    await second;
    expect(scheduler.getLongTaskSchedulerState().running).toBe(false);
  });
});
