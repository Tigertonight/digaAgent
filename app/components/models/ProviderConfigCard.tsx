"use client";

import type { Dispatch, SetStateAction } from "react";
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
        <span className="text-[10px]" style={{ color: "var(--fg-faint)" }}>
          {models.length} model{models.length === 1 ? "" : "s"}
          {prov.api && ` · ${prov.api}`}
        </span>
        <ConfirmButton
          stopPropagation
          onConfirm={() => onRemoveProvider(provKey)}
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
          <div className="grid grid-cols-2 gap-1 pt-2">
            <LabeledInput
              label="baseUrl"
              value={prov.baseUrl ?? ""}
              onChange={(v) => onUpdateProvider(provKey, { baseUrl: v })}
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
              onChange={(v) => onUpdateProvider(provKey, { apiKey: v })}
              placeholder="留空则 fallback 到 auth.json / env"
              password
            />
            <LabeledInput
              label="authHeader (可选, e.g. x-api-key)"
              value={prov.authHeader ?? ""}
              onChange={(v) => onUpdateProvider(provKey, { authHeader: v })}
              placeholder="(default: Authorization)"
            />
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
                      setNewModelDraft((d) => ({ ...d, maxTokens: v }))
                    }
                  />
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <button
                    type="button"
                    onClick={() => onAddModel(provKey)}
                    disabled={!newModelDraft.id.trim()}
                    className="px-2 py-1 text-xs rounded text-white disabled:opacity-50"
                    style={{ background: "var(--accent)" }}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={onCancelAddModel}
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
                  onStartAddModel(provKey);
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
}
