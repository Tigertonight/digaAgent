import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { BrowserSnapshot } from "@/lib/browser/types";
import type { AgentProgress } from "@/lib/progress/types";
import {
  describeBrowserStatus,
  loadStoredWorkbenchTabs,
  normalizedGroups,
  summarizeProgress,
  tabFromView,
  upsertWorkbenchTab,
  viewFromTab,
  type WorkbenchView,
} from "./WorkbenchSidebar";

function progressFixture(): AgentProgress {
  return {
    updatedAt: 100,
    artifacts: [],
    steps: [],
    groups: [
      {
        id: "g1",
        index: 1,
        startedAt: 1,
        steps: [
          { id: "scan", title: "Scan", status: "completed" },
          { id: "audit-a", title: "Audit A", status: "completed" },
        ],
      },
      {
        id: "g2",
        index: 2,
        startedAt: 2,
        steps: [
          { id: "audit-b", title: "Audit B", status: "running" },
          { id: "report", title: "Report", status: "pending" },
        ],
      },
    ],
  };
}

function browserFixture(status: BrowserSnapshot["status"]): BrowserSnapshot {
  return {
    status,
    url: null,
    title: null,
    screenshotDataUrl: null,
    updatedAt: null,
    error: null,
    pointer: null,
    task: null,
    logs: [],
    steps: [],
    activeTabId: null,
    tabs: [],
    annotations: [],
  };
}

describe("Workbench overview model", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    const localStorageStub = {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    vi.stubGlobal("localStorage", localStorageStub);
    vi.stubGlobal("window", {
      localStorage: localStorageStub,
      location: { href: "http://localhost/", origin: "http://localhost" },
    });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("summarizes progress across all groups while naming the current group", () => {
    const summary = summarizeProgress(progressFixture());

    expect(summary.badge).toBe("2/4");
    expect(summary.primary).toBe("Audit B");
    expect(summary.secondary).toContain("全部 2/4");
    expect(summary.secondary).toContain("当前组 2 0/2");
    expect(summary.tone).toBe("running");
  });

  it("normalizes legacy progress steps into a single group", () => {
    const groups = normalizedGroups({
      updatedAt: 100,
      artifacts: [],
      groups: [],
      steps: [{ id: "legacy", title: "Legacy", status: "completed" }],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("legacy");
    expect(groups[0]?.steps[0]?.title).toBe("Legacy");
  });

  it("keeps ready browser as ready status without implying page content", () => {
    const ready = describeBrowserStatus(browserFixture("ready"));

    expect(ready.short).toBe("ready");
    expect(ready.title).toBe("浏览器已就绪");
  });

  it("round-trips workbench overview/home tabs", () => {
    const views: WorkbenchView[] = [
      { type: "overview" },
      { type: "progress" },
      { type: "outputs" },
      { type: "files", path: "/tmp/a.txt" },
      { type: "context" },
      { type: "browser", url: "https://example.com" },
    ];

    for (const view of views) {
      expect(viewFromTab(tabFromView(view))).toEqual(view);
    }
  });

  it("keeps exactly one home tab when loading or upserting tabs", () => {
    const key = "workbench-test-tabs";
    localStorage.setItem(
      key,
      JSON.stringify({
        activeTabId: "home",
        tabs: [
          { id: "home", kind: "home", title: "概览", closable: false },
          { id: "progress", kind: "progress", title: "进度", closable: true },
        ],
      })
    );

    const stored = loadStoredWorkbenchTabs(key);
    expect(stored.tabs.filter((tab) => tab.id === "home")).toHaveLength(1);
    expect(upsertWorkbenchTab(stored.tabs, tabFromView({ type: "overview" })).filter((tab) => tab.id === "home")).toHaveLength(1);
  });

  it("falls back to home when stored tab JSON is corrupt", () => {
    const key = "workbench-bad-tabs";
    localStorage.setItem(key, "{bad json");

    expect(loadStoredWorkbenchTabs(key)).toEqual({
      tabs: [tabFromView({ type: "overview" })],
      activeTabId: "home",
    });
  });
});
