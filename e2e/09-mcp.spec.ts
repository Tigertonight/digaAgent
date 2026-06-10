import { test, expect, installApiFixtures } from "./fixtures";
import type { Page, Route } from "@playwright/test";

/**
 * MCP servers settings E2E (Sprint 5).
 *
 * Drives the Web settings page (`/settings` renders WebSettingsPanel when no
 * Electron API is present, which includes <McpServersSection />). All `/api/mcp`
 * traffic is mocked with an in-page store so the test never spawns a real MCP
 * server.
 *
 * Covered:
 *  - list renders configured servers
 *  - add (upsert) a new server, list refreshes
 *  - "测试" (test) surfaces the connected tool count
 *  - remove a server, list refreshes
 */

interface MockServer {
  id: string;
  title?: string;
  transport: "stdio";
  command: string;
  args?: string[];
  enabled: boolean;
}

/**
 * Install a mock /api/mcp backed by an in-page server list. Registered AFTER
 * installApiFixtures so it takes precedence over the catch-all `**\/api\/**`.
 */
async function installMcpFixture(page: Page, initial: MockServer[]) {
  await page.addInitScript((seed) => {
    (window as unknown as { __mockMcpServers: MockServer[] }).__mockMcpServers =
      seed as MockServer[];
  }, initial);

  await page.route("**/api/mcp", async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      const servers = await page.evaluate(
        () =>
          (window as unknown as { __mockMcpServers: MockServer[] })
            .__mockMcpServers
      );
      return route.fulfill({ json: { servers } });
    }
    // POST: upsert / remove / test
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    const type = body.type as string;
    if (type === "upsert") {
      const saved = await page.evaluate((b) => {
        const w = window as unknown as { __mockMcpServers: MockServer[] };
        const next: MockServer = {
          id: String(b.id),
          title: b.title ? String(b.title) : undefined,
          transport: "stdio",
          command: String(b.command),
          args: Array.isArray(b.args) ? (b.args as string[]) : undefined,
          enabled: b.enabled !== false,
        };
        const idx = w.__mockMcpServers.findIndex((s) => s.id === next.id);
        if (idx >= 0) w.__mockMcpServers[idx] = next;
        else w.__mockMcpServers.push(next);
        return next;
      }, body);
      return route.fulfill({ json: { ok: true, server: saved } });
    }
    if (type === "remove") {
      await page.evaluate((id) => {
        const w = window as unknown as { __mockMcpServers: MockServer[] };
        w.__mockMcpServers = w.__mockMcpServers.filter(
          (s) => s.id !== String(id)
        );
      }, body.id);
      return route.fulfill({ json: { ok: true } });
    }
    if (type === "test") {
      // Pretend the configured server exposes two tools.
      return route.fulfill({
        json: {
          ok: true,
          toolCount: 2,
          tools: [
            { name: "read_file", description: "read a file" },
            { name: "list_dir", description: "list a directory" },
          ],
        },
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
}

async function gotoSettings(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: /MCP 工具/ }).click();
  await page.waitForSelector("text=外部工具服务", { timeout: 10_000 });
}

test("mcp settings: lists configured servers", async ({ page }) => {
  await installApiFixtures(page);
  await installMcpFixture(page, [
    {
      id: "filesystem",
      title: "Filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      enabled: true,
    },
  ]);
  await gotoSettings(page);

  await expect(page.getByText("filesystem", { exact: true })).toBeVisible();
  await expect(page.getByText("Filesystem", { exact: true })).toBeVisible();
  await expect(
    page.locator("span.text-emerald-300").filter({ hasText: "已启用" })
  ).toBeVisible();
});

test("mcp settings: add a new server refreshes the list", async ({ page }) => {
  await installApiFixtures(page);
  await installMcpFixture(page, []);
  await gotoSettings(page);

  await expect(page.getByText("还没有配置外部工具服务。")).toBeVisible();

  await page.getByRole("button", { name: "添加工具服务" }).click();
  await page.getByRole("textbox", { name: "服务标识" }).fill("github");
  await page
    .getByRole("textbox", { name: "显示名称（可选）" })
    .fill("GitHub");
  await page.getByRole("textbox", { name: "启动命令" }).fill("gh-mcp");
  await page.getByRole("button", { name: "保存工具服务" }).click();

  await expect(page.getByText("github", { exact: true })).toBeVisible();
  await expect(page.getByText("gh-mcp")).toBeVisible();
});

test("mcp settings: test connection shows tool count", async ({ page }) => {
  await installApiFixtures(page);
  await installMcpFixture(page, [
    {
      id: "filesystem",
      transport: "stdio",
      command: "npx",
      enabled: true,
    },
  ]);
  await gotoSettings(page);

  await page.getByRole("button", { name: "测试" }).click();
  await expect(page.getByText("连接成功，2 个工具")).toBeVisible();
});

test("mcp settings: remove a server refreshes the list", async ({ page }) => {
  await installApiFixtures(page);
  await installMcpFixture(page, [
    {
      id: "filesystem",
      transport: "stdio",
      command: "npx",
      enabled: true,
    },
  ]);
  await gotoSettings(page);

  await expect(page.getByText("filesystem", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("还没有配置外部工具服务。")).toBeVisible();
});
