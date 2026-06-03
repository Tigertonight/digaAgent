"use client";

import { LabeledInput, LabeledNumber } from "./FormFields";
import type { ModelEntry, TestResult } from "./types";

interface ModelConfigRowProps {
  providerKey: string;
  model: ModelEntry;
  testing: boolean;
  testResult?: TestResult;
  onRunTest: (providerKey: string, model: ModelEntry) => void;
  onRemove: (providerKey: string, modelId: string) => void;
  onUpdate: (
    providerKey: string,
    modelId: string,
    patch: Partial<ModelEntry>
  ) => void;
}

export function ModelConfigRow({
  providerKey,
  model: m,
  testing,
  testResult: t,
  onRunTest,
  onRemove,
  onUpdate,
}: ModelConfigRowProps) {
  return (
    <div
      className="rounded px-2 py-1.5"
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-soft)",
      }}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono flex-1 truncate">{m.id}</span>
        <button
          type="button"
          onClick={() => onRunTest(providerKey, m)}
          disabled={testing}
          className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
          style={{ borderColor: "var(--border)" }}
          title="Test model connection"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          onClick={() => onRemove(providerKey, m.id)}
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
          onChange={(v) => onUpdate(providerKey, m.id, { name: v })}
        />
        <LabeledNumber
          label="contextWindow"
          value={m.contextWindow}
          onChange={(v) => onUpdate(providerKey, m.id, { contextWindow: v })}
        />
        <LabeledNumber
          label="maxTokens"
          value={m.maxTokens}
          onChange={(v) => onUpdate(providerKey, m.id, { maxTokens: v })}
        />
        <LabeledNumber
          label="cost.input ($/M)"
          value={m.cost?.input}
          step={0.01}
          onChange={(v) =>
            onUpdate(providerKey, m.id, {
              cost: { ...m.cost, input: v },
            })
          }
        />
        <LabeledNumber
          label="cost.output ($/M)"
          value={m.cost?.output}
          step={0.01}
          onChange={(v) =>
            onUpdate(providerKey, m.id, {
              cost: { ...m.cost, output: v },
            })
          }
        />
        <label className="flex items-center gap-1 text-[10px] cursor-pointer mt-3">
          <input
            type="checkbox"
            checked={!!m.reasoning}
            onChange={(e) =>
              onUpdate(providerKey, m.id, {
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
          style={{ color: t.ok ? "#86efac" : "#fca5a5" }}
        >
          {t.ok
            ? `✓ OK${t.latencyMs ? ` · ${t.latencyMs}ms` : ""}${
                t.status ? ` · ${t.status}` : ""
              }`
            : `✗ ${t.error ?? "failed"}${t.status ? ` · ${t.status}` : ""}`}
        </div>
      )}
    </div>
  );
}
