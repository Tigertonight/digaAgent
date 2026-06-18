"use client";

import { useEffect, useState } from "react";
import { userFacingMessage } from "@/lib/user-facing-error";
import type {
  AgentProfile,
  AgentProfilesSettings,
  ProfileAxes,
} from "@/lib/agent-profiles/types";

const RISK_LABEL: Record<AgentProfile["risk"], string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

const AXIS_LABELS: Array<{ key: keyof ProfileAxes; label: string }> = [
  { key: "communication", label: "沟通风格" },
  { key: "approval", label: "审批" },
  { key: "sandbox", label: "权限边界" },
  { key: "reasoning", label: "推理强度" },
  { key: "display", label: "过程展示" },
  { key: "toolsets", label: "工具族" },
];

function axisValue(axes: ProfileAxes, key: keyof ProfileAxes): string {
  const v = axes[key];
  return Array.isArray(v) ? v.join(", ") : String(v);
}

export function AgentProfilesSettingsSection() {
  const [settings, setSettings] = useState<AgentProfilesSettings | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/preferences/agent-profiles", {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          agentProfiles?: AgentProfilesSettings;
          builtInProfiles?: AgentProfile[];
        };
        if (cancelled) return;
        setSettings(data.agentProfiles ?? null);
        setProfiles([
          ...(data.builtInProfiles ?? []),
          ...(data.agentProfiles?.customProfiles ?? []),
        ]);
      } catch (err) {
        if (!cancelled) setError(userFacingMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function selectDefault(id: string) {
    if (saving || settings?.defaultProfileId === id) return;
    const previous = settings;
    setSettings((s) => (s ? { ...s, defaultProfileId: id } : s));
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/preferences/agent-profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultProfileId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        agentProfiles?: AgentProfilesSettings;
      };
      if (data.agentProfiles) setSettings(data.agentProfiles);
      setSaved(true);
    } catch (err) {
      setSettings(previous ?? null);
      setError(userFacingMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const defaultId = settings?.defaultProfileId;

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-token-lg font-semibold text-[color:var(--text)]">
          Agent Profiles
        </h2>
        <p className="text-token-body text-[color:var(--text-muted)]">
          每个 profile 是一组配置轴的打包：沟通风格、审批、权限边界、推理强度、过程展示、工具族。
          这里可以查看每个 profile 背后的轴，并选择默认 profile。
        </p>
        <p className="text-token-sm text-[color:var(--text-dim)]">
          注意：当前阶段仅展示与默认选择，profile 尚未真正改变工具权限或执行行为（后续阶段接入）。
          权限边界在系统级沙盒就绪前为软边界（靠工具可见性 + 审批实现）。
        </p>
      </header>

      {error ? (
        <div
          className="rounded-md border px-3 py-2 text-token-sm"
          style={{
            borderColor: "var(--color-danger)",
            background: "var(--color-danger-bg)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-token-body text-[color:var(--text-muted)]">加载中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {profiles.map((profile) => {
            const selected = profile.id === defaultId;
            return (
              <div
                key={profile.id}
                className={`rounded-md border p-4 ${
                  selected
                    ? "border-[color:var(--bg-selected)] bg-[color:var(--bg-selected)]"
                    : "border-[color:var(--border)] bg-[color:var(--bg-panel)]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-token-lg font-semibold text-[color:var(--text)]">
                        {profile.label}
                      </span>
                      <span
                        className="rounded-full border px-2 py-0.5 text-token-xs"
                        style={{
                          borderColor:
                            profile.risk === "high"
                              ? "var(--color-danger)"
                              : "var(--border)",
                          color:
                            profile.risk === "high"
                              ? "var(--color-danger)"
                              : "var(--text-muted)",
                        }}
                      >
                        {RISK_LABEL[profile.risk]}
                      </span>
                      {profile.builtIn ? (
                        <span className="text-token-xs text-[color:var(--text-dim)]">
                          内置
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-token-body text-[color:var(--text-muted)]">
                      {profile.description}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={saving || selected}
                    onClick={() => void selectDefault(profile.id)}
                    aria-pressed={selected}
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-token-sm transition disabled:cursor-not-allowed ${
                      selected
                        ? "border-[color:var(--accent)] text-[color:var(--accent)]"
                        : "border-[color:var(--border)] text-[color:var(--text)] hover:bg-[color:var(--bg-hover)]"
                    }`}
                  >
                    {selected ? "默认" : "设为默认"}
                  </button>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-3">
                  {AXIS_LABELS.map(({ key, label }) => (
                    <div key={key} className="min-w-0">
                      <dt className="text-token-xs text-[color:var(--text-dim)]">
                        {label}
                      </dt>
                      <dd className="truncate text-token-sm text-[color:var(--text)]">
                        {axisValue(profile.defaults, key)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      )}

      {saved && !error ? (
        <p className="text-token-sm text-[color:var(--text-dim)]">
          已保存默认 profile。
        </p>
      ) : null}
    </section>
  );
}

export default AgentProfilesSettingsSection;
