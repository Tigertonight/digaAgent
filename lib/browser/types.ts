export type BrowserRuntimeStatus =
  | "idle"
  | "launching"
  | "ready"
  | "busy"
  | "error"
  | "closed";

export interface BrowserActionLog {
  id: string;
  action: string;
  label: string;
  status: "running" | "done" | "error";
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface BrowserPointerState {
  x: number;
  y: number;
  action: string;
  label: string;
  updatedAt: number;
}

export interface BrowserStepSnapshot {
  id: string;
  action: string;
  label: string;
  status: "done" | "error";
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  pointer: BrowserPointerState | null;
  createdAt: number;
  error?: string;
}

export interface BrowserSnapshot {
  status: BrowserRuntimeStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  updatedAt: number | null;
  error: string | null;
  pointer: BrowserPointerState | null;
  logs: BrowserActionLog[];
  steps: BrowserStepSnapshot[];
}

export interface BrowserStateEvent {
  type: "browser_state";
  snapshot: BrowserSnapshot;
}

export interface BrowserExtractResult {
  url: string | null;
  title: string | null;
  text: string;
  links: Array<{ text: string; href: string }>;
  inputs: Array<{ label: string; type: string; name: string; placeholder: string }>;
}

export interface BrowserVerifyResult {
  passed: boolean;
  expectation: string;
  evidence: string;
  url: string | null;
  title: string | null;
}

export type BrowserSiteDecision = "local" | "allowed" | "blocked" | "unknown";

export interface BrowserSitePolicy {
  allowedOrigins: string[];
  blockedOrigins: string[];
}

export interface BrowserSiteCheck {
  origin: string;
  decision: BrowserSiteDecision;
  policy: BrowserSitePolicy;
}

export const EMPTY_BROWSER_SNAPSHOT: BrowserSnapshot = {
  status: "idle",
  url: null,
  title: null,
  screenshotDataUrl: null,
  updatedAt: null,
  error: null,
  pointer: null,
  logs: [],
  steps: [],
};
