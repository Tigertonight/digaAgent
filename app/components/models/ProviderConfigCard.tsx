"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ConfirmButton } from "../ConfirmButton";
import { LabeledInput, LabeledNumber } from "./FormFields";
import { ModelConfigRow } from "./ModelConfigRow";
import {
  API_TYPES,
  emptyModel,
  type ApiType,
  type ModelEntry,
  type ProviderEntry,
  type TestResult,
} from "./types";

interface ProviderConfigCardProps {
  providerKey: string;
  provider: ProviderEntry;
  isOpen: boolean;
  addingModel: boolean;
  newModelDraft: ModelEntry;
  testing: Record<string, boolean>;
  testResult: Record<string, TestResult>;
  onToggle: (providerKey: string) => void;
  onRemoveProvider: (providerKey: string) => void;
  onUpdateProvider: (
    providerKey: string,
    patch: Partial<ProviderEntry>
  ) => void;
  onRunTest: (providerKey: string, model: ModelEntry) => void;
  onRemoveModel: (providerKey: string, modelId: string) => void;
  onUpdateModel: (
    providerKey: string,
    modelId: string,
    patch: Partial<ModelEntry>
  ) => void;
  onAddModel: (providerKey: string) => void;
  onStartAddModel: (providerKey: string) => void;
  onCancelAddModel: () => void;
  setNewModelDraft: Dispatch<SetStateAction<ModelEntry>>;
}

export function ProviderConfigCard({
  providerKey: provKey,
  provider: prov,
  isOpen,
  addingModel,
  newModelDraft,
  testing,
  testResult,
  onToggle,
  onRemoveProvider,
  onUpdateProvider,
  onRunTest,
  onRemoveModel,
  onUpdateModel,
  onAddModel,
  onStartAddModel,
  onCancelAddModel,
  setNewModelDraft,
}: ProviderConfigCardProps) {
  const models = prov.models ?? [];
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div
      className="rounded text-xs"
      style={{
        background: "var(--bg-panel-2)",
        border: "1px solid var(--border-soft)",
      }}
    >
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer"
        onClick={() => onToggle(provKey)}
      >
        <span className="w-3 text-center">{isOpen ? "▾" : "▸"}</span>
        <span className="font-medium flex-1 truncate">{provKey}</span>
        <span className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
          {models.length} 个模型
          {prov.api && ` · ${prov.api}`}
        </span>
        <ConfirmButton
          stopPropagation
          onConfirm={() => onRemoveProvider(provKey)}
          className="rounded-token-sm border px-1.5 py-0.5 text-token-xs hover:opacity-80"
          style={{
            borderColor: "var(--border)",
            color: "var(--color-danger)",
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
          <div className="grid grid-cols-1 gap-1 pt-2 sm:grid-cols-2">
            <div
              className="rounded border px-2 py-1.5 leading-5 sm:col-span-2"
              style={{
                borderColor: "var(--border-soft)",
                background: "var(--bg-panel)",
                color: "var(--fg-faint)",
              }}
            >
              <span className="font-medium" style={{ color: "var(--fg)" }}>
                最少需要 3 项：
              </span>{" "}
              接口地址、API Key / Token、模型 ID。若本机已有账号密钥，也可以把 API Key 留空，
              系统会尝试读取 <code>~/.pi/auth.json</code> 或环境变量。
            </div>
            <LabeledInput
              label="接口地址"
              value={prov.baseUrl ?? ""}
              onChange={(v) => onUpdateProvider(provKey, { baseUrl: v })}
              placeholder="https://api.example.com/v1"
            />
            <div className="flex flex-col gap-0.5">
              <span
                className="text-token-xs"
                style={{ color: "var(--fg-faint)" }}
              >
                接口协议
              </span>
              <select
                value={prov.api ?? ""}
                onChange={(e) =>
                  onUpdateProvider(provKey, {
                    api: (e.target.value || undefined) as ApiType | undefined,
                  })
                }
                className="rounded px-2 py-1 text-xs border outline-none"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border)",
                  color: "var(--fg)",
                }}
              >
                <option value="">使用模型设置或默认值</option>
                {API_TYPES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <LabeledInput
              label="API Key / Token"
              value={prov.apiKey ?? ""}
              onChange={(v) => onUpdateProvider(provKey, { apiKey: v })}
              placeholder="留空则使用账号密钥或环境变量"
              password
            />
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="w-full rounded border px-2 py-1 text-left text-xs hover:bg-[color:var(--bg-hover)]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--fg-muted)",
                }}
              >
                {showAdvanced ? "收起高级设置" : "高级设置"}
              </button>
            </div>
            {showAdvanced && (
              <label
                className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--fg-muted)",
                }}
              >
                <input
                  type="checkbox"
                  checked={!!prov.authHeader}
                  onChange={(e) =>
                    onUpdateProvider(provKey, {
                      authHeader: e.target.checked || undefined,
                    })
                  }
                  className="accent-blue-600"
                />
                <span>
                  使用 <code>Authorization: Bearer &lt;token&gt;</code>
                </span>
              </label>
            )}
          </div>

          <div className="space-y-1">
            {models.map((m) => {
              const tk = `${provKey}|${m.id}`;
              return (
                <ModelConfigRow
                  key={m.id}
                  providerKey={provKey}
                  model={m}
                  testing={!!testing[tk]}
                  testResult={testResult[tk]}
                  onRunTest={onRunTest}
                  onRemove={onRemoveModel}
                  onUpdate={onUpdateModel}
                />
              );
            })}

            {addingModel ? (
              <div
                className="rounded px-2 py-1.5"
                style={{
                  background: "var(--bg-panel)",
                  border: "1px dashed var(--border)",
                }}
              >
                <div className="grid grid-cols-3 gap-1">
                  <LabeledInput
                    label="模型 ID *"
                    value={newModelDraft.id}
                    onChange={(v) =>
                      setNewModelDraft((d) => ({ ...d, id: v }))
                    }
                    placeholder="gpt-4o-mini"
                  />
                  <LabeledInput
                    label="显示名称"
                    value={newModelDraft.name ?? ""}
                    onChange={(v) =>
                      setNewModelDraft((d) => ({ ...d, name: v }))
                    }
                  />
                  <LabeledNumber
                    label="上下文长度"
                    value={newModelDraft.contextWindow}
                    onChange={(v) =>
                      setNewModelDraft((d) => ({
                        ...d,
                        contextWindow: v,
                      }))
                    }
                  />
                  <LabeledNumber
                    label="最大输出长度"
                    value={newModelDraft.maxTokens}
                    onChange={(v) =>
                      setNewModelDraft((d) => ({ ...d, maxTokens: v }))
                    }
                  />
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <button
                    type="button"
                    onClick={() => onAddModel(provKey)}
                    disabled={!newModelDraft.id.trim()}
                    className="rounded px-2 py-1 text-xs disabled:opacity-50"
                    style={{ background: "var(--accent)", color: "var(--color-bg)" }}
                  >
                    添加
                  </button>
                  <button
                    type="button"
                    onClick={onCancelAddModel}
                    className="px-2 py-1 text-xs rounded border hover:opacity-80"
                    style={{ borderColor: "var(--border)" }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onStartAddModel(provKey);
                  setNewModelDraft(emptyModel());
                }}
                className="w-full rounded-token-sm border px-2 py-1 text-token-xs hover:opacity-80"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--fg-muted)",
                }}
              >
                + 添加模型
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
