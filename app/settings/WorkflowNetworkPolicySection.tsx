"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  WorkflowNetworkAuditEntry,
  WorkflowNetworkPolicy,
} from "@/lib/workflows/types";

function linesToList(value: string): string[] | undefined {
  const out = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function listToLines(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}

function appendUniqueLine(text: string, value: string): string {
  const lines = linesToList(text) ?? [];
  return lines.includes(value) ? lines.join("\n") : [...lines, value].join("\n");
}

function originForUrl(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function patternForUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname || "/"}*`;
  } catch {
    return null;
  }
}

export function WorkflowNetworkPolicySection() {
  const [open, setOpen] = useState(false);
  const [allowedOrigins, setAllowedOrigins] = useState("");
  const [deniedOrigins, setDeniedOrigins] = useState("");
  const [allowedUrlPatterns, setAllowedUrlPatterns] = useState("");
  const [deniedUrlPatterns, setDeniedUrlPatterns] = useState("");
  const [allowGet, setAllowGet] = useState(false);
  const [allowPost, setAllowPost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [audits, setAudits] = useState<WorkflowNetworkAuditEntry[]>([]);
  const [auditWorkflowId, setAuditWorkflowId] = useState("");
  const [auditOrigin, setAuditOrigin] = useState("");
  const [auditOutcome, setAuditOutcome] = useState<
    "" | WorkflowNetworkAuditEntry["outcome"]
  >("");
  const [auditSearch, setAuditSearch] = useState("");
  const [auditLimit, setAuditLimit] = useState(50);

  const applyPolicy = useCallback((policy: WorkflowNetworkPolicy) => {
    setAllowedOrigins(listToLines(policy.allowedOrigins));
    setDeniedOrigins(listToLines(policy.deniedOrigins));
    setAllowedUrlPatterns(listToLines(policy.allowedUrlPatterns));
    setDeniedUrlPatterns(listToLines(policy.deniedUrlPatterns));
    setAllowGet(policy.allowedMethods?.includes("GET") ?? false);
    setAllowPost(policy.allowedMethods?.includes("POST") ?? false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const params = new URLSearchParams({
        auditLimit: String(auditLimit),
      });
      if (auditWorkflowId.trim()) params.set("workflowId", auditWorkflowId.trim());
      if (auditOrigin.trim()) params.set("origin", auditOrigin.trim());
      if (auditOutcome) params.set("outcome", auditOutcome);
      if (auditSearch.trim()) params.set("q", auditSearch.trim());
      const r = await fetch(`/api/workflows/network-policy?${params}`);
      const d = (await r.json()) as {
        policy?: WorkflowNetworkPolicy;
        audits?: WorkflowNetworkAuditEntry[];
        error?: string;
      };
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      applyPolicy(d.policy ?? {});
      setAudits(Array.isArray(d.audits) ? d.audits : []);
    } catch (e) {
      setStatus(`加载失败: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [
    applyPolicy,
    auditLimit,
    auditOrigin,
    auditOutcome,
    auditSearch,
    auditWorkflowId,
  ]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const savePolicy = useCallback(async (policy: WorkflowNetworkPolicy) => {
    setSaving(true);
    setStatus(null);
    try {
      const r = await fetch("/api/workflows/network-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      const d = (await r.json()) as { policy?: WorkflowNetworkPolicy; error?: string };
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      applyPolicy(d.policy ?? {});
      setStatus("已保存");
    } catch (e) {
      setStatus(`保存失败: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [applyPolicy]);

  const save = useCallback(async () => {
    const allowedMethods = [
      allowGet ? "GET" : "",
      allowPost ? "POST" : "",
    ].filter(Boolean) as Array<"GET" | "POST">;
    const policy: WorkflowNetworkPolicy = {
      allowedOrigins: linesToList(allowedOrigins),
      deniedOrigins: linesToList(deniedOrigins),
      allowedUrlPatterns: linesToList(allowedUrlPatterns),
      deniedUrlPatterns: linesToList(deniedUrlPatterns),
      allowedMethods: allowedMethods.length > 0 ? allowedMethods : undefined,
    };
    await savePolicy(policy);
  }, [
    allowGet,
    allowPost,
    allowedOrigins,
    allowedUrlPatterns,
    deniedOrigins,
    deniedUrlPatterns,
    savePolicy,
  ]);

  const saveWithPatch = useCallback(
    async (patch: Partial<WorkflowNetworkPolicy>) => {
      const allowedMethods = [
        allowGet ? "GET" : "",
        allowPost ? "POST" : "",
      ].filter(Boolean) as Array<"GET" | "POST">;
      await savePolicy({
        allowedOrigins: linesToList(allowedOrigins),
        deniedOrigins: linesToList(deniedOrigins),
        allowedUrlPatterns: linesToList(allowedUrlPatterns),
        deniedUrlPatterns: linesToList(deniedUrlPatterns),
        allowedMethods: allowedMethods.length > 0 ? allowedMethods : undefined,
        ...patch,
      });
    },
    [
      allowGet,
      allowPost,
      allowedOrigins,
      allowedUrlPatterns,
      deniedOrigins,
      deniedUrlPatterns,
      savePolicy,
    ]
  );

  return (
    <section className="mb-6 border border-neutral-800 rounded p-4">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <h2 className="text-sm font-semibold mb-1">
            工作流网络访问规则
          </h2>
          <p className="text-xs text-neutral-500 mb-4">
            高级安全配置。用于限制工作流能访问哪些域名和 URL；禁止规则优先生效。
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="px-2 py-1 text-xs border border-neutral-700 rounded hover:bg-neutral-900"
          >
            {open ? "收起" : "展开"}
          </button>
          {open ? (
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || saving}
              className="px-2 py-1 text-xs border border-neutral-700 rounded hover:bg-neutral-900 disabled:opacity-50"
            >
              {loading ? "加载中" : "刷新"}
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
      <>
      <div className="grid gap-3 md:grid-cols-2">
        <PolicyTextarea
          label="允许访问的域名"
          placeholder="https://api.example.com"
          value={allowedOrigins}
          onChange={setAllowedOrigins}
        />
        <PolicyTextarea
          label="禁止访问的域名"
          placeholder="https://blocked.example.com"
          value={deniedOrigins}
          onChange={setDeniedOrigins}
        />
        <PolicyTextarea
          label="允许访问的 URL 规则"
          placeholder="https://api.example.com/public/*"
          value={allowedUrlPatterns}
          onChange={setAllowedUrlPatterns}
        />
        <PolicyTextarea
          label="禁止访问的 URL 规则"
          placeholder="https://api.example.com/private/*"
          value={deniedUrlPatterns}
          onChange={setDeniedUrlPatterns}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <span className="text-xs text-neutral-500">允许的请求方法</span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allowGet}
            onChange={(e) => setAllowGet(e.target.checked)}
          />
          GET
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allowPost}
            onChange={(e) => setAllowPost(e.target.checked)}
          />
          POST
        </label>
        <span className="text-[11px] text-neutral-600">
          都不勾选时不限制请求方法。
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[11px] text-neutral-600 leading-relaxed">
          规则保存到本机配置文件，下一次工作流运行时自动生效。
        </p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:bg-neutral-800 disabled:text-neutral-600"
        >
          {saving ? "保存中" : "保存策略"}
        </button>
      </div>
      {status ? <div className="mt-2 text-xs text-neutral-500">{status}</div> : null}
      <div className="mt-5 border-t border-neutral-800 pt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-neutral-300">
            网络访问记录
          </h3>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || saving}
            className="px-2 py-0.5 text-[11px] border border-neutral-700 rounded hover:bg-neutral-900 disabled:opacity-50"
          >
            刷新审计
          </button>
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_90px]">
          <input
            value={auditWorkflowId}
            onChange={(e) => setAuditWorkflowId(e.target.value)}
            placeholder="工作流 ID"
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600"
          />
          <input
            value={auditOrigin}
            onChange={(e) => setAuditOrigin(e.target.value)}
            placeholder="域名，例如 https://api.example.com"
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600"
          />
          <select
            value={auditOutcome}
            onChange={(e) =>
              setAuditOutcome(
                e.target.value === "allowed" ||
                  e.target.value === "denied" ||
                  e.target.value === "failed"
                  ? e.target.value
                  : ""
              )
            }
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600"
          >
            <option value="">全部状态</option>
            <option value="allowed">已允许</option>
            <option value="denied">已拒绝</option>
            <option value="failed">请求失败</option>
          </select>
          <select
            value={auditLimit}
            onChange={(e) => setAuditLimit(Number(e.target.value))}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
          <input
            value={auditSearch}
            onChange={(e) => setAuditSearch(e.target.value)}
            placeholder="搜索 URL、原因或状态"
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600 md:col-span-4"
          />
        </div>
        {audits.length === 0 ? (
          <div className="text-xs text-neutral-600">
            没有匹配的工作流网络请求记录。
          </div>
        ) : (
          <div className="space-y-1.5">
            {audits.map((entry) => (
              <AuditRow
                key={entry.id}
                entry={entry}
                disabled={saving}
                onAllowOrigin={async () => {
                  const origin = originForUrl(entry.url);
                  if (!origin) return;
                  const next = appendUniqueLine(allowedOrigins, origin);
                  setAllowedOrigins(next);
                  await saveWithPatch({ allowedOrigins: linesToList(next) });
                }}
                onDenyOrigin={async () => {
                  const origin = originForUrl(entry.url);
                  if (!origin) return;
                  const next = appendUniqueLine(deniedOrigins, origin);
                  setDeniedOrigins(next);
                  await saveWithPatch({ deniedOrigins: linesToList(next) });
                }}
                onDenyPattern={async () => {
                  const pattern = patternForUrl(entry.url);
                  if (!pattern) return;
                  const next = appendUniqueLine(deniedUrlPatterns, pattern);
                  setDeniedUrlPatterns(next);
                  await saveWithPatch({ deniedUrlPatterns: linesToList(next) });
                }}
              />
            ))}
          </div>
        )}
      </div>
      </>
      ) : null}
    </section>
  );
}

function AuditRow({
  entry,
  disabled,
  onAllowOrigin,
  onDenyOrigin,
  onDenyPattern,
}: {
  entry: WorkflowNetworkAuditEntry;
  disabled: boolean;
  onAllowOrigin: () => void | Promise<void>;
  onDenyOrigin: () => void | Promise<void>;
  onDenyPattern: () => void | Promise<void>;
}) {
  const color =
    entry.outcome === "allowed"
      ? "text-emerald-300"
      : entry.outcome === "denied"
        ? "text-amber-300"
        : "text-red-300";
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/70 p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={color}>
              {entry.outcome === "allowed"
                ? "已允许"
                : entry.outcome === "denied"
                  ? "已拒绝"
                  : "请求失败"}
            </span>
            <span className="text-neutral-500">{entry.method}</span>
            {entry.status ? <span className="text-neutral-500">{entry.status}</span> : null}
            <span className="font-mono text-neutral-600" title={entry.workflowId}>
              {entry.workflowId.slice(0, 8)}
            </span>
            <span className="text-neutral-600">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-neutral-300" title={entry.url}>
            {entry.url}
          </div>
          {entry.reason ? (
            <div className="mt-1 truncate text-[11px] text-neutral-600" title={entry.reason}>
              {entry.reason}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onAllowOrigin()}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
          >
            允许该域名
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onDenyOrigin()}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
          >
            禁止该域名
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onDenyPattern()}
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
          >
            禁止该路径
          </button>
        </div>
      </div>
    </div>
  );
}

function PolicyTextarea({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-500">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-200 outline-none focus:border-neutral-600"
      />
    </label>
  );
}
