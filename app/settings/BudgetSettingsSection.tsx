"use client";

/**
 * BudgetSettingsSection —— 设置页中的 Budget 全局默认编辑区（RFC-2 Phase A4）
 *
 * 仅作 next/dynamic wrapper：把真正实现 BudgetSettingsSectionInner 设为
 * { ssr: false } 的客户端组件，从而：
 *   1. 避免 SSR / 首次 CSR hydration mismatch（localStorage 仅 CSR 可读）。
 *   2. 让 Inner 内能用 useState lazy init 直接读 localStorage，
 *      无需 useEffect 触发 set-state-in-effect 警告（91 warnings 持平偏好）。
 */

import dynamic from "next/dynamic";

const BudgetSettingsSectionInner = dynamic(
  () => import("./BudgetSettingsSectionInner"),
  { ssr: false }
);

export function BudgetSettingsSection() {
  return <BudgetSettingsSectionInner />;
}
