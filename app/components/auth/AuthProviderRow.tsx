"use client";

import { Check } from "lucide-react";
import type { AuthProviderStatus } from "@/app/hooks/useProviderStatus";
import { ProviderIcon } from "../ProviderIcon";
import { ConfirmButton } from "../ConfirmButton";

export interface AuthTestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  model?: { provider: string; id: string; name?: string };
}

interface AuthProviderRowProps {
  provider: AuthProviderStatus;
  isEditing: boolean;
  isBusy: boolean;
  isTesting: boolean;
  result?: AuthTestResult;
  keyInput: string;
  onStartEdit: (provider: string) => void;
  onTestAuth: (provider: string) => void;
  onRemoveKey: (provider: string) => void;
  onOpenOAuth: (provider: string) => void;
  onKeyInputChange: (value: string) => void;
  onSaveKey: (provider: string) => void;
  onCancelEdit: () => void;
}

export function AuthProviderRow({
  provider: p,
  isEditing,
  isBusy,
  isTesting,
  result,
  keyInput,
  onStartEdit,
  onTestAuth,
  onRemoveKey,
  onOpenOAuth,
  onKeyInputChange,
  onSaveKey,
  onCancelEdit,
}: AuthProviderRowProps) {
  return (
    <div
      className="rounded px-2 py-1.5 text-xs"
      style={{
        background: "var(--bg-panel-2)",
        border: "1px solid var(--border-soft)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="relative inline-flex items-center justify-center"
          title={p.hasAuth ? `auth via ${p.status.source ?? "?"}` : "no auth"}
        >
          <ProviderIcon provider={p.provider} size={18} />
          {p.hasAuth && (
            <Check
              size={10}
              className="absolute -bottom-1 -right-1 rounded-full"
              style={{
                background: "var(--accent)",
                color: "white",
                padding: 1,
              }}
            />
          )}
        </span>
        <span className="flex-1 min-w-0">
          <div className="font-medium truncate">{p.displayName}</div>
          <div
            className="text-[10px] truncate"
            style={{ color: "var(--fg-faint)" }}
          >
            {p.provider}
            {p.status.source && ` · source: ${p.status.source}`}
            {p.status.label && ` (${p.status.label})`}
            {p.credentialType && ` · stored: ${p.credentialType}`}
            {p.supportsOAuth && " · oauth available"}
          </div>
          {p.provider === "openai-codex" && (
            <div
              className="mt-0.5 text-[10px]"
              style={{ color: "var(--fg-faint)" }}
            >
              ChatGPT/Codex OAuth uses your ChatGPT subscription session, not an
              OpenAI Platform API key.
            </div>
          )}
          {p.provider === "openai" && (
            <div
              className="mt-0.5 text-[10px]"
              style={{ color: "var(--fg-faint)" }}
            >
              Standard OpenAI API provider. Use an OpenAI Platform API key here.
            </div>
          )}
        </span>
        {!isEditing && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onStartEdit(p.provider)}
              disabled={isBusy}
              className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
              title={
                p.credentialType === "api_key" ? "替换 API key" : "设置 API key"
              }
            >
              {p.credentialType === "api_key" ? "Replace" : "Set"}
            </button>
            {(p.credentialType === "api_key" ||
              p.credentialType === "oauth") && (
              <button
                type="button"
                onClick={() => onTestAuth(p.provider)}
                disabled={isBusy || isTesting}
                className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
                style={{ borderColor: "var(--border)" }}
                title={`验证 ${p.provider} 凭证是否可调用模型`}
              >
                {isTesting ? "…" : "Test"}
              </button>
            )}
            {(p.credentialType === "api_key" ||
              p.credentialType === "oauth") && (
              <ConfirmButton
                onConfirm={() => onRemoveKey(p.provider)}
                disabled={isBusy}
                className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
                style={{
                  borderColor: "var(--border)",
                  color: "#fca5a5",
                }}
                title={`删除 ${p.provider} 的凭证`}
              >
                ✕
              </ConfirmButton>
            )}
          </div>
        )}
      </div>
      {result && (
        <div
          className="mt-2 rounded border px-2 py-1 text-[10px]"
          style={{
            borderColor: result.ok
              ? "rgba(34,197,94,0.45)"
              : "rgba(248,113,113,0.45)",
            background: result.ok
              ? "rgba(34,197,94,0.10)"
              : "rgba(248,113,113,0.10)",
            color: result.ok ? "#86efac" : "#fca5a5",
          }}
        >
          {result.ok
            ? `Test passed${
                result.model?.id ? ` · ${result.model.id}` : ""
              }${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`
            : `Test failed: ${result.error ?? "unknown error"}`}
        </div>
      )}
      {p.supportsOAuth && !isEditing && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenOAuth(p.provider)}
            disabled={isBusy}
            className="px-2 py-1 text-[11px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
            title={
              p.credentialType === "oauth"
                ? "Re-login to refresh tokens"
                : "Login via OAuth in browser"
            }
          >
            🔐 {p.credentialType === "oauth" ? "Re-login" : "Login"}
          </button>
          <span className="text-[10px]" style={{ color: "var(--fg-faint)" }}>
            {p.credentialType === "oauth"
              ? "Already connected. You can re-login or disconnect."
              : "OAuth"}
          </span>
        </div>
      )}
      {isEditing && (
        <div className="flex items-center gap-1 mt-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => onKeyInputChange(e.target.value)}
            placeholder="API key"
            autoFocus
            disabled={isBusy}
            className="flex-1 rounded px-2 py-1 text-xs border outline-none font-mono"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border)",
              color: "var(--fg)",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveKey(p.provider);
              if (e.key === "Escape") onCancelEdit();
            }}
          />
          <button
            type="button"
            onClick={() => onSaveKey(p.provider)}
            disabled={isBusy || !keyInput.trim()}
            className="px-2 py-1 text-xs rounded text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {isBusy ? "…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            disabled={isBusy}
            className="px-2 py-1 text-xs rounded border hover:opacity-80 disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
