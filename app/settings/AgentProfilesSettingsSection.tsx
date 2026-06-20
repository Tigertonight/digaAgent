"use client";

import { useEffect, useState } from "react";
import { Badge, Button } from "@/app/components/DesignPrimitives";
import { userFacingMessage } from "@/lib/user-facing-error";
import type {
  AgentProfile,
  AgentProfilesSettings,
  ProfileAxes,
} from "@/lib/agent-profiles/types";

const RISK_LABEL: Record<AgentProfile["risk"], string> = {
  low: "更保守",
  medium: "平衡",
  high: "更主动",
};

const AXIS_LABELS: Array<{ key: keyof ProfileAxes; label: string }> = [
  { key: "communication", label: "沟通风格" },
  { key: "approval", label: "审批" },
  { key: "sandbox", label: "权限边界" },
  { key: "reasoning", label: "推理强度" },
  { key: "display", label: "过程展示" },
  { key: "toolsets", label: "工具族" },
];

const AXIS_VALUE_LABELS: Partial<Record<keyof ProfileAxes, Record<string, string>>> = {
  communication: {
    daily: "日常表达",
    coding: "工程表达",
  },
  approval: {
    "on-request": "需要时询问",
  },
  sandbox: {
    "read-only": "默认只读",
    "workspace-write": "可修改工作区",
  },
  reasoning: {
    medium: "标准",
    high: "更深入",
  },
  display: {
    grouped: "摘要展示",
    full: "完整展示",
  },
  toolsets: {
    chat: "对话",
    research: "检索",
    browser: "浏览器",
    "code-read": "代码阅读",
    "code-write": "代码修改",
    workflow: "工作流",
  },
};

function axisValue(axes: ProfileAxes, key: keyof ProfileAxes): string {
  const v = axes[key];
  const labels = AXIS_VALUE_LABELS[key] ?? {};
  if (Array.isArray(v)) {
    return v.map((item) => labels[item] ?? item).join("、");
  }
  const raw = String(v);
  return labels[raw] ?? raw;
}

function profileDisplay(profile: AgentProfile) {
  if (profile.id === "daily") {
    return {
      title: "日常模式",
      summary: "适合问答、检索、整理和归纳。回答更轻量，默认更保守。",
      details: "默认偏只读，适合不需要改代码的任务。",
    };
  }
  if (profile.id === "coding") {
    return {
      title: "编程模式",
      summary: "适合阅读代码、修改实现、运行检查和编排工作流。",
      details: "会使用更深入的推理和更完整的过程展示，需要时仍会请求确认。",
    };
  }
  return {
    title: profile.label,
    summary: profile.description,
    details: profile.builtIn ? "内置模式" : "自定义模式",
  };
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
          工作模式
        </h2>
        <p className="text-token-body text-[color:var(--text-muted)]">
          选择 Agent 默认用哪种方式开始工作。日常模式更轻，编程模式更适合代码和复杂任务。
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
            const display = profileDisplay(profile);
            return (
              <div
                key={profile.id}
                className={`rounded-md border bg-[color:var(--bg-panel)] p-4 transition ${
                  selected
                    ? "border-[color:var(--accent)]"
                    : "border-[color:var(--border)]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-token-lg font-semibold text-[color:var(--text)]">
                        {display.title}
                      </span>
                      <Badge tone={profile.risk === "high" ? "warning" : "default"} variant="outline">
                        {RISK_LABEL[profile.risk]}
                      </Badge>
                      {profile.builtIn ? (
                        <Badge tone="default" variant="outline">
                          内置
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-token-body text-[color:var(--text-muted)]">
                      {display.summary}
                    </div>
                    <div className="mt-1 text-token-sm text-[color:var(--text-dim)]">
                      {display.details}
                    </div>
                  </div>
                  <Button
                    disabled={saving || selected}
                    onClick={() => void selectDefault(profile.id)}
                    aria-pressed={selected}
                    className="shrink-0"
                    size="sm"
                    tone={selected ? "accent" : "default"}
                    variant={selected ? "soft" : "outline"}
                  >
                    {selected ? "默认" : "设为默认"}
                  </Button>
                </div>

                <details className="mt-3 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-2">
                  <summary className="cursor-pointer text-token-sm font-medium text-[color:var(--text-muted)]">
                    查看详细配置
                  </summary>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
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
                </details>
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
