import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createPowerSaveController } = require("./power-save") as {
  createPowerSaveController: (powerSaveBlocker: {
    start: (type: string) => number;
    stop: (id: number) => void;
    isStarted: (id: number) => boolean;
  }) => {
    setKeepAwakeEnabled: (enabled: boolean) => { enabled: boolean; id: number | null };
    getKeepAwakeStatus: () => { enabled: boolean; id: number | null };
  };
};

describe("power-save keepAwake controller", () => {
  let started = new Set<number>();
  let nextId = 1;
  const fakeBlocker = {
    start: vi.fn((type: string) => {
      expect(type).toBe("prevent-app-suspension");
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      started.delete(id);
    }),
    isStarted: vi.fn((id: number) => started.has(id)),
  };

  beforeEach(() => {
    started = new Set<number>();
    nextId = 1;
    vi.clearAllMocks();
  });

  it("starts prevent-app-suspension when enabled", () => {
    const controller = createPowerSaveController(fakeBlocker);
    expect(controller.setKeepAwakeEnabled(true)).toEqual({ enabled: true, id: 1 });
    expect(fakeBlocker.start).toHaveBeenCalledTimes(1);
    expect(controller.getKeepAwakeStatus()).toEqual({ enabled: true, id: 1 });
  });

  it("does not start duplicate blockers", () => {
    const controller = createPowerSaveController(fakeBlocker);
    controller.setKeepAwakeEnabled(true);
    controller.setKeepAwakeEnabled(true);
    expect(fakeBlocker.start).toHaveBeenCalledTimes(1);
  });

  it("stops the blocker when disabled", () => {
    const controller = createPowerSaveController(fakeBlocker);
    controller.setKeepAwakeEnabled(true);
    expect(controller.setKeepAwakeEnabled(false)).toEqual({
      enabled: false,
      id: null,
    });
    expect(fakeBlocker.stop).toHaveBeenCalledWith(1);
    expect(controller.getKeepAwakeStatus()).toEqual({
      enabled: false,
      id: null,
    });
  });
});
