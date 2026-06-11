"use client";

import { Check } from "lucide-react";
import type { AuthProviderStatus } from "@/app/hooks/useProviderStatus";
import { ProviderIcon } from "../ProviderIcon";
import { ConfirmButton } from "../ConfirmButton";
import { Button, FieldInput } from "../DesignPrimitives";

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
    <div className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-selected)] px-2 py-1.5 text-token-sm">
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
                color: "var(--color-bg)",
                padding: 1,
              }}
            />
          )}
        </span>
        <span className="flex-1 min-w-0">
          <div className="font-medium truncate">{p.displayName}</div>
          <div
            className="truncate text-token-xs"
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
              className="mt-0.5 text-token-xs"
              style={{ color: "var(--fg-faint)" }}
            >
              ChatGPT/Codex OAuth uses your ChatGPT subscription session, not an
              OpenAI Platform API key.
            </div>
          )}
          {p.provider === "openai" && (
            <div
              className="mt-0.5 text-token-xs"
              style={{ color: "var(--fg-faint)" }}
            >
              Standard OpenAI API provider. Use an OpenAI Platform API key here.
            </div>
          )}
        </span>
        {!isEditing && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              onClick={() => onStartEdit(p.provider)}
              disabled={isBusy}
              size="xs"
              variant="outline"
              title={
                p.credentialType === "api_key" ? "替换 API key" : "设置 API key"
              }
            >
              {p.credentialType === "api_key" ? "Replace" : "Set"}
            </Button>
            {(p.credentialType === "api_key" ||
              p.credentialType === "oauth") && (
              <Button
                onClick={() => onTestAuth(p.provider)}
                disabled={isBusy || isTesting}
                size="xs"
                variant="outline"
                title={`验证 ${p.provider} 凭证是否可调用模型`}
              >
                {isTesting ? "…" : "Test"}
              </Button>
            )}
            {(p.credentialType === "api_key" ||
              p.credentialType === "oauth") && (
              <ConfirmButton
                onConfirm={() => onRemoveKey(p.provider)}
                disabled={isBusy}
                className="rounded-token-sm border border-[color:var(--color-danger)] px-1.5 py-0.5 text-token-xs text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-bg)] disabled:opacity-50"
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
          className="mt-2 rounded-token-sm border px-2 py-1 text-token-xs"
          style={{
            borderColor: result.ok
              ? "var(--color-success)"
              : "var(--color-danger)",
            background: result.ok
              ? "var(--color-success-bg)"
              : "var(--color-danger-bg)",
            color: result.ok ? "var(--color-success)" : "var(--color-danger)",
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
          <Button
            onClick={() => onOpenOAuth(p.provider)}
            disabled={isBusy}
            size="sm"
            tone="accent"
            variant="solid"
            title={
              p.credentialType === "oauth"
                ? "Re-login to refresh tokens"
                : "Login via OAuth in browser"
            }
          >
            🔐 {p.credentialType === "oauth" ? "Re-login" : "Login"}
          </Button>
          <span className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
            {p.credentialType === "oauth"
              ? "Already connected. You can re-login or disconnect."
              : "OAuth"}
          </span>
        </div>
      )}
      {isEditing && (
        <div className="flex items-center gap-1 mt-2">
          <FieldInput
            type="password"
            value={keyInput}
            onChange={(e) => onKeyInputChange(e.target.value)}
            placeholder="API key"
            autoFocus
            disabled={isBusy}
            className="flex-1 font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveKey(p.provider);
              if (e.key === "Escape") onCancelEdit();
            }}
          />
          <Button
            onClick={() => onSaveKey(p.provider)}
            disabled={isBusy || !keyInput.trim()}
            size="sm"
            tone="accent"
            variant="solid"
          >
            {isBusy ? "…" : "Save"}
          </Button>
          <Button
            onClick={onCancelEdit}
            disabled={isBusy}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
