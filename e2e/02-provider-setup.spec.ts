import { test, expect, installApiFixtures, installSseMock } from "./fixtures";

function providersResponse(openAiSaved: boolean) {
  return {
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        hasAuth: openAiSaved,
        authSource: openAiSaved ? "auth_json" : undefined,
        authLabel: openAiSaved ? "API key" : undefined,
        models: [
          {
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        ],
      },
    ],
    total: 1,
    authedCount: openAiSaved ? 1 : 0,
    defaultProvider: "openai",
    defaultModelId: "gpt-4o-mini",
  };
}

function authResponse(openAiSaved: boolean) {
  return {
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        hasAuth: openAiSaved,
        credentialType: openAiSaved ? "api_key" : null,
        supportsOAuth: false,
        status: {
          configured: openAiSaved,
          source: openAiSaved ? "auth_json" : undefined,
          label: openAiSaved ? "API key" : undefined,
        },
      },
      {
        provider: "openai-codex",
        displayName: "OpenAI Codex",
        hasAuth: false,
        credentialType: null,
        supportsOAuth: true,
        status: { configured: false },
      },
    ],
    oauthProviders: ["openai-codex"],
    authPath: "/tmp/e2e-home/.pi/auth.json",
  };
}

test("provider setup: 首次打开后可选择 OpenAI API Key 并 mock 保存验证", async ({
  page,
}) => {
  let openAiSaved = false;

  await installSseMock(page);
  await installApiFixtures(page);
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.endsWith("/api/providers")) {
      return route.fulfill({ json: providersResponse(openAiSaved) });
    }
    if (url.endsWith("/api/auth")) {
      if (method === "PUT") {
        const body = await route.request().postDataJSON();
        expect(body.provider).toBe("openai");
        expect(body.apiKey).toBe("sk-test-e2e");
        openAiSaved = true;
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: authResponse(openAiSaved) });
    }
    if (url.endsWith("/api/auth/test")) {
      return route.fulfill({
        json: {
          ok: true,
          latencyMs: 12,
          model: { provider: "openai", id: "gpt-4o-mini" },
        },
      });
    }

    return route.fallback();
  });

  await page.goto("/?e2e=1", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("text=Diga Agent", { timeout: 10_000 });

  await page.getByRole("button", { name: "动作菜单" }).click();
  await page.getByRole("button", { name: /Provider \/ Models/ }).click();
  await expect(page.getByText("Provider setup")).toBeVisible();

  await page.getByRole("button", { name: /OpenAI API Key/ }).click();
  await expect(page.getByText("Standard OpenAI API provider")).toBeVisible();

  await page.getByPlaceholder("API key").fill("sk-test-e2e");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText(/Test passed.*gpt-4o-mini/)).toBeVisible();
});
