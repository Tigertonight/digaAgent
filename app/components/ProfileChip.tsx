"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type {
  AgentProfile,
  AgentProfilesSettings,
} from "@/lib/agent-profiles/types";

/**
 * 展示当前默认工作模式。点击打开简短摘要，避免在 composer 里直接暴露底层配置枚举。
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
  const displayName =
    profile.id === "daily" ? "日常" : profile.id === "coding" ? "编程" : profile.label;
  const displayDescription =
    profile.id === "daily"
      ? "适合问答、检索、整理和归纳。"
      : profile.id === "coding"
        ? "适合代码阅读、修改和验证。"
        : profile.description;
  const approvalLabel =
    axes.approval === "on-request" ? "需要时询问" : axes.approval;
  const sandboxLabel =
    axes.sandbox === "workspace-write"
      ? "可修改工作区"
      : axes.sandbox === "read-only"
        ? "默认只读"
        : axes.sandbox;
  const reasoningLabel = axes.reasoning === "high" ? "更深入" : "标准";
  const displayLabel = axes.display === "full" ? "完整展示" : "摘要展示";

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-[color:var(--bg-hover)]"
        style={{ borderColor: "var(--border)" }}
        title={`当前工作模式：${displayName}`}
      >
        <Sparkles size={12} />
        {displayName}
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
          <div className="mb-1 font-semibold">{displayName}模式</div>
          <div className="mb-2 text-[color:var(--text-muted)]">
            {displayDescription}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <dt className="text-[color:var(--text-dim)]">沟通</dt>
            <dd>{axes.communication === "coding" ? "工程表达" : "日常表达"}</dd>
            <dt className="text-[color:var(--text-dim)]">审批</dt>
            <dd>{approvalLabel}</dd>
            <dt className="text-[color:var(--text-dim)]">权限</dt>
            <dd>{sandboxLabel}</dd>
            <dt className="text-[color:var(--text-dim)]">推理</dt>
            <dd>{reasoningLabel}</dd>
            <dt className="text-[color:var(--text-dim)]">展示</dt>
            <dd>{displayLabel}</dd>
          </dl>
          <div className="mt-2 text-[10px] text-[color:var(--text-dim)]">
            可在设置 · 工作模式 中切换默认。
          </div>
        </div>
      ) : null}
    </span>
  );
}

export default ProfileChip;
