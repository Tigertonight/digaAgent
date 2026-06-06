import { test, expect, pushSseEvent } from "./fixtures";

async function activeAgentId(page: import("@playwright/test").Page): Promise<string> {
  const handle = await page.waitForFunction(() => {
    const w = window as unknown as {
      __mockEventSources: Array<{ url: string; readyState: number }>;
    };
    const open = [...w.__mockEventSources]
      .reverse()
      .find((h) => h.readyState === 1);
    if (!open) return null;
    const m = open.url.match(/\/api\/agent\/([^/]+)\/events/);
    return m ? m[1] : null;
  });
  return (await handle.jsonValue()) as string;
}

test("workbench: Overview 作为右侧 root 并支持折叠分组", async ({
  bootedPage: page,
}) => {
  await expect(page.getByRole("button", { name: "Explorer" })).toHaveAttribute(
    "aria-expanded",
    "false"
  );

  await page.getByLabel("Workbench 面板").click();

  await expect(page.getByTestId("workbench-overview")).toBeVisible();
  await expect(page.getByTestId("workbench-section-progress")).toBeVisible();
  await expect(page.getByTestId("workbench-section-outputs")).toBeVisible();
  await expect(page.getByTestId("workbench-section-files")).toBeVisible();
  await expect(page.getByTestId("workbench-section-context")).toBeVisible();
  await expect(page.getByTestId("workbench-section-browser")).toBeVisible();
  await expect(page.getByTestId("workbench-section-files-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(page.getByTestId("workbench-section-context-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(page.getByTestId("workbench-section-progress-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(page.getByTestId("workbench-section-outputs-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(page.getByTestId("workbench-section-browser-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );

  await page.getByTestId("workbench-section-outputs-toggle").click();
  await expect(page.getByText("0 个产物")).toBeVisible();
  await page.getByTestId("workbench-section-outputs-toggle").click();
  await expect(page.getByText("0 个产物")).toBeHidden();

  await page.getByTestId("workbench-section-context-action").click();
  await expect(page.getByTestId("workbench-context-detail")).toBeVisible();
  await expect(page.getByText("sessionId")).toBeVisible();

  await page.getByTestId("workbench-tab-home").click();
  await expect(page.getByTestId("workbench-overview")).toBeVisible();

  await page.getByTestId("workbench-section-progress-action").click();
  await expect(page.getByTestId("workbench-progress-detail")).toBeVisible();
  await expect(page.getByText("暂无进度")).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("workbench-sidebar")).toBeHidden();
});

test("workbench: Outputs 作为产物 inbox 展示 URL 和文件动作", async ({
  bootedPage: page,
}) => {
  await page.locator("textarea").first().fill("produce outputs");
  await page.getByTitle("Send", { exact: true }).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(
    page,
    agentId,
    {
      type: "progress_updated",
      progress: {
        steps: [],
        groups: [],
        artifacts: [
          {
            id: "url-1",
            kind: "url",
            title: "localhost:3000",
            href: "http://localhost:3000",
            createdAt: Date.now(),
          },
          {
            id: "file-1",
            kind: "file",
            title: "architecture.md",
            href: "/tmp/e2e-cwd/architecture.md",
            createdAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      },
    },
    "41"
  );

  await page.getByLabel("Workbench 面板").click();
  await expect(page.getByTestId("workbench-section-outputs")).toContainText("2");
  await page.getByTestId("workbench-section-outputs-action").click();
  await expect(page.getByTestId("workbench-outputs-detail")).toContainText("URLs");
  await expect(page.getByTestId("workbench-outputs-detail")).toContainText("Files");
  await expect(page.getByText("打开 Browser")).toBeVisible();
  await expect(page.getByText("打开 Files")).toBeVisible();
});

test("workbench: Tab OS 支持创建菜单、推荐项和本地 URL 过滤", async ({
  bootedPage: page,
}) => {
  await page.route("**/api/files?**", async (route) => {
    const url = new URL(route.request().url());
    const filePath = url.searchParams.get("path") ?? "";
    if (filePath.endsWith("/README.md")) {
      return route.fulfill({
        json: {
          kind: "file",
          path: filePath,
          size: 128,
          modified: new Date().toISOString(),
          content: "# README fixture\n\nOpened from Workbench recommendation.",
        },
      });
    }
    return route.fulfill({
      json: {
        kind: "dir",
        path: filePath,
        entries: [{ name: "README.md", isDir: false, isFile: true, isSymlink: false }],
      },
    });
  });

  await page.locator("textarea").first().fill("produce browser recommendations");
  await page.getByTitle("Send", { exact: true }).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(
    page,
    agentId,
    {
      type: "progress_updated",
      progress: {
        steps: [],
        groups: [],
        artifacts: [
          {
            id: "self-url",
            kind: "url",
            title: "Diga self",
            href: "http://localhost:3000/",
            createdAt: Date.now(),
          },
          {
            id: "fixture-url",
            kind: "url",
            title: "Browser fixture",
            href: "http://localhost:3000/browser-task-fixture",
            createdAt: Date.now(),
          },
          {
            id: "file-1",
            kind: "file",
            title: "architecture.md",
            href: "/tmp/e2e-cwd/architecture.md",
            createdAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      },
    },
    "42"
  );

  await page.getByLabel("Workbench 面板").click();
  await expect(page.getByTestId("workbench-home-launcher")).toBeVisible();
  await expect(page.getByTestId("workbench-launch-文件")).toBeVisible();
  await expect(page.getByTestId("workbench-launch-浏览器")).toBeVisible();
  await expect(page.getByTestId("workbench-launch-终端")).toBeVisible();
  await expect(page.getByTestId("workbench-launch-概览")).toBeVisible();

  await page.getByTestId("workbench-create-tab").click();
  await expect(page.getByTestId("workbench-create-menu")).toBeVisible();
  await expect(page.getByTestId("workbench-create-文件")).toBeVisible();
  await expect(page.getByTestId("workbench-create-浏览器")).toBeVisible();
  await expect(page.getByTestId("workbench-create-终端")).toBeVisible();

  await page.getByTestId("workbench-create-浏览器").click();
  await expect(page.getByTestId("workbench-browser-launcher")).toBeVisible();
  await expect(page.getByText("Browser fixture")).toBeVisible();
  await expect(page.getByText("Diga self")).toBeHidden();

  await page.getByText("Browser fixture").click();
  await expect(page.getByTestId("workbench-tab-browser")).toHaveCount(2);
  await expect(page.getByText("http://localhost:3000/browser-task-fixture")).toBeVisible();

  await page.getByTestId("workbench-tab-home").click();
  await page.getByText("README.md").first().click();
  await expect(page.getByTestId("workbench-tab-files")).toBeVisible();
  await expect(page.getByText("Opened from Workbench recommendation.")).toBeVisible();
});
