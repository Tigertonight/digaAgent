"use client";

import {
  CheckCircle2,
  Clipboard,
  KeyRound,
  ServerCog,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderStatus } from "@/app/hooks/useProviderStatus";

interface ProviderSetupWizardProps {
  onClose: () => void;
  onOpenAuth: (provider?: string) => void;
  onOpenModelsConfig: () => void;
}

const cardBase =
  "group flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-[color:var(--bg-hover)]";
const quarantineCommand = 'xattr -dr com.apple.quarantine "/Applications/Diga Agent.app"';
const appAttributesCommand = 'xattr -cr "/Applications/Diga Agent.app"';
const macInstallCommands = `${quarantineCommand}\n${appAttributesCommand}`;
const localCodingAssistantNpmInstallCommand =
  "# 请联系管理员获取公司内部 npm 源地址和包名\nnpm config set @company:registry https://npm.company.example\nnpm install -g @company/coding-assistant@latest\ncoding-assistant -version";
const localCodingAssistantScriptInstallCommand =
  '# 请联系管理员获取公司内部一键安装脚本\ncurl -fsSL "https://example.company/coding-assistant/install.sh" | bash\ncoding-assistant -version';
const localCodingAssistantLoginCommand = "coding-assistant login --force";

interface LocalCodingAssistantStatus {
  installed: boolean;
  version?: string;
  sessionPath: string;
  sessionExists: boolean;
  tokenPresent: boolean;
  error?: string;
}

export function ProviderSetupWizard({
  onClose,
  onOpenAuth,
  onOpenModelsConfig,
}: ProviderSetupWizardProps) {
  const { authProviders, authLoading } = useProviderStatus({
    autoLoadAuth: true,
  });
  const [showLocalCodingAssistant, setShowLocalCodingAssistant] = useState(false);
  const [localCodingAssistantStatus, setLocalCodingAssistantStatus] = useState<LocalCodingAssistantStatus | null>(
    null
  );
  const [localCodingAssistantLoading, setLocalCodingAssistantLoading] = useState(true);
  const detectedProviders = authProviders.filter((p) => p.hasAuth);
  const detectedResources = [
    ...detectedProviders.map((p) => ({
      key: p.provider,
      provider: p.provider,
      displayName: p.displayName,
      source: p.status.source,
    })),
    ...(localCodingAssistantStatus?.installed && localCodingAssistantStatus.tokenPresent
      ? [
          {
            key: "local-coding-assistant",
            provider: "local-coding-assistant",
            displayName: "自研 Coding 助手",
            source: "session",
          },
        ]
      : []),
  ].slice(0, 6);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/local-coding-assistant/status")
      .then((r) => r.json() as Promise<LocalCodingAssistantStatus>)
      .then((data) => {
        if (!cancelled) setLocalCodingAssistantStatus(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setLocalCodingAssistantStatus({
            installed: false,
            sessionPath: "",
            sessionExists: false,
            tokenPresent: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLocalCodingAssistantLoading(false);
      });
    return () => {
      cancelled = true;
      };
  }, []);

  const openAuth = (provider?: string) => {
    onClose();
    onOpenAuth(provider);
  };
  const openModels = () => {
    onClose();
    onOpenModelsConfig();
  };
  const copyQuarantineCommand = () => {
    void navigator.clipboard?.writeText(macInstallCommands);
  };
  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <section
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-md border"
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
              <h2 className="text-sm font-semibold">开始使用 Diga Agent</h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                先完成模型接入；有本机账号可直接复用，没有就按下面任选一种方式。
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

        <div className="overflow-auto p-4">
          <div
            className="mb-4 rounded-md border p-3 text-xs"
            style={{
              borderColor: "var(--color-warning)",
              background: "var(--color-warning-bg)",
              color: "var(--fg)",
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="font-medium">macOS 提示“已损坏”或“无法打开”</div>
                <div className="mt-0.5" style={{ color: "var(--text-muted)" }}>
                  当前 DMG 未做 Apple 开发者签名。拖到 Applications 后，在终端按顺序执行两条命令：
                </div>
              </div>
              <button
                type="button"
                onClick={copyQuarantineCommand}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded border px-2 hover:bg-[color:var(--bg-hover)]"
                style={{ borderColor: "var(--border)" }}
                title="复制两条终端命令"
              >
                <Clipboard size={13} />
                复制
              </button>
            </div>
            <code
              className="block overflow-x-auto rounded border px-2 py-1.5 font-mono"
              style={{
                borderColor: "var(--border-soft)",
                background: "var(--bg-panel)",
              }}
            >
              <span className="block text-[color:var(--text-muted)]"># 1. 先移除安装包 quarantine 标记</span>
              <span className="block">{quarantineCommand}</span>
              <span className="mt-1 block text-[color:var(--text-muted)]"># 2. 再清理 App 内部扩展属性，避免本地 agent 运行报错</span>
              <span className="block">{appAttributesCommand}</span>
            </code>
          </div>

          {detectedResources.length > 0 && (
            <div
              className="mb-4 rounded-md border p-3 text-xs"
              style={{
                borderColor: "var(--color-success)",
                background: "var(--color-success-bg)",
              }}
            >
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 size={14} />
                已检测到本机可用账号 / 资源
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detectedResources.map((p) => (
                  <span
                    key={p.key}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1"
                    style={{
                      borderColor: "var(--border-soft)",
                      background: "var(--bg-panel)",
                    }}
                  >
                    <ProviderIcon provider={p.provider} size={14} />
                    {p.displayName}
                    {p.source ? ` · ${p.source}` : ""}
                  </span>
                ))}
              </div>
              <p className="mt-2" style={{ color: "var(--text-muted)" }}>
                如果模型下拉框已经出现可用模型，可以关闭此窗口直接发送任务。
              </p>
            </div>
          )}

          <div className="mb-2 text-xs font-medium" style={{ color: "var(--fg)" }}>
            账号与模型 API 资源
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className={`${cardBase} sm:col-span-2`}
              style={{ borderColor: "var(--accent)" }}
              onClick={() => openAuth()}
            >
              <KeyRound size={24} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  账号授权 / Auth 管理
                </span>
                <span
                  className="mt-1 block text-xs leading-5"
                  style={{ color: "var(--text-muted)" }}
                >
                  打开原来的 Auth 面板，统一管理 API Key、OAuth 登录、验证和删除凭证。
                </span>
              </span>
            </button>

            <button
              type="button"
              className={cardBase}
              style={{ borderColor: "var(--border)" }}
              onClick={openModels}
            >
              <ProviderIcon provider="company-claude-3p" size={24} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  公司 Claude 3P 模型资源
                </span>
                <span
                  className="mt-1 block text-xs leading-5"
                  style={{ color: "var(--text-muted)" }}
                >
                  使用 Cowork 领取的 toB Claude Token，走公司统一模型服务和额度。
                </span>
              </span>
            </button>

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
                  只需要粘贴 OpenAI Platform API Key。适合最常见的 API 接入。
                </span>
              </span>
            </button>

            <button
              type="button"
              className={cardBase}
              style={{ borderColor: "var(--border)" }}
              onClick={() => openAuth("openai-codex")}
            >
              <ProviderIcon provider="openai-codex" size={24} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  ChatGPT / Codex 登录
                </span>
                <span
                  className="mt-1 block text-xs leading-5"
                  style={{ color: "var(--text-muted)" }}
                >
                  用浏览器授权已有 ChatGPT/Codex 订阅账号，不需要 OpenAI Platform Key。
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
                  粘贴 Anthropic Console API Key，使用 Claude 系列模型。
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
                <span className="block text-sm font-medium">本地 / 自定义端点</span>
                <span
                  className="mt-1 block text-xs leading-5"
                  style={{ color: "var(--text-muted)" }}
                >
                  接 OpenRouter、Ollama、LM Studio、公司网关，或任何 OpenAI 兼容接口。
                </span>
              </span>
            </button>
          </div>

          <div
            className="mb-2 mt-4 text-xs font-medium"
            style={{ color: "var(--fg)" }}
          >
            内部客户端资源
          </div>
          <div className="grid gap-3">
            <button
              type="button"
              className={cardBase}
              style={{ borderColor: "var(--border)" }}
              onClick={() => {
                const next = !showLocalCodingAssistant;
                if (next && !localCodingAssistantStatus) setLocalCodingAssistantLoading(true);
                setShowLocalCodingAssistant(next);
              }}
            >
              <Terminal size={24} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  自研 Coding 助手
                </span>
                <span
                  className="mt-1 block text-xs leading-5"
                  style={{ color: "var(--text-muted)" }}
                >
                  检测并配置公司内部 Claude Code 客户端。它是独立客户端资源，
                  不等同于 Claude 3P 模型 API。
                </span>
              </span>
            </button>
          </div>

          {showLocalCodingAssistant && (
            <div
              className="mt-3 rounded-md border p-3 text-xs"
              style={{
                borderColor: "var(--border-soft)",
                background: "var(--bg-panel-2)",
              }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">自研 Coding 助手 状态</div>
                  <p className="mt-1 leading-5" style={{ color: "var(--text-muted)" }}>
                    自研 Coding 助手 是完整的 Claude Code 客户端，使用公司统一模型服务和
                    Token 额度。当前已通过 CLI adapter 接入，安装并登录后可在“供应商”里选择。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLocalCodingAssistantStatus(null);
                    setLocalCodingAssistantLoading(true);
                    fetch("/api/local-coding-assistant/status")
                      .then((r) => r.json() as Promise<LocalCodingAssistantStatus>)
                      .then(setLocalCodingAssistantStatus)
                      .finally(() => setLocalCodingAssistantLoading(false));
                  }}
                  className="h-7 rounded border px-2 hover:bg-[color:var(--bg-hover)]"
                  style={{ borderColor: "var(--border)" }}
                >
                  {localCodingAssistantLoading ? "检测中…" : "重新检测"}
                </button>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                <StatusBox
                  label="客户端"
                  value={localCodingAssistantStatus?.installed ? "已安装" : "未检测到"}
                  ok={!!localCodingAssistantStatus?.installed}
                />
                <StatusBox
                  label="登录缓存"
                  value={localCodingAssistantStatus?.sessionExists ? "已存在" : "未找到"}
                  ok={!!localCodingAssistantStatus?.sessionExists}
                />
                <StatusBox
                  label="Access Token"
                  value={localCodingAssistantStatus?.tokenPresent ? "已就绪" : "未就绪"}
                  ok={!!localCodingAssistantStatus?.tokenPresent}
                />
                <StatusBox
                  label="供应商列表"
                  value={
                    localCodingAssistantStatus?.installed && localCodingAssistantStatus.tokenPresent
                      ? "已可选择"
                      : "未就绪"
                  }
                  ok={!!(localCodingAssistantStatus?.installed && localCodingAssistantStatus.tokenPresent)}
                />
              </div>

              <div
                className="mt-3 rounded border px-2 py-1.5 leading-5"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                }}
              >
                选择供应商
                <span className="font-medium" style={{ color: "var(--fg)" }}>
                  {" "}
                  自研 Coding 助手
                </span>
                后，Cowork 会调用本机自研 Coding 助手 CLI 执行任务并回传流式输出；Claude
                3P 模型 API 仍然是独立资源方。
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <CommandBlock
                  title="研发序列 npm 安装"
                  command={localCodingAssistantNpmInstallCommand}
                  onCopy={copyText}
                />
                <CommandBlock
                  title="非研发序列脚本安装"
                  command={localCodingAssistantScriptInstallCommand}
                  onCopy={copyText}
                />
                <CommandBlock
                  title="重新登录"
                  command={localCodingAssistantLoginCommand}
                  onCopy={copyText}
                />
                <div
                  className="rounded border p-2 leading-5"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text-muted)",
                  }}
                >
                  <div className="font-medium" style={{ color: "var(--fg)" }}>
                    在项目里直接使用
                  </div>
                  <code className="mt-1 block font-mono">
                    cd /path/to/project
                    <br />
                    coding-assistant
                  </code>
                </div>
              </div>
            </div>
          )}

          {authLoading && (
            <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
              正在检测本机账号配置…
            </p>
          )}
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
            API Key 和 OAuth token 只保存在本机 <code>~/.pi/auth.json</code>；
            自定义服务商和模型写入 <code>~/.pi/agent/models.json</code>。
          </span>
        </footer>
      </section>
    </div>
  );
}

function StatusBox({
  label,
  value,
  ok,
  tone = "check",
}: {
  label: string;
  value: string;
  ok?: boolean;
  tone?: "check" | "neutral";
}) {
  const success = tone === "check" && ok;
  return (
    <div
      className="rounded border px-2 py-1.5"
      style={{
        borderColor: success ? "var(--color-success)" : "var(--border)",
        background: success ? "var(--color-success-bg)" : "var(--bg-panel)",
      }}
    >
      <div className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
        {label}
      </div>
      <div className="mt-0.5 truncate font-medium">{value}</div>
    </div>
  );
}

function CommandBlock({
  title,
  command,
  onCopy,
}: {
  title: string;
  command: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div
      className="rounded border p-2"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <button
          type="button"
          onClick={() => onCopy(command)}
          className="h-6 rounded border px-2 hover:bg-[color:var(--bg-hover)]"
          style={{ borderColor: "var(--border)" }}
        >
          复制
        </button>
      </div>
      <code
        className="block max-h-24 overflow-auto whitespace-pre-wrap rounded px-2 py-1 font-mono leading-5"
        style={{
          background: "var(--bg-panel-2)",
          color: "var(--fg-muted)",
        }}
      >
        {command}
      </code>
    </div>
  );
}
