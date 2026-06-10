import { installApiFixtures, installSseMock, test, expect } from "./fixtures";

function textMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

test("mobile: 长会话加载更早内容使用分页 cursor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await installSseMock(page);
  await installApiFixtures(page, {
    sessionsResponse: {
      sessions: [
        {
          id: "mobile-long-session",
          path: "/tmp/e2e-sessions/mobile-long-session.jsonl",
          cwd: "/tmp/e2e-cwd",
          name: "Mobile long session",
          firstMessage: "Mobile long session",
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 160,
          isRunning: false,
        },
      ],
    },
  });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "mini-pi-remote",
      JSON.stringify({
        token: "remote-token",
        deviceId: "device-1",
        baseUrl: window.location.origin,
        candidates: [window.location.origin],
        instanceId: "instance-1",
      })
    );
  });

  const contextUrls: string[] = [];
  await page.route("**/api/sessions/mobile-long-session/context**", async (route) => {
    const url = route.request().url();
    contextUrls.push(url);
    const parsed = new URL(url);
    if (parsed.searchParams.has("before")) {
      return route.fulfill({
        json: {
          messages: [textMessage("older page marker")],
          beforeCursor: null,
          hasMoreBefore: false,
        },
      });
    }
    return route.fulfill({
      json: {
        messages: Array.from({ length: 80 }, (_, index) =>
          textMessage(`tail message ${index + 1}`)
        ),
        beforeCursor: 120,
        hasMoreBefore: true,
        truncatedBefore: 120,
      },
    });
  });

  await page.goto("/mobile");
  await page.getByTitle("会话").click();
  await page.getByText("Mobile long session").click();

  await expect(page.getByText("tail message 80", { exact: true })).toBeVisible();
  await expect(page.getByText("tail message 1", { exact: true })).not.toBeVisible();

  await page.getByRole("button", { name: /加载更早/ }).click();
  await page.getByRole("button", { name: /加载更早/ }).click();
  await expect(page.getByText("tail message 1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /加载更早内容/ }).click();
  await expect(page.getByText("older page marker")).toBeVisible();
  expect(contextUrls.some((url) => new URL(url).searchParams.get("before") === "120")).toBe(true);
});
