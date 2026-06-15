import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@/lib/types";
import { shouldShowOnboarding } from "./EmptyState.helpers";

const fakeProvider = (over: Partial<ProviderInfo> = {}): ProviderInfo =>
  ({
    provider: "anthropic",
    displayName: "Anthropic",
    hasAuth: true,
    models: [],
    ...over,
  }) as ProviderInfo;

describe("shouldShowOnboarding (Ux-1)", () => {
  it("forceOnboarding=true 强制引导", () => {
    expect(shouldShowOnboarding({ forceOnboarding: true })).toBe(true);
    expect(
      shouldShowOnboarding({
        forceOnboarding: true,
        visibleProviders: [fakeProvider()],
      })
    ).toBe(true);
  });

  it("forceOnboarding=false 强制装饰", () => {
    expect(shouldShowOnboarding({ forceOnboarding: false })).toBe(false);
    expect(
      shouldShowOnboarding({ forceOnboarding: false, visibleProviders: [] })
    ).toBe(false);
  });

  it("visibleProviders 为空数组 → 引导", () => {
    expect(shouldShowOnboarding({ visibleProviders: [] })).toBe(true);
  });

  it("visibleProviders 有项 → 装饰（已经接好至少一家）", () => {
    expect(
      shouldShowOnboarding({ visibleProviders: [fakeProvider()] })
    ).toBe(false);
  });

  it("visibleProviders 为 null/undefined（还没加载）→ 装饰，避免闪", () => {
    expect(shouldShowOnboarding({ visibleProviders: null })).toBe(false);
    expect(shouldShowOnboarding({ visibleProviders: undefined })).toBe(false);
    expect(shouldShowOnboarding({})).toBe(false);
  });
});
