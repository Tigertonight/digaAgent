"use client";

/**
 * CollabSettingsSection —— 设置页中的 Collab 全局开关（RFC-2 Phase B4）。
 *
 * 仅作 next/dynamic wrapper：把真正实现 CollabSettingsSectionInner 设为
 * { ssr: false } 的客户端组件，从而：
 *   1. 避免 SSR / 首次 CSR hydration mismatch（localStorage 仅 CSR 可读）。
 *   2. 让 Inner 内能用 useState lazy init 直接读 localStorage，
 *      无需 useEffect 触发 set-state-in-effect 警告（91 warnings 持平偏好）。
 */

import dynamic from "next/dynamic";

const CollabSettingsSectionInner = dynamic(
  () => import("./CollabSettingsSectionInner"),
  { ssr: false }
);

export function CollabSettingsSection() {
  return <CollabSettingsSectionInner />;
}
