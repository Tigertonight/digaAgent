/**
 * Playwright 公共 fixture：
 *   - 拦截所有 /api/* 路由，返回最小可用的 fixture 数据
 *   - 提供 mock SSE 推送能力 (通过 window.__mockSse 暴露给测试)
 *
 * 设计目标：让 ChatApp 进入"可交互态"，但所有外部依赖都在测试控制下。
 *
 * 重要：当前 fixture 只覆盖 5 个回归场景需要的最小接口集合。
 * 新增场景时缺什么补什么，不要一次铺开。
 */
import { test as base, type Page, type Route } from "@playwright/test";

interface ApiFixtureOptions {
  providersResponse?: unknown;
  authResponse?: unknown;
  modelsConfigResponse?: unknown;
  sessionsResponse?: unknown;
  tasksResponse?: unknown;
}

const defaultProvidersResponse = {
  providers: [
    {
      provider: "openai-codex",
      displayName: "ChatGPT Plus/Pro (Codex Subscription)",
      hasAuth: true,
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    },
  ],
  total: 1,
  authedCount: 1,
  defaultProvider: "openai-codex",
  defaultModelId: "gpt-5.5",
};

const defaultAuthResponse = {
  providers: [
    {
      provider: "openai-codex",
      displayName: "ChatGPT Plus/Pro (Codex Subscription)",
      hasAuth: true,
      credentialType: "oauth",
      status: {
        configured: true,
        source: "stored",
        label: "stored",
      },
      supportsOAuth: true,
    },
  ],
  oauthProviders: [],
};

/**
 * 给 ChatApp 启动需要的最小接口集合返 fixture。
 * 调用方再额外 page.route 覆盖 /api/agent/new 和 /api/agent/:id/events 走自己的 stub。
 */
export async function installApiFixtures(
  page: Page,
  options: ApiFixtureOptions = {}
) {
  // 在 page 内挂一个 sessions 数组，POST /api/agent/new 时 push，GET /api/sessions 读它
  await page.addInitScript(() => {
    const w = window as unknown as {
      __mockSessions: Array<{
        id: string;
        path: string;
        cwd: string;
        name: string | null;
        firstMessage: string;
        modified: string;
        isRunning?: boolean;
        parentSessionId?: string | null;
      }>;
      __mockAgentCounter: number;
      __E2E__: boolean;
    };
    w.__mockSessions = [];
    w.__mockAgentCounter = 0;
    w.__E2E__ = true; // 让 ChatApp 挂诊断钩子到 window.__chatAppDiag
  });

  // 全局兜底：未匹配的 /api/* 一律返回 ok 空 (防止某个新接口让 UI 报错)
  await page.route("**/api/**", async (route: Route) => {
    const url = route.request().url();
    const pathname = new URL(url).pathname;
    const method = route.request().method();
    if (process.env.E2E_DEBUG) {
       
      console.log("[mock]", method, url);
    }

    // === 启动期接口 ===
    if (pathname.endsWith("/api/health")) {
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname.endsWith("/api/providers")) {
      return route.fulfill({
        json: options.providersResponse ?? defaultProvidersResponse,
      });
    }
    if (pathname.endsWith("/api/sessions")) {
      if (options.sessionsResponse) {
        return route.fulfill({ json: options.sessionsResponse });
      }
      const sessions = await page.evaluate(() => {
        const w = window as unknown as { __mockSessions: unknown[] };
        return w.__mockSessions;
      }).catch(() => []);
      return route.fulfill({ json: { sessions } });
    }
    if (pathname.endsWith("/api/default-cwd")) {
      return route.fulfill({ json: { cwd: "/tmp/e2e-cwd" } });
    }
    if (pathname.endsWith("/api/home")) {
      return route.fulfill({ json: { home: "/tmp" } });
    }
    if (pathname.endsWith("/api/auth")) {
      return route.fulfill({
        json: options.authResponse ?? defaultAuthResponse,
      });
    }
    if (pathname.endsWith("/api/skills")) {
      return route.fulfill({ json: { skills: [] } });
    }
    if (pathname.endsWith("/api/models-config")) {
      return route.fulfill({
        json: options.modelsConfigResponse ?? { providers: [] },
      });
    }
    if (pathname.endsWith("/api/files")) {
      return route.fulfill({ json: { entries: [] } });
    }
    if (pathname.endsWith("/api/tasks")) {
      if (options.tasksResponse) {
        return route.fulfill({ json: options.tasksResponse });
      }
      const taskWorkbenchDashboard = await page.evaluate(() => {
        const w = window as unknown as { __tasksDashboard?: unknown };
        return w.__tasksDashboard;
      }).catch(() => null);
      if (taskWorkbenchDashboard && method === "GET") {
        return route.fulfill({ json: taskWorkbenchDashboard });
      }
      if (taskWorkbenchDashboard && method === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as Record<
          string,
          unknown
        >;
        const next = await page.evaluate((input) => {
          const w = window as unknown as {
            __tasksDashboard: {
              tasks: Array<Record<string, unknown>>;
              runs: Array<Record<string, unknown>>;
              findings: Array<Record<string, unknown>>;
              dueTasks: Array<Record<string, unknown>>;
              inboxCount: number;
            };
          };
          const dash = w.__tasksDashboard;
          const now = Date.now();
          if (input.type === "create") {
            const task = {
              id: "task-1",
              title: String(input.title),
              prompt: String(input.prompt),
              projectPath: String(input.projectPath),
              provider: String(input.provider),
              modelId: String(input.modelId),
              cadence: input.cadence === "daily" ? "daily" : "manual",
              enabled: true,
              skillIds: [],
              permissionPolicy: {
                requireApprovalBeforeWrite: true,
                requireApprovalBeforeNetwork: true,
                maxDurationMinutes: 60,
              },
              status: "scheduled",
              createdAt: now,
              updatedAt: now,
              nextRunAt: now - 1000,
            };
            dash.tasks = [task];
            dash.dueTasks = [task];
            return { task, dashboard: dash };
          }
          if (input.type === "run_due" || input.type === "run") {
            const task = dash.tasks[0];
            const run = {
              id: "run-1",
              taskId: task.id,
              status: "completed_with_findings",
              startedAt: now,
              updatedAt: now,
              endedAt: now,
              summary: "发现 1 个需要你处理的新事项。",
              findingIds: ["finding-1"],
            };
            const finding = {
              id: "finding-1",
              taskId: task.id,
              runId: run.id,
              title: "CI 连续失败",
              body: "主分支 CI 在登录流程上连续失败，需要你确认是否优先处理。",
              severity: "critical",
              status: "unread",
              createdAt: now,
              updatedAt: now,
            };
            dash.runs = [run];
            dash.findings = [finding];
            dash.inboxCount = 1;
            dash.dueTasks = [];
            dash.tasks = [{ ...task, status: "completed", lastRunId: run.id }];
            return { dashboard: dash };
          }
          if (input.type === "finding_status") {
            dash.findings = dash.findings.map((finding) =>
              finding.id === input.id
                ? { ...finding, status: String(input.status) }
                : finding
            );
            dash.inboxCount = dash.findings.filter(
              (finding) => finding.status === "unread"
            ).length;
            return { dashboard: dash };
          }
          return { dashboard: dash };
        }, body);
        return route.fulfill({ json: { ok: true, ...next } });
      }
      const dashboard = await page.evaluate(() => {
        const w = window as unknown as { __mobileTasks?: unknown };
        return w.__mobileTasks;
      }).catch(() => null);
      if (dashboard && method === "GET") {
        return route.fulfill({ json: dashboard });
      }
      if (dashboard && method === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as {
          type?: string;
          id?: string;
          status?: string;
        };
        const nextDashboard = await page.evaluate((input) => {
          const w = window as unknown as {
            __mobileTasks?: {
              findings?: Array<{ id: string; status: string }>;
              inboxCount?: number;
            };
          };
          if (w.__mobileTasks && input.type === "finding_status") {
            w.__mobileTasks.findings = (w.__mobileTasks.findings ?? []).map(
              (finding) =>
                finding.id === input.id
                  ? { ...finding, status: input.status ?? finding.status }
                  : finding
            );
            w.__mobileTasks.inboxCount = (w.__mobileTasks.findings ?? []).filter(
              (finding) => finding.status === "unread"
            ).length;
          }
          return w.__mobileTasks;
        }, body);
        return route.fulfill({ json: { ok: true, dashboard: nextDashboard } });
      }
      return route.fulfill({
        json: {
          tasks: [],
          runs: [],
          findings: [],
          dueTasks: [],
          inboxCount: 0,
        },
      });
    }

    // === Agent 创建：每次返回一个递增 fakeId + sessionFile ===
    //   并把对应的 session row push 进 __mockSessions，让 sidebar refresh 后能看到
    if (pathname.endsWith("/api/agent/new") && method === "POST") {
      const created = await page.evaluate(() => {
        const w = window as unknown as {
          __mockAgentCounter: number;
          __mockSessions: Array<{
            id: string;
            path: string;
            cwd: string;
            name: string | null;
            firstMessage: string;
            modified: string;
          }>;
        };
        w.__mockAgentCounter += 1;
        const c = w.__mockAgentCounter;
        const sessionId = `00000000-0000-0000-0000-${String(c).padStart(12, "0")}`;
        const sessionFile = `/tmp/e2e-sessions/${sessionId}.jsonl`;
        w.__mockSessions.push({
          id: sessionId,
          path: sessionFile,
          cwd: "/tmp/e2e-cwd",
          name: `Session ${c}`,
          firstMessage: `Session ${c}`,
          modified: new Date().toISOString(),
        });
        return { id: `agent-${c}`, sessionId, sessionFile };
      });
      return route.fulfill({
        json: {
          ...created,
          thinkingLevel: "medium",
          supportsThinking: true,
          availableThinkingLevels: ["low", "medium", "high"],
          model: {
            provider: "openai-codex",
            id: "gpt-5.5",
            name: "GPT-5.5",
          },
        },
      });
    }

    // === SSE 流：返回一个永不关闭的 stream，由 install-sse-mock 在页面内
    //     用 EventSource 替身管理；这里不实际推数据，仅保证连接成功 ===
    if (url.includes("/api/agent/") && url.includes("/events")) {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        body: `retry: 3000\n\n`,
      });
    }

    // === Agent 通用 action: prompt / abort / steer / followUp 一律 ok ===
    if (url.match(/\/api\/agent\/[^/]+$/)) {
      if (method === "GET") {
        return route.fulfill({
          json: {
            id: "fake",
            thinkingLevel: "medium",
            supportsThinking: true,
            availableThinkingLevels: ["low", "medium", "high"],
          },
        });
      }
      return route.fulfill({ json: { ok: true } });
    }

    // get_tools / stats 等带 ?action= 的 GET
    if (url.match(/\/api\/agent\/[^/]+\?action=/)) {
      if (url.includes("action=get_tools")) {
        return route.fulfill({ json: { tools: [], active: [] } });
      }
      if (url.includes("action=stats")) {
        return route.fulfill({
          json: { stats: null, contextUsage: null, contextWindow: null },
        });
      }
      if (url.includes("action=user_messages_for_forking")) {
        return route.fulfill({ json: { messages: [] } });
      }
      return route.fulfill({ json: {} });
    }

    // sessions/:id/context
    if (url.includes("/api/sessions/") && url.includes("/context")) {
      return route.fulfill({
        json: { messages: [], forkableUserMessages: [] },
      });
    }

    // 兜底：未识别的 /api/* 一律 ok
    return route.fulfill({ json: { ok: true } });
  });
}

/**
 * 在 page 上下文里替换原生 EventSource。
 * 替换后，每个 EventSource 实例会注册到 window.__mockEventSources，
 * 测试可以通过 page.evaluate 找到对应实例并调用 .__push(evt) 推事件。
 */
export async function installSseMock(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __mockEventSources: Array<{
        url: string;
        readyState: number;
        listeners: { open: Array<() => void>; message: Array<(e: MessageEvent) => void>; error: Array<() => void> };
        push: (data: unknown, lastEventId?: string) => void;
        close: () => void;
      }>;
      EventSource: typeof EventSource;
    };
    w.__mockEventSources = [];

    // 不 implements EventSource(避免 strict 模式 this 上下文不兼容),只在运行时替换
    class MockEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 1;
      url: string;
      withCredentials = false;
      onopen: ((ev: Event) => unknown) | null = null;
      onmessage: ((ev: MessageEvent) => unknown) | null = null;
      onerror: ((ev: Event) => unknown) | null = null;
      private listeners = {
        open: [] as Array<() => void>,
        message: [] as Array<(e: MessageEvent) => void>,
        error: [] as Array<() => void>,
      };

      constructor(url: string) {
        this.url = url;
        const handle = {
          url,
          readyState: 1,
          listeners: this.listeners,
          push: (data: unknown, lastEventId?: string) => {
            const ev = new MessageEvent("message", {
              data: typeof data === "string" ? data : JSON.stringify(data),
              lastEventId: lastEventId ?? "",
            });
            if (this.onmessage) this.onmessage(ev);
            for (const l of this.listeners.message) l(ev);
          },
          close: () => {
            this.readyState = 2;
            handle.readyState = 2;
          },
        };
        w.__mockEventSources.push(handle);
        // 异步触发 onopen，模拟真实 EventSource
        queueMicrotask(() => {
          if (this.onopen) this.onopen(new Event("open"));
          for (const l of this.listeners.open) l();
        });
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const fn = typeof listener === "function" ? listener : (e: Event) => listener.handleEvent(e);
        if (type === "open") this.listeners.open.push(fn as () => void);
        else if (type === "message") this.listeners.message.push(fn as (e: MessageEvent) => void);
        else if (type === "error") this.listeners.error.push(fn as () => void);
      }
      removeEventListener(): void {}
      dispatchEvent(): boolean { return true; }
      close(): void {
        this.readyState = 2;
        const idx = w.__mockEventSources.findIndex((h) => h.url === this.url && h.readyState === 1);
        if (idx >= 0) w.__mockEventSources[idx].readyState = 2;
      }
    }

    // 替换全局 EventSource
    (w as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  });
}

/**
 * 在 page 内对 url 包含 /api/agent/<aid>/events 的最近一个 mock SSE 推事件。
 * 调用方传 agentId,自动找到对应 EventSource。
 */
export async function pushSseEvent(page: Page, agentId: string, event: Record<string, unknown>, lastEventId = "1") {
  await page.evaluate(
    ({ aid, evt, leid }) => {
      const w = window as unknown as {
        __mockEventSources: Array<{ url: string; readyState: number; push: (d: unknown, l?: string) => void }>;
      };
      const handle = [...w.__mockEventSources].reverse().find((h) => h.url.includes(`/api/agent/${aid}/events`) && h.readyState === 1);
      if (!handle) throw new Error(`no open mock EventSource for agent ${aid}`);
      handle.push(evt, leid);
    },
    { aid: agentId, evt: event, leid: lastEventId }
  );
}

export const test = base.extend<{
  bootedPage: Page;
}>({
  bootedPage: async ({ page }, use) => {
    await installSseMock(page);
    await installApiFixtures(page);
    // ?e2e=1 让 server side 跳过真实 sessions/cwd 读取
    await page.goto("/?e2e=1");
    // 清掉 dev 阶段可能写进 localStorage 的旧 selectedId / theme 等
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
    });
    await page.reload();
    // 等 Diga Agent 标题出现，确认 ChatApp 已挂载
    await page.waitForSelector("text=Diga Agent", { timeout: 10_000 });
    await use(page);
  },
});

export { expect } from "@playwright/test";
