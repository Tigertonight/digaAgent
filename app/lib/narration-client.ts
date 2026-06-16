"use client";

interface PendingTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: string;
  isError?: boolean;
}

interface NarrationRequest {
  id: string;
  question: string;
  locale: string;
  ruleText: string;
  tool: PendingTool;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

const MAX_BATCH = 16;
const FLUSH_DELAY_MS = 32;

let pending: NarrationRequest[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushController: AbortController | null = null;

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const chunk = pending.slice(0, MAX_BATCH);
  pending = pending.slice(MAX_BATCH);
  if (pending.length > 0) scheduleFlush();
  flushController?.abort();
  const controller = new AbortController();
  flushController = controller;
  try {
    const res = await fetch("/api/narration/tool/batch", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: chunk.map((req) => ({
          id: req.id,
          question: req.question,
          locale: req.locale,
          ruleText: req.ruleText,
          tool: req.tool,
        })),
      }),
    });
    if (!res.ok) throw new Error(`batch HTTP ${res.status}`);
    const json = (await res.json()) as {
      items?: Array<{ id?: string; narration?: string }>;
    };
    const byId = new Map<string, string>();
    for (const it of json.items ?? []) {
      if (typeof it.id === "string" && typeof it.narration === "string") {
        byId.set(it.id, it.narration);
      }
    }
    for (const req of chunk) {
      const text = byId.get(req.id) ?? "";
      req.resolve(text.trim());
    }
  } catch (err) {
    for (const req of chunk) req.reject(err);
  } finally {
    if (flushController === controller) flushController = null;
  }
}

interface RequestOptions {
  id: string;
  question: string;
  locale: string;
  ruleText: string;
  tool: PendingTool;
  signal?: AbortSignal;
}

export function requestToolNarration(opts: RequestOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const entry: NarrationRequest = {
      id: opts.id,
      question: opts.question,
      locale: opts.locale,
      ruleText: opts.ruleText,
      tool: opts.tool,
      resolve,
      reject,
    };
    pending.push(entry);
    if (opts.signal) {
      const onAbort = () => {
        pending = pending.filter((p) => p !== entry);
        reject(new DOMException("aborted", "AbortError"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    scheduleFlush();
  });
}
