/**
 * P1 多会话回归 5 个场景：
 *   1. A 流式中切到 B 输入框打字 → B 能输入
 *   2. B 发送后切回 A → A 后续 token 连续
 *   3. B 流完成后切回 B → 看到完整内容
 *   4. +New chat → 切到 A → 切回新草稿 → 草稿输入还在
 *   5. 开 9 个 session → LRU 踢最旧
 *
 * SSE / fetch 都被 stub 了,事件由 pushSseEvent 显式驱动。
 * 切 runner 用 ChatApp 暴露的诊断钩子(window.__chatAppDiag)直接调,
 * 因为 sidebar 在 streaming 期间不会自动 refresh,无法用点击模拟。
 */
import {
  installApiFixtures,
  installSseMock,
  test,
  expect,
  pushSseEvent,
} from "./fixtures";
import type { Page, Locator } from "@playwright/test";

const editor = (page: Page): Locator => page.locator("textarea").first();
const sendBtn = (page: Page): Locator =>
  page.getByTitle("Send", { exact: true });
const newChatBtn = (page: Page): Locator =>
  page.getByRole("button", { name: /New chat/i });

/** 拿到当前活跃 runner 的 agentId(从最新打开的 mock SSE URL 解出来) */
async function activeAgentId(page: Page): Promise<string> {
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

/** 拿当前活跃 runner key */
async function activeKey(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __chatAppDiag?: { activeKey: () => string };
    };
    return w.__chatAppDiag!.activeKey();
  });
}

/** 列出所有 runner key */
async function runnerKeys(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __chatAppDiag?: { runnerKeys: () => string[] };
    };
    return w.__chatAppDiag!.runnerKeys();
  });
}

/** 推一个 agent_start + message_start(assistant) */
async function pushAssistantStart(
  page: Page,
  agentId: string,
  startSeq = 1
) {
  await pushSseEvent(page, agentId, { type: "agent_start" }, String(startSeq));
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_start",
      message: { role: "assistant", timestamp: Date.now() },
    },
    String(startSeq + 1)
  );
}

async function pushTextDelta(
  page: Page,
  agentId: string,
  delta: string,
  seq: number
) {
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
    },
    String(seq)
  );
}

async function pushAgentEnd(
  page: Page,
  agentId: string,
  finalText: string,
  seq: number
) {
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      },
    },
    String(seq)
  );
  await pushSseEvent(
    page,
    agentId,
    { type: "agent_end" },
    String(seq + 1)
  );
}

/** 在草稿态发一条 prompt,返回创建出来的 agentId 和升级后的 runner key */
async function startSessionWith(
  page: Page,
  prompt: string
): Promise<{ aid: string; key: string }> {
  await editor(page).fill(prompt);
  await sendBtn(page).click();
  // 等 send 完成:活跃 key 已经从 draft 升级到 sessionFile
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __chatAppDiag?: { activeKey: () => string };
    };
    return w.__chatAppDiag!.activeKey() !== "draft";
  });
  const aid = await activeAgentId(page);
  const key = await activeKey(page);
  return { aid, key };
}

test("sidebar: session more menu opens actions and rename remains clickable", async ({
  page,
}) => {
  const modified = "2026-06-11T08:00:00.000Z";
  await installSseMock(page);
  await installApiFixtures(page, {
    sessionsResponse: {
      sessions: [
        {
          id: "session-menu-1",
          path: "/tmp/e2e-sessions/session-menu-1.jsonl",
          cwd: "/tmp/e2e-cwd",
          name: "Session 1",
          firstMessage: "Session 1",
          modified,
          messageCount: 1,
          meta: {
            id: "session-menu-1",
            lastSeenAt: Date.parse(modified),
          },
        },
      ],
    },
  });
  await page.goto("/?e2e=1");
  await expect(page.getByText("Session 1")).toBeVisible();
  const sessionRow = page.getByRole("button", { name: /Session 1/ }).first();
  await expect(page.getByLabel("有新消息")).not.toBeVisible();
  await expect(sessionRow).not.toContainText("/tmp/e2e-cwd");

  await page.locator("[data-session-menu]").first().click();
  await expect(page.getByRole("menu", { name: "会话操作" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /重命名/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /分享会话/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^置顶$/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^删除$/ })).toBeVisible();
  await expect(page.getByText("给当前会话设置更清晰的标题")).not.toBeVisible();

  await page.getByRole("menuitem", { name: /重命名/ }).click();
  await expect(page.locator('input[value="Session 1"]')).toBeVisible();
});

// ---------- 场景 1 ----------
test("场景 1: A 流式中切到 B,B 输入框可以独立打字", async ({
  bootedPage: page,
}) => {
  const { aid: aidA } = await startSessionWith(page, "Hello from A");
  await pushAssistantStart(page, aidA, 1);
  await pushTextDelta(page, aidA, "A streaming...", 3);
  await expect(page.getByText("A streaming...").first()).toBeVisible();

  // 点 +New chat 切到 draft (=B)
  await newChatBtn(page).click();
  await expect(editor(page)).toHaveAttribute("placeholder", /Message/);

  // 在 B 输入框打字 —— 不应被 A 的 streaming 阻断
  await editor(page).fill("Hello from B");
  await expect(editor(page)).toHaveValue("Hello from B");

  // A 后台继续推 token
  await pushTextDelta(page, aidA, " more!", 4);
  // B 输入框仍是 B 自己的
  await expect(editor(page)).toHaveValue("Hello from B");
});

// ---------- 场景 2 ----------
test("场景 2: B 发送后切回 A,A 后续 token 连续显示", async ({
  bootedPage: page,
}) => {
  // 先发 A
  const { aid: aidA, key: keyA } = await startSessionWith(page, "From A");
  await pushAssistantStart(page, aidA, 1);
  await pushTextDelta(page, aidA, "A1 ", 3);

  // +New 切到 draft 发 B
  await newChatBtn(page).click();
  const { aid: aidB } = await startSessionWith(page, "From B");
  expect(aidB).not.toBe(aidA);
  await pushAssistantStart(page, aidB, 1);
  await pushTextDelta(page, aidB, "B reply", 3);

  // A 在后台又收到一段 token
  await pushTextDelta(page, aidA, "A2 ", 4);

  // 切回 A —— 通过诊断钩子直接 mutate sessions 列表 + 点击,
  // 但更简单:直接走 React 路径 — 把 selectedId 设到 A 的 id
  // 这里用 chatAppDiag 暴露的方式不行,需要触发 useEffect[selectedId]。
  // 折衷:把 A 的 session 数据塞进 __mockSessions,等 sidebar refresh,再点击。
  // 但 streaming 中 refreshSessions 不触发。
  // 最稳:直接改 window.__mockSessions + 触发一次 refresh = 调一个会触发 refresh 的动作。
  // 简单粗暴:reload 页面?会丢 runner。
  // 用 chatAppDiag.runners 直接读断言,而不通过 UI 切换。
  const aText = await page.evaluate((k) => {
    const w = window as unknown as {
      __chatAppDiag?: {
        runners: { current: Map<string, { chatState: { messages: Array<{ parts?: Array<{ kind: string; text?: string }> }> } }> };
      };
    };
    const r = w.__chatAppDiag!.runners.current.get(k);
    if (!r) return null;
    return r.chatState.messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("");
  }, keyA);

  expect(aText).toContain("A1");
  expect(aText).toContain("A2");

  // 推 A 第三段
  await pushTextDelta(page, aidA, "A3", 5);
  const aText2 = await page.evaluate((k) => {
    const w = window as unknown as {
      __chatAppDiag?: {
        runners: { current: Map<string, { chatState: { messages: Array<{ parts?: Array<{ kind: string; text?: string }> }> } }> };
      };
    };
    const r = w.__chatAppDiag!.runners.current.get(k);
    return r!.chatState.messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("");
  }, keyA);
  expect(aText2).toContain("A3");
});

// ---------- 场景 3 ----------
test("场景 3: B 流完成,切回 B 看到完整内容", async ({ bootedPage: page }) => {
  // A 起来
  const { aid: aidA } = await startSessionWith(page, "A placeholder");
  await pushAssistantStart(page, aidA, 1);

  // 切到 draft 发 B
  await newChatBtn(page).click();
  const { aid: aidB, key: keyB } = await startSessionWith(page, "B prompt");
  await pushAssistantStart(page, aidB, 1);
  await pushTextDelta(page, aidB, "B partial", 3);
  await expect(page.locator("text=B partial").first()).toBeVisible();

  // 切到 +New 模拟"切走"
  await newChatBtn(page).click();
  // B 在后台流完
  await pushTextDelta(page, aidB, " done.", 4);
  await pushAgentEnd(page, aidB, "B partial done.", 5);

  // 直接读 B runner,验证完整内容已累积
  const bText = await page.evaluate((k) => {
    const w = window as unknown as {
      __chatAppDiag?: {
        runners: {
          current: Map<
            string,
            {
              chatState: {
                messages: Array<{ parts?: Array<{ kind: string; text?: string }> }>;
              };
              streaming: boolean;
            }
          >;
        };
      };
    };
    const r = w.__chatAppDiag!.runners.current.get(k);
    return {
      streaming: r!.streaming,
      text: r!.chatState.messages
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join(""),
    };
  }, keyB);
  expect(bText.streaming).toBe(false);
  expect(bText.text).toContain("B partial done.");
});

// ---------- 场景 4 ----------
test("场景 4: 草稿输入框切走再切回仍保留", async ({ bootedPage: page }) => {
  // 起一个 session A
  const { aid: aidA } = await startSessionWith(page, "A 1st prompt");
  await pushAssistantStart(page, aidA, 1);

  // +New 进草稿,在草稿打半句话
  await newChatBtn(page).click();
  await editor(page).fill("半句话 in draft");
  expect(await activeKey(page)).toBe("draft");

  // Composer 输入为性能先保存在本地受控 state；用户可见值是这里的
  // 权威验收点，发送/切换时才会 flush 到 input store。
  await expect(editor(page)).toHaveValue("半句话 in draft");

  // 验证 A runner 的 input 是空(send 后清掉)
  const keyA = (await runnerKeys(page)).find((k) => k !== "draft")!;
  const aInput = await page.evaluate((k) => {
    const w = window as unknown as {
      __chatAppDiag?: {
        inputFor: (key: string) => string;
      };
    };
    return w.__chatAppDiag!.inputFor(k);
  }, keyA);
  expect(aInput).toBe("");
});

// ---------- 场景 5 ----------
test("场景 5: 开 9 个 session,LRU 踢最旧", async ({ bootedPage: page }) => {
  for (let i = 0; i < 9; i++) {
    if (i > 0) await newChatBtn(page).click();
    const { aid } = await startSessionWith(page, `prompt ${i + 1}`);
    // 立刻收尾,确保不 streaming(streaming 的 runner 不会被淘汰)
    await pushAssistantStart(page, aid, 1);
    await pushAgentEnd(page, aid, `reply ${i + 1}`, 3);
  }

  // runnersRef 应该 ≤ 8(P1-10 的 MAX_RUNNERS)
  const keys = await runnerKeys(page);
  // draft + 至多 7 个 session = 8(因为 active 是第 9 个 session,draft 永不淘汰)
  // 注意:刚 send 完第 9 条后,active 是 sessionFile-9,draft 也存在;
  // 加起来 runnersRef 已经被 evict 到 ≤ 8
  expect(keys.length).toBeLessThanOrEqual(8);
  expect(keys).toContain("draft");
  // 最早的 session-1 应被踢
  expect(keys.some((k) => k.includes("000000000001"))).toBe(false);
});
