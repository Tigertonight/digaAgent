import "server-only";
import { runDueLongTasks } from "@/lib/tasks/runner";
import type { LongTaskDashboard, LongTaskSchedulerState } from "@/lib/tasks/types";

const DEFAULT_INTERVAL_MS = 60_000;

interface SchedulerMemory extends LongTaskSchedulerState {
  timer: ReturnType<typeof setInterval> | null;
}

const g = globalThis as unknown as { __digaAgentLongTaskScheduler?: SchedulerMemory };
if (!g.__digaAgentLongTaskScheduler) {
  g.__digaAgentLongTaskScheduler = {
    enabled: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    running: false,
    timer: null,
  };
}
const scheduler = g.__digaAgentLongTaskScheduler;

export function ensureLongTaskScheduler(): LongTaskSchedulerState {
  if (scheduler.timer) return getLongTaskSchedulerState();
  scheduler.enabled = true;
  scheduler.intervalMs = DEFAULT_INTERVAL_MS;
  scheduler.timer = setInterval(() => {
    void tickLongTaskScheduler();
  }, scheduler.intervalMs);
  scheduler.timer.unref?.();
  void tickLongTaskScheduler();
  return getLongTaskSchedulerState();
}

export function getLongTaskSchedulerState(): LongTaskSchedulerState {
  return {
    enabled: scheduler.enabled,
    intervalMs: scheduler.intervalMs,
    running: scheduler.running,
    lastCheckedAt: scheduler.lastCheckedAt,
    lastStartedCount: scheduler.lastStartedCount,
    lastError: scheduler.lastError,
  };
}

export function attachLongTaskSchedulerState(
  dashboard: LongTaskDashboard
): LongTaskDashboard {
  return { ...dashboard, scheduler: getLongTaskSchedulerState() };
}

export async function tickLongTaskScheduler(): Promise<LongTaskSchedulerState> {
  if (scheduler.running) return getLongTaskSchedulerState();
  scheduler.running = true;
  scheduler.lastCheckedAt = Date.now();
  scheduler.lastError = undefined;
  try {
    const started = await runDueLongTasks();
    scheduler.lastStartedCount = started.length;
  } catch (e) {
    scheduler.lastError = (e as Error).message;
    scheduler.lastStartedCount = 0;
  } finally {
    scheduler.running = false;
  }
  return getLongTaskSchedulerState();
}

export function __resetLongTaskSchedulerForTest(): void {
  if (scheduler.timer) clearInterval(scheduler.timer);
  scheduler.enabled = false;
  scheduler.intervalMs = DEFAULT_INTERVAL_MS;
  scheduler.running = false;
  scheduler.timer = null;
  scheduler.lastCheckedAt = undefined;
  scheduler.lastStartedCount = undefined;
  scheduler.lastError = undefined;
}
