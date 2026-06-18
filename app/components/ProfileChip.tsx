"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type {
  AgentProfile,
  AgentProfilesSettings,
} from "@/lib/agent-profiles/types";

/**
 * 只读 profile chip（Phase B）。
 *
 * 展示当前生效的 profile（Phase B 阶段 = 全局默认 profile；session 级 override 在
 * 后续 Phase 接入）。纯展示，不改变任何运行时行为。自包含拉取，避免改动 Composer
 * 的 props 链路。点击打开一个小的轴摘要 popover。
 */
export function ProfileChip() {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/preferences/agent-profiles", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          agentProfiles?: AgentProfilesSettings;
          builtInProfiles?: AgentProfile[];
        };
        if (cancelled) return;
        const all = [
          ...(data.builtInProfiles ?? []),
          ...(data.agentProfiles?.customProfiles ?? []),
        ];
        const id = data.agentProfiles?.defaultProfileId;
        setProfile(all.find((p) => p.id === id) ?? all[0] ?? null);
      } catch {
        // 只读展示，失败静默（chip 不显示）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!profile) return null;

  const axes = profile.defaults;

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-[color:var(--bg-hover)]"
        style={{ borderColor: "var(--border)" }}
        title={`当前 profile：${profile.label}`}
      >
        <Sparkles size={12} />
        {profile.label}
      </button>
      {open ? (
        <div
          className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-md border p-2 text-xs shadow-md"
          style={{
            borderColor: "var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
          }}
        >
          <div className="mb-1 font-semibold">{profile.label}</div>
          <div className="mb-2 text-[color:var(--text-muted)]">
            {profile.description}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <dt className="text-[color:var(--text-dim)]">沟通</dt>
            <dd>{axes.communication}</dd>
            <dt className="text-[color:var(--text-dim)]">审批</dt>
            <dd>{axes.approval}</dd>
            <dt className="text-[color:var(--text-dim)]">权限</dt>
            <dd>{axes.sandbox}</dd>
            <dt className="text-[color:var(--text-dim)]">推理</dt>
            <dd>{axes.reasoning}</dd>
            <dt className="text-[color:var(--text-dim)]">展示</dt>
            <dd>{axes.display}</dd>
          </dl>
          <div className="mt-2 text-[10px] text-[color:var(--text-dim)]">
            只读预览，暂不改变执行行为。可在设置 · Agent Profiles 中切换默认。
          </div>
        </div>
      ) : null}
    </span>
  );
}

export default ProfileChip;
