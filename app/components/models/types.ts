export type ApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelEntry {
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

export interface ProviderEntry {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelEntry[];
  [k: string]: unknown;
}

export interface ModelsConfig {
  providers: Record<string, ProviderEntry>;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
}

export const API_TYPES: ApiType[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

export function emptyProvider(): ProviderEntry {
  return { baseUrl: "", api: "openai-completions", apiKey: "", models: [] };
}

export function emptyModel(): ModelEntry {
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
