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
import { ConfirmButton } from "./ConfirmButton";

type ApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface ModelEntry {
  id: string;
  name?: string;
  api?: ApiType;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  headers?: Record<string, string>;
  baseUrl?: string;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: string;
  models?: ModelEntry[];
  // 任何其它字段透传保留
  [k: string]: unknown;
}

interface ModelsConfig {
  providers: Record<string, ProviderEntry>;
}

interface Props {
  onClose: () => void;
  onChanged?: () => void;
}

const API_TYPES: ApiType[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

function emptyProvider(): ProviderEntry {
  return { baseUrl: "", api: "openai-completions", apiKey: "", models: [] };
}

function emptyModel(): ModelEntry {
  return {
    id: "",
    name: "",
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
  };
}

interface TestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
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
            const isOpen = expanded[provKey] ?? false;
            const models = prov.models ?? [];
            return (
              <div
                key={provKey}
                className="rounded text-xs"
                style={{
                  background: "var(--bg-panel-2)",
                  border: "1px solid var(--border-soft)",
                }}
              >
                <div
                  className="flex items-center gap-2 px-2 py-1.5 cursor-pointer"
                  onClick={() =>
                    setExpanded((x) => ({ ...x, [provKey]: !isOpen }))
                  }
                >
                  <span className="w-3 text-center">{isOpen ? "▾" : "▸"}</span>
                  <span className="font-medium flex-1 truncate">{provKey}</span>
                  <span
                    className="text-[10px]"
                    style={{ color: "var(--fg-faint)" }}
                  >
                    {models.length} model{models.length === 1 ? "" : "s"}
                    {prov.api && ` · ${prov.api}`}
                  </span>
                  <ConfirmButton
                    stopPropagation
                    onConfirm={() => removeProvider(provKey)}
                    className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80"
                    style={{
                      borderColor: "var(--border)",
                      color: "#fca5a5",
                    }}
                    title={`删除 provider "${provKey}"`}
                  >
                    ✕
                  </ConfirmButton>
                </div>

                {isOpen && (
                  <div
                    className="px-2 pb-2 space-y-2 border-t"
                    style={{ borderColor: "var(--border-soft)" }}
                  >
                    {/* provider 字段 */}
                    <div className="grid grid-cols-2 gap-1 pt-2">
                      <LabeledInput
                        label="baseUrl"
                        value={prov.baseUrl ?? ""}
                        onChange={(v) =>
                          updateProvider(provKey, { baseUrl: v })
                        }
                        placeholder="https://api.example.com/v1"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--fg-faint)" }}
                        >
                          api
                        </span>
                        <select
                          value={prov.api ?? ""}
                          onChange={(e) =>
                            updateProvider(provKey, {
                              api: (e.target.value || undefined) as
                                | ApiType
                                | undefined,
                            })
                          }
                          className="rounded px-2 py-1 text-xs border outline-none"
                          style={{
                            background: "var(--bg-panel)",
                            borderColor: "var(--border)",
                            color: "var(--fg)",
                          }}
                        >
                          <option value="">(use model.api / default)</option>
                          {API_TYPES.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </div>
                      <LabeledInput
                        label="apiKey (写到 models.json 而非 auth.json)"
                        value={prov.apiKey ?? ""}
                        onChange={(v) => updateProvider(provKey, { apiKey: v })}
                        placeholder="留空则 fallback 到 auth.json / env"
                        password
                      />
                      <LabeledInput
                        label="authHeader (可选, e.g. x-api-key)"
                        value={prov.authHeader ?? ""}
                        onChange={(v) =>
                          updateProvider(provKey, { authHeader: v })
                        }
                        placeholder="(default: Authorization)"
                      />
                    </div>

                    {/* models 列表 */}
                    <div className="space-y-1">
                      {models.map((m) => {
                        const tk = `${provKey}|${m.id}`;
                        const t = testResult[tk];
                        const isT = testing[tk];
                        return (
                          <div
                            key={m.id}
                            className="rounded px-2 py-1.5"
                            style={{
                              background: "var(--bg-panel)",
                              border: "1px solid var(--border-soft)",
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono flex-1 truncate">
                                {m.id}
                              </span>
                              <button
                                type="button"
                                onClick={() => void runTest(provKey, m)}
                                disabled={isT}
                                className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
                                style={{ borderColor: "var(--border)" }}
                                title="Test model connection"
                              >
                                {isT ? "Testing…" : "Test"}
                              </button>
                              <button
                                type="button"
                                onClick={() => removeModel(provKey, m.id)}
                                className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80"
                                style={{
                                  borderColor: "var(--border)",
                                  color: "#fca5a5",
                                }}
                              >
                                ✕
                              </button>
                            </div>
                            <div className="grid grid-cols-3 gap-1 mt-1">
                              <LabeledInput
                                label="name"
                                value={m.name ?? ""}
                                onChange={(v) =>
                                  updateModel(provKey, m.id, { name: v })
                                }
                              />
                              <LabeledNumber
                                label="contextWindow"
                                value={m.contextWindow}
                                onChange={(v) =>
                                  updateModel(provKey, m.id, {
                                    contextWindow: v,
                                  })
                                }
                              />
                              <LabeledNumber
                                label="maxTokens"
                                value={m.maxTokens}
                                onChange={(v) =>
                                  updateModel(provKey, m.id, { maxTokens: v })
                                }
                              />
                              <LabeledNumber
                                label="cost.input ($/M)"
                                value={m.cost?.input}
                                step={0.01}
                                onChange={(v) =>
                                  updateModel(provKey, m.id, {
                                    cost: { ...m.cost, input: v },
                                  })
                                }
                              />
                              <LabeledNumber
                                label="cost.output ($/M)"
                                value={m.cost?.output}
                                step={0.01}
                                onChange={(v) =>
                                  updateModel(provKey, m.id, {
                                    cost: { ...m.cost, output: v },
                                  })
                                }
                              />
                              <label className="flex items-center gap-1 text-[10px] cursor-pointer mt-3">
                                <input
                                  type="checkbox"
                                  checked={!!m.reasoning}
                                  onChange={(e) =>
                                    updateModel(provKey, m.id, {
                                      reasoning: e.target.checked,
                                    })
                                  }
                                  className="accent-blue-600"
                                />
                                reasoning / thinking
                              </label>
                            </div>
                            {t && (
                              <div
                                className="mt-1 text-[10px]"
                                style={{
                                  color: t.ok ? "#86efac" : "#fca5a5",
                                }}
                              >
                                {t.ok
                                  ? `✓ OK${
                                      t.latencyMs ? ` · ${t.latencyMs}ms` : ""
                                    }${t.status ? ` · ${t.status}` : ""}`
                                  : `✗ ${t.error ?? "failed"}${
                                      t.status ? ` · ${t.status}` : ""
                                    }`}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {addingModelIn === provKey ? (
                        <div
                          className="rounded px-2 py-1.5"
                          style={{
                            background: "var(--bg-panel)",
                            border: "1px dashed var(--border)",
                          }}
                        >
                          <div className="grid grid-cols-3 gap-1">
                            <LabeledInput
                              label="id *"
                              value={newModelDraft.id}
                              onChange={(v) =>
                                setNewModelDraft((d) => ({ ...d, id: v }))
                              }
                              placeholder="gpt-4o-mini"
                            />
                            <LabeledInput
                              label="name"
                              value={newModelDraft.name ?? ""}
                              onChange={(v) =>
                                setNewModelDraft((d) => ({ ...d, name: v }))
                              }
                            />
                            <LabeledNumber
                              label="contextWindow"
                              value={newModelDraft.contextWindow}
                              onChange={(v) =>
                                setNewModelDraft((d) => ({
                                  ...d,
                                  contextWindow: v,
                                }))
                              }
                            />
                            <LabeledNumber
                              label="maxTokens"
                              value={newModelDraft.maxTokens}
                              onChange={(v) =>
                                setNewModelDraft((d) => ({
                                  ...d,
                                  maxTokens: v,
                                }))
                              }
                            />
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            <button
                              type="button"
                              onClick={() => addModel(provKey)}
                              disabled={!newModelDraft.id.trim()}
                              className="px-2 py-1 text-xs rounded text-white disabled:opacity-50"
                              style={{ background: "var(--accent)" }}
                            >
                              Add
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAddingModelIn(null);
                                setNewModelDraft(emptyModel());
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
                          onClick={() => {
                            setAddingModelIn(provKey);
                            setNewModelDraft(emptyModel());
                          }}
                          className="w-full px-2 py-1 text-[10px] rounded border hover:opacity-80"
                          style={{
                            borderColor: "var(--border)",
                            color: "var(--fg-muted)",
                          }}
                        >
                          + Add model
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
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

// ===== 小组件 =====

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px]" style={{ color: "var(--fg-faint)" }}>
        {label}
      </span>
      <input
        type={password ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded px-2 py-1 text-xs border outline-none font-mono"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px]" style={{ color: "var(--fg-faint)" }}>
        {label}
      </span>
      <input
        type="number"
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const s = e.target.value;
          if (s === "") onChange(undefined);
          else {
            const n = Number(s);
            if (Number.isFinite(n)) onChange(n);
          }
        }}
        className="rounded px-2 py-1 text-xs border outline-none font-mono"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}
