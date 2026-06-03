"use client";

import {
  KeyRound,
  LogIn,
  ServerCog,
  Sparkles,
  X,
} from "lucide-react";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderSetupWizardProps {
  onClose: () => void;
  onOpenAuth: (provider?: string) => void;
  onOpenModelsConfig: () => void;
}

const cardBase =
  "group flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-[color:var(--bg-hover)]";

export function ProviderSetupWizard({
  onClose,
  onOpenAuth,
  onOpenModelsConfig,
}: ProviderSetupWizardProps) {
  const openAuth = (provider?: string) => {
    onClose();
    onOpenAuth(provider);
  };
  const openModels = () => {
    onClose();
    onOpenModelsConfig();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <section
        className="flex max-h-[86vh] w-full max-w-2xl flex-col rounded-md border"
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
          <div className="flex items-center gap-2">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
              style={{
                borderColor: "var(--border)",
                background: "var(--bg-panel-2)",
              }}
            >
              <Sparkles size={16} />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Provider setup</h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Choose how this agent should access models.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded border hover:bg-[color:var(--bg-hover)]"
            style={{ borderColor: "var(--border)" }}
            aria-label="Close provider setup"
          >
            <X size={14} />
          </button>
        </header>

        <div className="grid gap-3 overflow-auto p-4 sm:grid-cols-2">
          <button
            type="button"
            className={cardBase}
            style={{ borderColor: "var(--border)" }}
            onClick={() => openAuth("openai")}
          >
            <ProviderIcon provider="openai" size={24} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">OpenAI API Key</span>
              <span
                className="mt-1 block text-xs leading-5"
                style={{ color: "var(--text-muted)" }}
              >
                Use the standard OpenAI API with your platform key.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={cardBase}
            style={{ borderColor: "var(--border)" }}
            onClick={() => openAuth("openai-codex")}
          >
            <LogIn size={24} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                ChatGPT/Codex OAuth
              </span>
              <span
                className="mt-1 block text-xs leading-5"
                style={{ color: "var(--text-muted)" }}
              >
                Login with a ChatGPT Plus/Pro or Codex subscription account.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={cardBase}
            style={{ borderColor: "var(--border)" }}
            onClick={() => openAuth("anthropic")}
          >
            <ProviderIcon provider="anthropic" size={24} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Anthropic / Claude
              </span>
              <span
                className="mt-1 block text-xs leading-5"
                style={{ color: "var(--text-muted)" }}
              >
                Add a Claude API key or use SDK-supported OAuth.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={cardBase}
            style={{ borderColor: "var(--border)" }}
            onClick={openModels}
          >
            <ServerCog size={24} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Custom endpoint</span>
              <span
                className="mt-1 block text-xs leading-5"
                style={{ color: "var(--text-muted)" }}
              >
                Configure OpenAI-compatible gateways, base URLs, and models.
              </span>
            </span>
          </button>
        </div>

        <footer
          className="flex items-start gap-2 border-t px-4 py-3 text-xs"
          style={{
            borderColor: "var(--border-soft)",
            color: "var(--text-muted)",
          }}
        >
          <KeyRound size={14} className="mt-0.5 shrink-0" />
          <span>
            API keys and OAuth tokens are stored locally in{" "}
            <code>~/.pi/auth.json</code>. Custom providers live in{" "}
            <code>~/.pi/agent/models.json</code>.
          </span>
        </footer>
      </section>
    </div>
  );
}
