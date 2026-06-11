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
    <section className="mb-6 rounded-token border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
      <h2 className="mb-1 text-token-body font-semibold">工具操作确认</h2>
      <p className="mb-4 text-token-sm text-[color:var(--text-muted)]">
        开启后，删除文件、重置 Git、执行高风险命令等操作前会先询问你。关闭后将自动允许这些操作。
      </p>

      <div className="flex flex-col gap-3 text-token-body">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>高风险操作前先询问</span>
          <span className="ml-2 text-token-sm text-[color:var(--text-muted)]">
            （关闭后不再弹出确认）
          </span>
        </label>
      </div>

      <p className="mt-4 text-token-xs leading-relaxed text-[color:var(--text-dim)]">
        提示：「本会话不再问」只对当前会话生效；这里的总开关会跨会话保留。哪些操作需要确认由内置安全规则决定。
      </p>
    </section>
  );
}
