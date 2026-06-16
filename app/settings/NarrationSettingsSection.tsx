"use client";

import { useEffect, useState } from "react";
import { Button, FieldInput } from "@/app/components/DesignPrimitives";
import { userFacingMessage } from "@/lib/user-facing-error";

interface NarrationSettings {
  enable: boolean;
  timeoutMs: number;
  provider?: string;
  modelId?: string;
}

const DEFAULTS: NarrationSettings = { enable: true, timeoutMs: 800 };
const MIN_TIMEOUT = 200;
const MAX_TIMEOUT = 3000;

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.timeoutMs;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(value)));
}

export function NarrationSettingsSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [enable, setEnable] = useState<boolean>(DEFAULTS.enable);
  const [timeoutMs, setTimeoutMs] = useState<number>(DEFAULTS.timeoutMs);
  const [provider, setProvider] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/preferences/narration", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { narration?: NarrationSettings };
        if (cancelled) return;
        const n = data.narration ?? DEFAULTS;
        setEnable(Boolean(n.enable));
        setTimeoutMs(clampTimeout(Number(n.timeoutMs ?? DEFAULTS.timeoutMs)));
        setProvider(typeof n.provider === "string" ? n.provider : "");
        setModelId(typeof n.modelId === "string" ? n.modelId : "");
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

  async function save(patch: Partial<NarrationSettings>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/preferences/narration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { narration?: NarrationSettings };
      if (data.narration) {
        setEnable(Boolean(data.narration.enable));
        setTimeoutMs(clampTimeout(Number(data.narration.timeoutMs ?? DEFAULTS.timeoutMs)));
        setProvider(typeof data.narration.provider === "string" ? data.narration.provider : "");
        setModelId(typeof data.narration.modelId === "string" ? data.narration.modelId : "");
      }
      setSavedAt(Date.now());
    } catch (err) {
      setError(userFacingMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-5 text-token-sm leading-relaxed">
      <header className="flex flex-col gap-1">
        <h2 className="text-token-lg font-semibold text-[color:var(--text)]">思维链叙事</h2>
        <p className="text-[color:var(--text-muted)]">
          控制工具反检过程的人话叙事。关闭后只用规则文案；开启后会在
          {` ${timeoutMs}ms `}
          内尝试用 LLM 改写，超时自动回落规则文案。
        </p>
      </header>

      {error ? (
        <div
          className="rounded-md border px-3 py-2"
          style={{
            borderColor: "var(--color-danger)",
            background: "var(--color-danger-bg)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enable}
            disabled={loading || saving}
            onChange={(e) => {
              const next = e.target.checked;
              setEnable(next);
              void save({ enable: next });
            }}
          />
          <span>启用 LLM 叙事增强</span>
        </label>
        {savedAt && !error ? (
          <span className="text-token-xs text-[color:var(--text-dim)]">已保存</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[color:var(--text-muted)]">同步等待上限（毫秒）</span>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={MIN_TIMEOUT}
            max={MAX_TIMEOUT}
            step={50}
            value={timeoutMs}
            disabled={loading || saving || !enable}
            onChange={(e) => setTimeoutMs(clampTimeout(Number(e.target.value)))}
            onMouseUp={() => void save({ timeoutMs })}
            onTouchEnd={() => void save({ timeoutMs })}
          />
          <span className="tabular-nums">{timeoutMs} ms</span>
        </div>
        <p className="text-token-xs text-[color:var(--text-dim)]">
          越短越能保证零延迟，越长越可能拿到 LLM 改写。推荐 600 - 1200 ms。
        </p>
      </div>

      <details className="rounded-md border px-3 py-2"
        style={{ borderColor: "var(--border-soft)" }}>
        <summary className="cursor-pointer text-[color:var(--text-muted)]">
          高级：单独指定叙事模型（默认跟随聊天模型）
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-token-xs text-[color:var(--text-muted)]">provider</span>
            <FieldInput
              value={provider}
              placeholder="留空跟随 lastModel"
              onChange={(e) => setProvider(e.target.value)}
              onBlur={() => void save({ provider: provider.trim() || undefined })}
              disabled={loading || saving}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-token-xs text-[color:var(--text-muted)]">modelId</span>
            <FieldInput
              value={modelId}
              placeholder="留空跟随 lastModel"
              onChange={(e) => setModelId(e.target.value)}
              onBlur={() => void save({ modelId: modelId.trim() || undefined })}
              disabled={loading || saving}
            />
          </label>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving || (!provider && !modelId)}
              onClick={() => {
                setProvider("");
                setModelId("");
                void save({ provider: undefined, modelId: undefined });
              }}
            >
              恢复跟随主模型
            </Button>
          </div>
        </div>
      </details>

    </section>
  );
}

export default NarrationSettingsSection;
