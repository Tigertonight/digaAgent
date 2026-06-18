"use client";

import { Code2, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { userFacingMessage } from "@/lib/user-facing-error";

type WorkMode = "coding" | "daily";

interface CommunicationSettings {
  workMode: WorkMode;
}

const DEFAULTS: CommunicationSettings = { workMode: "coding" };

const MODES: Array<{
  id: WorkMode;
  title: string;
  subtitle: string;
  icon: typeof Code2;
}> = [
  {
    id: "coding",
    title: "适用于编程",
    subtitle: "更具技术性的回复和控制",
    icon: Code2,
  },
  {
    id: "daily",
    title: "适用于日常工作",
    subtitle: "同样强大，技术细节更少",
    icon: MessageCircle,
  },
];

export function CommunicationSettingsSection() {
  const [workMode, setWorkMode] = useState<WorkMode>(DEFAULTS.workMode);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/preferences/communication", {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          communication?: Partial<CommunicationSettings>;
        };
        if (cancelled) return;
        setWorkMode(
          data.communication?.workMode === "daily" ? "daily" : "coding"
        );
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

  async function save(nextMode: WorkMode) {
    if (saving || nextMode === workMode) return;
    const previous = workMode;
    setWorkMode(nextMode);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/preferences/communication", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workMode: nextMode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        communication?: Partial<CommunicationSettings>;
      };
      setWorkMode(
        data.communication?.workMode === "daily" ? "daily" : "coding"
      );
      setSaved(true);
    } catch (err) {
      setWorkMode(previous);
      setError(userFacingMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-token-lg font-semibold text-[color:var(--text)]">
          工作模式
        </h2>
        <p className="text-token-body text-[color:var(--text-muted)]">
          选择 Diga Agent 默认显示多少技术细节。
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

      <div className="grid gap-4 md:grid-cols-2">
        {MODES.map((mode) => {
          const Icon = mode.icon;
          const selected = workMode === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              disabled={loading || saving}
              aria-pressed={selected}
              onClick={() => void save(mode.id)}
              className={`flex min-h-[96px] items-center justify-between gap-4 rounded-md border p-5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? "border-[color:var(--bg-selected)] bg-[color:var(--bg-selected)]"
                  : "border-[color:var(--border)] bg-[color:var(--bg-panel)] hover:bg-[color:var(--bg-hover)]"
              }`}
            >
              <div className="flex min-w-0 items-center gap-4">
                <Icon
                  size={26}
                  className="shrink-0 text-[color:var(--text)]"
                />
                <div className="min-w-0">
                  <div className="text-token-lg font-semibold text-[color:var(--text)]">
                    {mode.title}
                  </div>
                  <div className="mt-1 text-token-body font-semibold text-[color:var(--text-muted)]">
                    {mode.subtitle}
                  </div>
                </div>
              </div>
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${
                  selected
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]"
                    : "border-[color:var(--border)]"
                }`}
                aria-hidden="true"
              >
                {selected ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-white" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {saved && !error ? (
        <p className="text-token-sm text-[color:var(--text-dim)]">
          已保存。新的对话和后续回复会使用这个模式。
        </p>
      ) : null}
    </section>
  );
}

export default CommunicationSettingsSection;
