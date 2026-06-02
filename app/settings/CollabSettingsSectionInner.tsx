"use client";

/**
 * CollabSettingsSectionInner —— Collab 设置区的纯 CSR 实现（RFC-2 Phase B4）。
 *
 * 设计：
 *   - 仅通过 next/dynamic({ ssr: false }) 加载，因此 useState lazy init 时
 *     window/localStorage 一定可用 ——> 不再需要 useEffect 做 mount 后同步，
 *     从而避免 react-hooks/set-state-in-effect 警告（91 warnings 持平偏好）。
 *   - 当前只暴露 enabled 总开关（B 阶段约定：细粒度规则配置留 Phase C）。
 *   - 没有 Save 按钮：勾选变化立刻 saveCollabSettings。
 *
 * 总开关语义（与 server 端的关系）：
 *   - server 端**不读** settings——它一律弹气泡。
 *   - 关闭时由前端 useAgentEvents 在收到 approval_request 后立即 auto-allow，
 *     把决策走完。视觉上气泡不渲染（reducer 不会 push approval part）。
 *   - 这是用户的"逃生舱"：当审批气泡太烦想全局关闭时，前端绕过 UI 直接放行；
 *     代价是浪费一次 round-trip + server 仍然在拦截链路上（无害）。
 */

import { useCallback, useState } from "react";
import {
  DEFAULT_COLLAB_SETTINGS,
  loadCollabSettings,
  saveCollabSettings,
} from "@/lib/collab/settings";

export default function CollabSettingsSectionInner() {
  // 纯 CSR 组件（ssr: false 包装），lazy init 时直接读 localStorage。
  const [enabled, setEnabled] = useState<boolean>(
    () => loadCollabSettings().enabled
  );

  const onToggle = useCallback((next: boolean) => {
    setEnabled(next);
    saveCollabSettings({ ...DEFAULT_COLLAB_SETTINGS, enabled: next });
  }, []);

  return (
    <section className="mb-6 border border-neutral-800 rounded p-4">
      <h2 className="text-sm font-semibold mb-1">Collab · 工具审批</h2>
      <p className="text-xs text-neutral-500 mb-4">
        命中危险操作（如 rm -rf、git reset --hard）时弹审批气泡，等用户点
        Allow/Deny。关闭后所有审批前端自动放行。
      </p>

      <div className="flex flex-col gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>启用工具审批</span>
          <span className="text-xs text-neutral-500 ml-2">
            （关闭 = 所有 ask 规则前端自动 allow）
          </span>
        </label>
      </div>

      <p className="mt-4 text-[11px] text-neutral-600 leading-relaxed">
        提示：「本会话不再问」是 server 端记忆，新建 / 重启会话后失效；本总开关是
        client 端记忆，跨会话持久。规则本身（哪些工具触发审批）由内置规则集决定，
        细粒度配置留待后续版本。
      </p>
    </section>
  );
}
