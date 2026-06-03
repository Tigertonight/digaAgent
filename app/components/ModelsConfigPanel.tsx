"use client";

/**
 * Models 配置弹层（自助管理 ~/.pi/agent/models.json）。
 *
 * schema 直接用 SDK ModelRegistry 原生格式：
 *   {providers: {[name]: {baseUrl?, api?, apiKey?, headers?, models?: [...]}}}
 *
 * 操作：
 * - 列出现有 providers
 * - 添加 provider（输入 provider key 名 + baseUrl + api + apiKey）
 * - 删除 provider
 * - 在 provider 下添加/编辑/删除 model（id + name + contextWindow + maxTokens + reasoning + cost）
 * - 每个 model 行有 Test 按钮 → POST /api/models-config/test
 *
 * 写入：本地状态改动会立即"标脏"，要点 Save 才 PUT 全量覆盖。
 */
import { Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LabeledInput } from "./models/FormFields";
import { ProviderConfigCard } from "./models/ProviderConfigCard";
import {
  emptyModel,
  emptyProvider,
  type ModelEntry,
  type ModelsConfig,
  type ProviderEntry,
  type TestResult,
} from "./models/types";

interface Props {
  onClose: () => void;
  onChanged?: () => void;
}

export default function ModelsConfigPanel({ onClose, onChanged }: Props) {
  const [cfg, setCfg] = useState<ModelsConfig>({ providers: {} });
  const [origJson, setOrigJson] = useState<string>("");
  const [path, setPath] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProvName, setNewProvName] = useState("");

  // model 添加表单：providerKey -> 是否在添加
  const [addingModelIn, setAddingModelIn] = useState<string | null>(null);
  const [newModelDraft, setNewModelDraft] = useState<ModelEntry>(emptyModel());

  // test 状态：`${providerKey}|${modelId}` -> result
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/models-config");
      const d = (await r.json()) as {
        path?: string;
        data?: ModelsConfig;
        error?: string;
      };
      if (d.error) setErr(d.error);
      else {
        const data = d.data ?? { providers: {} };
        if (!data.providers || typeof data.providers !== "object") {
          data.providers = {};
        }
        setCfg(data);
        setOrigJson(JSON.stringify(data));
        setPath(d.path);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => JSON.stringify(cfg) !== origJson,
    [cfg, origJson]
  );

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || d.error) {
        setErr(d.error ?? `HTTP ${r.status}`);
      } else {
        setOrigJson(JSON.stringify(cfg));
        onChanged?.();
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }, [cfg, onChanged]);

  // === provider 操作 ===
  const addProvider = useCallback(() => {
    const key = newProvName.trim();
    if (!key) return;
    if (cfg.providers[key]) {
      setErr(`provider "${key}" 已存在`);
      return;
    }
    setCfg((c) => ({
      providers: { ...c.providers, [key]: emptyProvider() },
    }));
    setExpanded((x) => ({ ...x, [key]: true }));
    setNewProvName("");
    setAddingProvider(false);
  }, [newProvName, cfg.providers]);

  const removeProvider = useCallback((key: string) => {
    setCfg((c) => {
      const next = { ...c.providers };
      delete next[key];
      return { providers: next };
    });
  }, []);

  const updateProvider = useCallback(
    (key: string, patch: Partial<ProviderEntry>) => {
      setCfg((c) => ({
        providers: {
          ...c.providers,
          [key]: { ...c.providers[key], ...patch },
        },
      }));
    },
    []
  );

  // === model 操作 ===
  const addModel = useCallback(
    (provKey: string) => {
      const m = newModelDraft;
      const id = (m.id ?? "").trim();
      if (!id) return;
      const prov = cfg.providers[provKey];
      const models = prov?.models ?? [];
      if (models.some((x) => x.id === id)) {
        setErr(`model id "${id}" 在 ${provKey} 下已存在`);
        return;
      }
      const cleaned: ModelEntry = { ...m, id };
      if (cleaned.name === "") delete cleaned.name;
      setCfg((c) => ({
        providers: {
          ...c.providers,
          [provKey]: {
            ...c.providers[provKey],
            models: [...(c.providers[provKey]?.models ?? []), cleaned],
          },
        },
      }));
      setAddingModelIn(null);
      setNewModelDraft(emptyModel());
    },
    [cfg.providers, newModelDraft]
  );

  const removeModel = useCallback((provKey: string, modelId: string) => {
    setCfg((c) => {
      const prov = c.providers[provKey];
      if (!prov) return c;
      return {
        providers: {
          ...c.providers,
          [provKey]: {
            ...prov,
            models: (prov.models ?? []).filter((m) => m.id !== modelId),
          },
        },
      };
    });
  }, []);

  const updateModel = useCallback(
    (provKey: string, modelId: string, patch: Partial<ModelEntry>) => {
      setCfg((c) => {
        const prov = c.providers[provKey];
        if (!prov) return c;
        return {
          providers: {
            ...c.providers,
            [provKey]: {
              ...prov,
              models: (prov.models ?? []).map((m) =>
                m.id === modelId ? { ...m, ...patch } : m
              ),
            },
          },
        };
      });
    },
    []
  );

  // === test ===
  const runTest = useCallback(
    async (provKey: string, model: ModelEntry) => {
      const tk = `${provKey}|${model.id}`;
      setTesting((t) => ({ ...t, [tk]: true }));
      setTestResult((r) => ({ ...r, [tk]: { ok: false, error: "" } }));
      try {
        const provider = cfg.providers[provKey];
        const r = await fetch("/api/models-config/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: provKey,
            provider,
            model,
          }),
        });
        const d = (await r.json()) as TestResult;
        setTestResult((rr) => ({ ...rr, [tk]: d }));
      } catch (e) {
        setTestResult((rr) => ({
          ...rr,
          [tk]: { ok: false, error: String(e) },
        }));
      } finally {
        setTesting((t) => ({ ...t, [tk]: false }));
      }
    },
    [cfg.providers]
  );

  const providerKeys = Object.keys(cfg.providers).sort();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md w-full max-w-3xl max-h-[88vh] flex flex-col"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--fg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="px-4 py-2 flex items-center justify-between border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <span className="text-sm font-semibold inline-flex items-center gap-1.5">
            <Settings size={14} />
            Models config
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || saving}
              className="px-2 py-0.5 text-xs rounded border hover:opacity-80 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
              title="重新加载"
            >
              {loading ? "…" : "↻"}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || loading}
              className="px-2 py-0.5 text-xs rounded text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
              title="写入 models.json"
            >
              {saving ? "Saving…" : dirty ? "Save *" : "Save"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-0.5 text-xs rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
            >
              ✕
            </button>
          </div>
        </header>

        {err && (
          <div
            className="m-3 p-2 rounded text-xs"
            style={{
              background: "rgba(220,38,38,0.15)",
              border: "1px solid rgba(220,38,38,0.5)",
              color: "#fca5a5",
            }}
          >
            {err}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {providerKeys.length === 0 && !loading && (
            <div
              className="text-xs text-center py-8"
              style={{ color: "var(--fg-faint)" }}
            >
              （暂无 provider，点下方 + Add provider）
            </div>
          )}

          {providerKeys.map((provKey) => {
            const prov = cfg.providers[provKey];
            return (
              <ProviderConfigCard
                key={provKey}
                providerKey={provKey}
                provider={prov}
                isOpen={expanded[provKey] ?? false}
                addingModel={addingModelIn === provKey}
                newModelDraft={newModelDraft}
                testing={testing}
                testResult={testResult}
                onToggle={(key) =>
                  setExpanded((x) => ({ ...x, [key]: !(x[key] ?? false) }))
                }
                onRemoveProvider={removeProvider}
                onUpdateProvider={updateProvider}
                onRunTest={(key, model) => void runTest(key, model)}
                onRemoveModel={removeModel}
                onUpdateModel={updateModel}
                onAddModel={addModel}
                onStartAddModel={setAddingModelIn}
                onCancelAddModel={() => {
                  setAddingModelIn(null);
                  setNewModelDraft(emptyModel());
                }}
                setNewModelDraft={setNewModelDraft}
              />
            );
          })}

          {/* Add provider */}
          {addingProvider ? (
            <div
              className="rounded px-2 py-1.5 text-xs"
              style={{
                background: "var(--bg-panel-2)",
                border: "1px dashed var(--border)",
              }}
            >
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={newProvName}
                  onChange={(e) => setNewProvName(e.target.value)}
                  placeholder="provider key (e.g. anthropic, my-openrouter)"
                  className="flex-1 rounded px-2 py-1 text-xs border outline-none"
                  style={{
                    background: "var(--bg-panel)",
                    borderColor: "var(--border)",
                    color: "var(--fg)",
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addProvider();
                    if (e.key === "Escape") {
                      setAddingProvider(false);
                      setNewProvName("");
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={addProvider}
                  disabled={!newProvName.trim()}
                  className="px-2 py-1 text-xs rounded text-white disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddingProvider(false);
                    setNewProvName("");
                  }}
                  className="px-2 py-1 text-xs rounded border hover:opacity-80"
                  style={{ borderColor: "var(--border)" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingProvider(true)}
              className="w-full px-2 py-1.5 text-xs rounded border hover:opacity-80"
              style={{
                borderColor: "var(--border)",
                color: "var(--fg-muted)",
              }}
            >
              + Add provider
            </button>
          )}
        </div>

        {path && (
          <div
            className="px-4 py-2 border-t text-[10px] flex justify-between"
            style={{
              borderColor: "var(--border-soft)",
              color: "var(--fg-faint)",
            }}
          >
            <span>存储位置：{path}</span>
            {dirty && <span style={{ color: "#fbbf24" }}>有未保存改动</span>}
          </div>
        )}
      </div>
    </div>
  );
}
