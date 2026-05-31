/**
 * /api/auth —— 管理 ~/.pi/auth.json 凭证。
 *
 * GET                  列出所有 provider 的认证状态（不返回 key 值）
 * PUT  { provider, apiKey }    保存 API key（覆盖）
 * DELETE ?provider=xx           删除 provider 凭证
 *
 * OAuth 登录流程在浏览器里跑不通（要交互），暂不暴露 login API。
 * 只允许通过 CLI `pi login` 来 OAuth。
 */
import { NextResponse } from "next/server";
import { getAuth, getModelRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = getAuth();
    const mr = getModelRegistry();

    // 所有已注册 provider 的并集（已存凭证的 + ModelRegistry 已知的）
    const storedProviders = auth.list();
    const knownProviders = new Set<string>(storedProviders);
    for (const m of mr.getAll()) knownProviders.add(m.provider);
    const allProviders = Array.from(knownProviders).sort();

    const oauthProviders = auth.getOAuthProviders().map((p) => p.id);
    const oauthSet = new Set(oauthProviders);

    const items = allProviders.map((provider) => {
      const cred = auth.get(provider);
      const status = mr.getProviderAuthStatus(provider);
      return {
        provider,
        displayName: mr.getProviderDisplayName(provider),
        hasAuth: auth.hasAuth(provider),
        credentialType: cred?.type ?? null, // "api_key" | "oauth" | null
        status, // { configured, source?, label? }
        supportsOAuth: oauthSet.has(provider),
      };
    });

    return NextResponse.json({
      providers: items,
      oauthProviders,
      authPath: process.env.HOME
        ? `${process.env.HOME}/.pi/auth.json`
        : undefined,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      provider?: string;
      apiKey?: string;
    };
    if (!body.provider || !body.apiKey) {
      return NextResponse.json(
        { error: "provider and apiKey required" },
        { status: 400 }
      );
    }
    const auth = getAuth();
    auth.set(body.provider, { type: "api_key", key: body.apiKey });
    // 通知 ModelRegistry 重读（让 hasAuth 在下次 /api/providers 立即生效）
    getModelRegistry().refresh();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider");
    if (!provider) {
      return NextResponse.json(
        { error: "provider required" },
        { status: 400 }
      );
    }
    const auth = getAuth();
    auth.remove(provider);
    getModelRegistry().refresh();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
