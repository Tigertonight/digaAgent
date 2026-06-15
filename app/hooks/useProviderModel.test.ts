import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@/lib/types";
import { normalizeProviderModelSelection } from "./useProviderModel";

const mk = (
  provider: string,
  models: string[],
  hasAuth = true
): ProviderInfo =>
  ({
    provider,
    displayName: provider,
    hasAuth,
    models: models.map((id) => ({ id, name: id })),
  }) as ProviderInfo;

describe("normalizeProviderModelSelection", () => {
  it("用户上次选中的 provider+model 都仍可见 → 原样返回", () => {
    const r = normalizeProviderModelSelection(
      [mk("p1", ["m1", "m2"]), mk("p2", ["x"])],
      "p1",
      "m2"
    );
    expect(r).toEqual({ providerId: "p1", modelId: "m2" });
  });

  it("provider 仍在但 modelId 失效 → 保留 provider，回到该 provider 的默认/首个 model", () => {
    const r = normalizeProviderModelSelection(
      [mk("p1", ["a", "b"]), mk("p2", ["x"])],
      "p1",
      "已删除的 model",
      "openai-codex",
      "gpt-5.5"
    );
    // p1 没有默认 model gpt-5.5 → 回首个
    expect(r.providerId).toBe("p1");
    expect(r.modelId).toBe("a");
  });

  it("provider 不在了 → 走 defaultProvider", () => {
    const r = normalizeProviderModelSelection(
      [mk("openai-codex", ["gpt-5.5", "other"]), mk("p2", ["x"])],
      "已退出 keychain 的 provider",
      "anything",
      "openai-codex",
      "gpt-5.5"
    );
    expect(r).toEqual({ providerId: "openai-codex", modelId: "gpt-5.5" });
  });

  it("defaultProvider 也不在 → 取 visibleProviders 第一个", () => {
    const r = normalizeProviderModelSelection(
      [mk("p1", ["m1"])],
      "ghost",
      "ghost",
      "openai-codex",
      "gpt-5.5"
    );
    expect(r).toEqual({ providerId: "p1", modelId: "m1" });
  });

  it("空 providers → 空字符串对", () => {
    expect(normalizeProviderModelSelection([], "p", "m")).toEqual({
      providerId: "",
      modelId: "",
    });
  });

  it("provider 在但 model 是 defaultModel 时取 defaultModel", () => {
    const r = normalizeProviderModelSelection(
      [mk("openai-codex", ["gpt-5.5", "gpt-4"])],
      "openai-codex",
      "无关",
      "openai-codex",
      "gpt-5.5"
    );
    expect(r.modelId).toBe("gpt-5.5");
  });

  it("当前 providerId 为空但 defaultProvider 在 → 用 default", () => {
    const r = normalizeProviderModelSelection(
      [mk("openai-codex", ["gpt-5.5"])],
      "",
      "",
      "openai-codex",
      "gpt-5.5"
    );
    expect(r).toEqual({ providerId: "openai-codex", modelId: "gpt-5.5" });
  });
});
