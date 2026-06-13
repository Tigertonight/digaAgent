"use client";

import {
  OpenAI,
  Anthropic,
  Claude,
  ClaudeCode,
  Codex,
  Bedrock,
  Google,
  Gemini,
  Minimax,
  Moonshot,
  DeepSeek,
  Qwen,
  Groq,
  Mistral,
  Ollama,
  Perplexity,
  XAI,
  Cohere,
  Doubao,
  Hunyuan,
  Wenxin,
  Spark,
  Yi,
  Zhipu,
  Github,
  Azure,
  AzureAI,
  Together,
  Fireworks,
  OpenRouter,
  Replicate,
  HuggingFace,
} from "@lobehub/icons";

function CompanyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      role="img"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 20V5.8c0-.9.7-1.6 1.6-1.6h6.8c.9 0 1.6.7 1.6 1.6V20"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 9h4.4c.9 0 1.6.7 1.6 1.6V20M2.8 20h18.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.2 8h3.6M7.2 11.5h3.6M7.2 15h3.6M16.7 13.2h1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 把 provider id（来自 SDK / models.json）映射到 @lobehub/icons 的 brand icon。
 * 找不到就返回 null，调用方应回退到首字母占位。
 */
const MAP: Record<string, React.ComponentType<{ size?: number }>> = {
  openai: OpenAI,
  "openai-codex": Codex,
  codex: Codex,
  "company-claude-3p": CompanyIcon,
  anthropic: Anthropic,
  claude: Claude,
  "claude-code": ClaudeCode,
  "local-coding-assistant": ClaudeCode,
  "amazon-bedrock": Bedrock,
  bedrock: Bedrock,
  google: Google,
  gemini: Gemini,
  "google-gemini": Gemini,
  minimax: Minimax,
  "minimax-cn": Minimax,
  moonshot: Moonshot,
  kimi: Moonshot,
  deepseek: DeepSeek,
  qwen: Qwen,
  "qwen-cn": Qwen,
  alibaba: Qwen,
  groq: Groq,
  mistral: Mistral,
  ollama: Ollama,
  perplexity: Perplexity,
  xai: XAI,
  grok: XAI,
  cohere: Cohere,
  doubao: Doubao,
  bytedance: Doubao,
  hunyuan: Hunyuan,
  tencent: Hunyuan,
  wenxin: Wenxin,
  baidu: Wenxin,
  spark: Spark,
  iflytek: Spark,
  yi: Yi,
  zeroone: Yi,
  zhipu: Zhipu,
  glm: Zhipu,
  "github-copilot": Github,
  github: Github,
  azure: Azure,
  "azure-ai": AzureAI,
  together: Together,
  fireworks: Fireworks,
  openrouter: OpenRouter,
  replicate: Replicate,
  huggingface: HuggingFace,
  hf: HuggingFace,
};

interface Props {
  provider: string;
  size?: number;
  className?: string;
}

export function ProviderIcon({ provider, size = 16, className }: Props) {
  const key = provider.toLowerCase();
  // 直接命中
  let Icon = MAP[key];
  if (!Icon) {
    // 模糊：把"包含某个 brand key 的 provider id"也认上
    for (const k of Object.keys(MAP)) {
      if (key.includes(k)) {
        Icon = MAP[k];
        break;
      }
    }
  }

  if (Icon) {
    return (
      <span className={className} aria-hidden="true">
        <Icon size={size} />
      </span>
    );
  }

  // 兜底：首字母占位
  const letter = (provider[0] || "?").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded border ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.6),
        borderColor: "var(--border)",
        background: "var(--bg-subtle)",
        color: "var(--text-muted)",
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  );
}
