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

  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("text=模型与账号", { timeout: 10_000 });
  await expect(page.getByText("模型服务账号")).toBeVisible();

  const input = page.getByPlaceholder("粘贴 API 密钥…").first();
  await input.fill("sk-test-e2e");
  await input.locator("xpath=following-sibling::button").click();

  await expect(page.getByText("已保存")).toBeVisible();
});
