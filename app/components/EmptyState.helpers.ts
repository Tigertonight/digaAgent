import type { ProviderInfo } from "@/lib/types";

export interface ShouldShowOnboardingInput {
  visibleProviders?: ProviderInfo[] | null;
  forceOnboarding?: boolean;
}

/**
 * 判定 EmptyState 是否应渲染"三步引导卡"。抽到独立 .ts（非 .tsx）模块，
 * 让 vitest 在 environment=node 下能直接测试，不引入 jsdom / react-runtime。
 *
 * 规则：
 *  - forceOnboarding === true  → 引导
 *  - forceOnboarding === false → 装饰
 *  - 否则：visibleProviders 是数组且长度 0 → 引导（纯首次启动 / 全部 logout）
 *  - visibleProviders 为 null/undefined（还没拉到）→ 装饰，避免一开始就闪一下引导卡
 */
export function shouldShowOnboarding(input: ShouldShowOnboardingInput): boolean {
  if (typeof input.forceOnboarding === "boolean") return input.forceOnboarding;
  return (
    Array.isArray(input.visibleProviders) && input.visibleProviders.length === 0
  );
}
