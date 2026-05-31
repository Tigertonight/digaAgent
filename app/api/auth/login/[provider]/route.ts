/**
 * /api/auth/login/[provider]
 *
 * GET  (SSE)    启动 OAuth 登录流程，把 SDK 的 OAuthLoginCallbacks 事件流式推给浏览器。
 * POST { token, response }
 *               浏览器把用户输入（device code、prompt 回答、select 选项）回传给等待中的 callback。
 *
 * 跨请求状态用 globalThis.__piLoginCallbacks 这个 Map 维护：
 *   token -> { resolve, reject, type: "prompt" | "select" | "manualCode" }
 * SSE 事件里携带 token，POST 时按 token 找回 resolver。
 */
import { type NextRequest, NextResponse } from "next/server";
import { getAuth, getModelRegistry } from "@/lib/agent-registry";
import type {
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PendingResolver = {
  resolve: (value: string | undefined) => void;
  reject: (err: Error) => void;
  kind: "prompt" | "select" | "manualCode";
  provider: string;
  createdAt: number;
};

type GlobalWithCallbacks = typeof globalThis & {
  __piLoginCallbacks?: Map<string, PendingResolver>;
  __piLoginSessions?: Map<string, AbortController>;
};

function getCallbacks(): Map<string, PendingResolver> {
  const g = globalThis as GlobalWithCallbacks;
  if (!g.__piLoginCallbacks) g.__piLoginCallbacks = new Map();
  return g.__piLoginCallbacks;
}

function getSessions(): Map<string, AbortController> {
  const g = globalThis as GlobalWithCallbacks;
  if (!g.__piLoginSessions) g.__piLoginSessions = new Map();
  return g.__piLoginSessions;
}

function makeToken(provider: string): string {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeSessionId(provider: string): string {
  return `session-${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 清理超过 10 分钟的悬挂 resolver，避免内存泄漏。 */
function gcCallbacks() {
  const now = Date.now();
  const map = getCallbacks();
  for (const [token, entry] of map.entries()) {
    if (now - entry.createdAt > 10 * 60 * 1000) {
      try {
        entry.reject(new Error("Login prompt timed out"));
      } catch {
        // ignore
      }
      map.delete(token);
    }
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ provider: string }> }
) {
  const { provider } = await ctx.params;
  if (!provider) {
    return NextResponse.json({ error: "provider required" }, { status: 400 });
  }

  const auth = getAuth();
  const providers = auth.getOAuthProviders();
  const oauthProvider = providers.find((p) => p.id === provider);
  if (!oauthProvider) {
    return NextResponse.json(
      { error: `OAuth provider not supported: ${provider}` },
      { status: 404 }
    );
  }

  gcCallbacks();

  const encoder = new TextEncoder();
  const callbacks = getCallbacks();
  const sessions = getSessions();
  const sessionId = makeSessionId(provider);
  const abortController = new AbortController();
  sessions.set(sessionId, abortController);

  // 客户端断开时 abort 登录流程
  req.signal.addEventListener("abort", () => {
    abortController.abort();
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (eventType: string, data: unknown) => {
        if (closed) return;
        const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        sessions.delete(sessionId);
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      // 创建一个 pending resolver，下发 token 给客户端，等 POST 回传
      const waitFor = (kind: PendingResolver["kind"]): Promise<string> => {
        return new Promise<string>((resolve, reject) => {
          const token = makeToken(provider);
          callbacks.set(token, {
            resolve: (v) => {
              callbacks.delete(token);
              if (v == null) reject(new Error("Cancelled"));
              else resolve(v);
            },
            reject: (err) => {
              callbacks.delete(token);
              reject(err);
            },
            kind,
            provider,
            createdAt: Date.now(),
          });
          send(`${kind}_request`, { token });
        });
      };

      send("session", { sessionId });

      try {
        await auth.login(provider, {
          onAuth: (info: OAuthAuthInfo) => send("auth", info),
          onDeviceCode: (info: OAuthDeviceCodeInfo) =>
            send("device_code", info),
          onPrompt: async (p: OAuthPrompt) => {
            const token = makeToken(provider);
            return new Promise<string>((resolve, reject) => {
              callbacks.set(token, {
                resolve: (v) => {
                  callbacks.delete(token);
                  if (v == null) reject(new Error("Prompt cancelled"));
                  else resolve(v);
                },
                reject: (err) => {
                  callbacks.delete(token);
                  reject(err);
                },
                kind: "prompt",
                provider,
                createdAt: Date.now(),
              });
              send("prompt_request", { token, prompt: p });
            });
          },
          onSelect: async (p: OAuthSelectPrompt) => {
            const token = makeToken(provider);
            return new Promise<string | undefined>((resolve, reject) => {
              callbacks.set(token, {
                resolve: (v) => {
                  callbacks.delete(token);
                  resolve(v == null ? undefined : v);
                },
                reject: (err) => {
                  callbacks.delete(token);
                  reject(err);
                },
                kind: "select",
                provider,
                createdAt: Date.now(),
              });
              send("select_request", { token, prompt: p });
            });
          },
          onProgress: (msg: string) => send("progress", { message: msg }),
          onManualCodeInput: () => waitFor("manualCode"),
          signal: abortController.signal,
        });

        // 登录完成后 SDK 已把凭证写入 auth.json
        getModelRegistry().refresh();
        send("success", { provider });
      } catch (e) {
        const err = e as Error;
        if (abortController.signal.aborted) {
          send("cancelled", { provider });
        } else {
          send("error", { message: err?.message || String(err) });
        }
      } finally {
        close();
      }
    },
    cancel() {
      abortController.abort();
      sessions.delete(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      token?: string;
      response?: string | null;
      cancel?: boolean;
    };
    const token = body.token;
    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const map = getCallbacks();
    const entry = map.get(token);
    if (!entry) {
      return NextResponse.json(
        { error: "token expired or unknown" },
        { status: 410 }
      );
    }

    // 防止跨 provider 串通
    if (entry.provider !== provider) {
      return NextResponse.json(
        { error: "provider mismatch" },
        { status: 400 }
      );
    }

    if (body.cancel) {
      entry.resolve(undefined);
      return NextResponse.json({ ok: true, cancelled: true });
    }

    const value =
      typeof body.response === "string" ? body.response : undefined;

    // select 类型允许空（视为取消）；prompt / manualCode 不允许 undefined
    if (value === undefined && entry.kind !== "select") {
      return NextResponse.json(
        { error: "response required" },
        { status: 400 }
      );
    }

    entry.resolve(value);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
