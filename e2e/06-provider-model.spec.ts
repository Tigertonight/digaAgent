import {
  expect,
  installApiFixtures,
  installSseMock,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";

const editor = (page: Page) => page.locator("textarea").first();
const sendBtn = (page: Page) => page.getByTitle("Send", { exact: true });

const providersResponse = {
  providers: [
    {
      provider: "anthropic",
      displayName: "Anthropic",
      hasAuth: true,
      authSource: "runtime",
      authLabel: "mock",
      models: [
        {
          id: "claude-haiku-4-5-20251001",
          name: "Claude Haiku 4.5",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    },
    {
      provider: "rednote-runway-local",
      displayName: "rednote-runway-local",
      hasAuth: true,
      authSource: "models_json_key",
      authLabel: "models.json",
      models: [
        {
          id: "claude-opus-4-7-rednote-runway",
          name: "Claude Opus 4.7 via Rednote Runway",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    },
  ],
  total: 2,
  authedCount: 2,
  defaultProvider: "anthropic",
  defaultModelId: "claude-haiku-4-5-20251001",
};

test("provider switch selects the provider's first model before set_model", async ({
  page,
}) => {
  await installSseMock(page);
  await installApiFixtures(page, { providersResponse });

  await page.goto("/?e2e=1");
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("text=Diga Agent", { timeout: 10_000 });

  await editor(page).fill("hello");
  await sendBtn(page).click();

  let setModelBody: unknown = null;
  await page.route("**/api/agent/agent-1", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          id: "agent-1",
          thinkingLevel: "medium",
          supportsThinking: true,
          availableThinkingLevels: ["low", "medium", "high"],
        },
      });
    }
    let body: { type?: string } | null = null;
    try {
      body = route.request().postDataJSON() as { type?: string };
    } catch {
      body = null;
    }
    if (body?.type === "set_model") setModelBody = body;
    return route.fulfill({ json: { ok: true } });
  });

  const selects = page.locator("select");
  await expect(selects.nth(0)).toHaveValue("anthropic");
  await expect(selects.nth(1)).toHaveValue("claude-haiku-4-5-20251001");

  await selects.nth(0).selectOption("rednote-runway-local");

  await expect(selects.nth(1)).toHaveValue(
    "claude-opus-4-7-rednote-runway"
  );
  await expect
    .poll(() => setModelBody)
    .toEqual({
      type: "set_model",
      provider: "rednote-runway-local",
      modelId: "claude-opus-4-7-rednote-runway",
    });
  await expect(page.getByText("provider and modelId required")).toBeHidden();
});
