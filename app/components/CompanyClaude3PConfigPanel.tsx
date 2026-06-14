"use client";

import { ArrowLeft, Building2, Clipboard, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { LabeledInput } from "./models/FormFields";
import type { ModelEntry, ModelsConfig, ProviderEntry } from "./models/types";

interface Props {
  onClose: () => void;
  onBack?: () => void;
  onChanged?: () => void;
}

const PROVIDER_KEY = "company-claude-3p";
const DEFAULT_BASE_URL = "";
const DEFAULT_MODEL_ID = "global.anthropic.claude-opus-4-7";
const DEFAULT_MODEL_NAME = "Claude Opus 4.7";

function normalizeConfig(data?: ModelsConfig): ModelsConfig {
  if (!data || !data.providers || typeof data.providers !== "object") {
    return { providers: {} };
  }
  return data;
}

function firstModel(provider?: ProviderEntry): ModelEntry | undefined {
  return provider?.models?.[0];
}

export default function CompanyClaude3PConfigPanel({
  onClose,
  onBack,
  onChanged,
}: Props) {
  const [cfg, setCfg] = useState<ModelsConfig>({ providers: {} });
  const [path, setPath] = useState<string | undefined>();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [modelName, setModelName] = useState(DEFAULT_MODEL_NAME);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const existing = cfg.providers[PROVIDER_KEY];
  const hasExisting = !!existing;

  const providerDraft = useMemo<ProviderEntry>(
    () => ({
      baseUrl: baseUrl.trim(),
      api: "anthropic-messages",
      apiKey: apiKey.trim(),
      models: [
        {
          id: modelId.trim(),
          name: modelName.trim() || modelId.trim(),
          api: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 8192,
        },
      ],
    }),
    [apiKey, baseUrl, modelId, modelName]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await fetch("/api/models-config");
      const d = (await r.json()) as {
        path?: string;
        data?: ModelsConfig;
        error?: string;
      };
      if (!r.ok || d.error) {
        setErr(d.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = normalizeConfig(d.data);
      const provider = data.providers[PROVIDER_KEY];
      const model = firstModel(provider);
      setCfg(data);
      setPath(d.path);
      setBaseUrl(provider?.baseUrl ?? DEFAULT_BASE_URL);
      setApiKey(provider?.apiKey ?? "");
      setModelId(model?.id ?? DEFAULT_MODEL_ID);
      setModelName(model?.name ?? DEFAULT_MODEL_NAME);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = useCallback(async () => {
    const cleanBaseUrl = baseUrl.trim();
    const cleanApiKey = apiKey.trim();
    const cleanModelId = modelId.trim();
    if (!cleanBaseUrl) {
      setErr("请填写公司 3P Base URL");
      return;
    }
    if (!cleanApiKey) {
      setErr("请填写公司 3P Token");
      return;
    }
    if (!cleanModelId) {
      setErr("请填写模型 ID");
      return;
    }

    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      const next: ModelsConfig = {
        providers: {
          ...cfg.providers,
          [PROVIDER_KEY]: providerDraft,
        },
      };
      const r = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || d.error) {
        setErr(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setCfg(next);
      setNotice("已保存，公司 3P 模型会出现在可用供应商列表中。");
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, cfg.providers, modelId, onChanged, providerDraft]);

  const remove = useCallback(async () => {
    setRemoving(true);
    setErr(null);
    setNotice(null);
    try {
      const providers = { ...cfg.providers };
      delete providers[PROVIDER_KEY];
      const next: ModelsConfig = { providers };
      const r = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || d.error) {
        setErr(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setCfg(next);
      setBaseUrl(DEFAULT_BASE_URL);
      setApiKey("");
      setModelId(DEFAULT_MODEL_ID);
      setModelName(DEFAULT_MODEL_NAME);
      setNotice("已移除公司 3P 模型配置。");
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  }, [cfg.providers, onChanged]);

  const test = useCallback(async () => {
    setTesting(true);
    setErr(null);
    setNotice(null);
    try {
      const model = providerDraft.models?.[0];
      const r = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: PROVIDER_KEY,
          provider: providerDraft,
          model,
        }),
      });
      const d = (await r.json()) as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
      };
      if (!r.ok || !d.ok) {
        setErr(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setNotice(
        d.latencyMs ? `连通性验证通过，耗时 ${d.latencyMs}ms。` : "连通性验证通过。"
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, [providerDraft]);

  const copyExample = () => {
    const example = {
      provider: PROVIDER_KEY,
      baseUrl: baseUrl || "https://your-company-claude-gateway.example/",
      model: modelId || DEFAULT_MODEL_ID,
      api: "anthropic-messages",
    };
    void navigator.clipboard?.writeText(JSON.stringify(example, null, 2));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <section
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-md border"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--fg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <div className="flex min-w-0 items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border hover:bg-[color:var(--bg-hover)]"
                style={{ borderColor: "var(--border)" }}
                aria-label="返回上一级"
                title="返回上一级"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <span
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: "var(--border)",
                background: "var(--bg-panel-2)",
              }}
            >
              <ProviderIcon provider={PROVIDER_KEY} size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">
                公司 Claude 3P 模型配置
              </h2>
              <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
                独立写入公司 3P provider，不会混入本地 / 自定义端点模板。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded border hover:bg-[color:var(--bg-hover)]"
            style={{ borderColor: "var(--border)" }}
            aria-label="关闭公司 3P 配置"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <div
            className="mb-4 rounded-md border p-3 text-xs leading-5"
            style={{
              borderColor: "var(--border-soft)",
              background: "var(--bg-panel-2)",
              color: "var(--text-muted)",
            }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium" style={{ color: "var(--fg)" }}>
              <Building2 size={14} />
              面向公司统一模型服务
            </div>
            <p>
              这里只配置 Claude 3P API 资源。自研 Coding 助手属于本机 CLI 客户端，
              本地模型、OpenRouter、Ollama、LM Studio 等仍在“本地 / 自定义端点”里配置。
            </p>
          </div>

          {err && (
            <div
              className="mb-3 rounded border p-2 text-xs"
              style={{
                background: "var(--color-danger-bg)",
                borderColor: "var(--color-danger)",
                color: "var(--color-danger)",
              }}
            >
              {err}
            </div>
          )}

          {notice && (
            <div
              className="mb-3 rounded border p-2 text-xs"
              style={{
                background: "var(--color-success-bg)",
                borderColor: "var(--color-success)",
                color: "var(--fg)",
              }}
            >
              {notice}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <LabeledInput
                label="公司 3P Base URL"
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder="https://your-company-claude-gateway.example/"
              />
            </div>
            <div className="sm:col-span-2">
              <LabeledInput
                label="公司 3P Token"
                value={apiKey}
                onChange={setApiKey}
                placeholder="粘贴公司发放的 bearer token"
                password
              />
            </div>
            <LabeledInput
              label="模型 ID"
              value={modelId}
              onChange={setModelId}
              placeholder={DEFAULT_MODEL_ID}
            />
            <LabeledInput
              label="展示名称"
              value={modelName}
              onChange={setModelName}
              placeholder={DEFAULT_MODEL_NAME}
            />
          </div>

          <div
            className="mt-3 rounded border px-3 py-2 text-xs leading-5"
            style={{
              borderColor: "var(--border-soft)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
            }}
          >
            保存后会写入固定 provider：
            <code className="mx-1 font-mono" style={{ color: "var(--fg)" }}>
              {PROVIDER_KEY}
            </code>
            ，协议固定为
            <code className="mx-1 font-mono" style={{ color: "var(--fg)" }}>
              anthropic-messages
            </code>
            。{path ? `配置文件位置：${path}` : "配置文件位置：~/.pi/agent/models.json"}
          </div>
        </div>

        <footer
          className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyExample}
              className="inline-flex h-8 items-center gap-1 rounded border px-2 text-xs hover:bg-[color:var(--bg-hover)]"
              style={{ borderColor: "var(--border)" }}
            >
              <Clipboard size={13} />
              复制摘要
            </button>
            {hasExisting && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={removing || loading || saving}
                className="inline-flex h-8 items-center gap-1 rounded border px-2 text-xs disabled:opacity-50 hover:bg-[color:var(--bg-hover)]"
                style={{
                  borderColor: "var(--color-danger)",
                  color: "var(--color-danger)",
                }}
              >
                <Trash2 size={13} />
                {removing ? "移除中…" : "移除配置"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void test()}
              disabled={testing || loading || saving}
              className="h-8 rounded border px-3 text-xs disabled:opacity-50 hover:bg-[color:var(--bg-hover)]"
              style={{ borderColor: "var(--border)" }}
            >
              {testing ? "验证中…" : "验证连接"}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loading}
              className="h-8 rounded px-3 text-xs font-medium disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--color-bg)" }}
            >
              {saving ? "保存中…" : "保存配置"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
