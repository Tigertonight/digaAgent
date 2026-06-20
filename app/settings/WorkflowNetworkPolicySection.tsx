"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowNetworkAuditEntry,
  WorkflowNetworkPolicy,
} from "@/lib/workflows/types";
import { userFacingMessage } from "@/lib/user-facing-error";
import { Badge, Button, FieldInput } from "@/app/components/DesignPrimitives";

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

function lineCount(value: string): number {
  return linesToList(value)?.length ?? 0;
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

function accessSummary({
  allowedOrigins,
  deniedOrigins,
  allowedUrlPatterns,
  deniedUrlPatterns,
  allowGet,
  allowPost,
}: {
  allowedOrigins: string;
  deniedOrigins: string;
  allowedUrlPatterns: string;
  deniedUrlPatterns: string;
  allowGet: boolean;
  allowPost: boolean;
}) {
  const allowCount = lineCount(allowedOrigins) + lineCount(allowedUrlPatterns);
  const denyCount = lineCount(deniedOrigins) + lineCount(deniedUrlPatterns);
  const methodLimited = allowGet || allowPost;
  if (allowCount > 0) {
    return {
      label: "只允许清单内站点",
      tone: "warning" as const,
      detail: `已允许 ${allowCount} 项${denyCount > 0 ? `，另有 ${denyCount} 项禁止规则` : ""}${methodLimited ? "，并限制请求方式" : ""}。`,
    };
  }
  if (denyCount > 0 || methodLimited) {
    return {
      label: "默认允许，带限制",
      tone: "info" as const,
      detail: `${denyCount > 0 ? `已禁止 ${denyCount} 项` : "未限制站点"}${methodLimited ? "，并限制请求方式" : ""}。`,
    };
  }
  return {
    label: "默认允许",
    tone: "success" as const,
    detail: "工作流可以访问公开网页；危险地址仍会被底层安全规则拦截。",
  };
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
  const [quickSite, setQuickSite] = useState("");

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
      setStatus(`加载失败：${userFacingMessage(e)}`);
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
      setStatus(`保存失败：${userFacingMessage(e)}`);
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

  const summary = useMemo(
    () =>
      accessSummary({
        allowedOrigins,
        deniedOrigins,
        allowedUrlPatterns,
        deniedUrlPatterns,
        allowGet,
        allowPost,
      }),
    [
      allowGet,
      allowPost,
      allowedOrigins,
      allowedUrlPatterns,
      deniedOrigins,
      deniedUrlPatterns,
    ]
  );

  const recentAudits = audits.slice(0, 3);
  const hasPolicy =
    lineCount(allowedOrigins) > 0 ||
    lineCount(deniedOrigins) > 0 ||
    lineCount(allowedUrlPatterns) > 0 ||
    lineCount(deniedUrlPatterns) > 0 ||
    allowGet ||
    allowPost;

  const applyQuickSite = useCallback(
    async (type: "allow" | "deny") => {
      const origin = originForUrl(quickSite);
      if (!origin) {
        setStatus("请输入完整网址，例如 https://example.com");
        return;
      }
      if (type === "allow") {
        const next = appendUniqueLine(allowedOrigins, origin);
        setAllowedOrigins(next);
        await saveWithPatch({ allowedOrigins: linesToList(next) });
      } else {
        const next = appendUniqueLine(deniedOrigins, origin);
        setDeniedOrigins(next);
        await saveWithPatch({ deniedOrigins: linesToList(next) });
      }
      setQuickSite("");
    },
    [allowedOrigins, deniedOrigins, quickSite, saveWithPatch]
  );

  return (
    <section className="mb-6 space-y-4">
      <div className="rounded-token border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 className="text-token-body font-semibold">联网权限</h2>
            <Badge tone={summary.tone} variant="soft">
              {summary.label}
            </Badge>
          </div>
          <p className="text-token-sm leading-relaxed text-[color:var(--text-muted)]">
            {summary.detail}
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-[color:var(--border-soft)] pt-4">
          <div className="text-token-sm font-medium text-[color:var(--text)]">
            允许或禁止站点
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FieldInput
              value={quickSite}
              onChange={(e) => setQuickSite(e.target.value)}
              placeholder="https://example.com"
              className="min-w-[260px] flex-1 font-mono"
            />
            <Button
              type="button"
              onClick={() => void applyQuickSite("allow")}
              disabled={loading || saving || !quickSite.trim()}
              size="sm"
              tone="accent"
              variant="soft"
            >
              允许该站点
            </Button>
            <Button
              type="button"
              onClick={() => void applyQuickSite("deny")}
              disabled={loading || saving || !quickSite.trim()}
              size="sm"
              tone="warning"
              variant="outline"
            >
              禁止该站点
            </Button>
            {hasPolicy ? (
              <Button
                type="button"
                onClick={() => void savePolicy({})}
                disabled={loading || saving}
                size="sm"
                variant="outline"
              >
                恢复默认
              </Button>
            ) : null}
          </div>
          <p className="text-token-xs text-[color:var(--text-dim)]">
            输入完整网址即可，系统会自动识别站点域名。需要限制具体路径时再使用高级规则。
          </p>
          {status ? (
            <div className="text-token-sm text-[color:var(--text-muted)]">
              {status}
            </div>
          ) : null}
        </div>

        <div className="mt-4 border-t border-[color:var(--border-soft)] pt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-token-sm font-semibold text-[color:var(--text)]">
              最近访问
            </h3>
            <Button
              type="button"
              onClick={() => void load()}
              disabled={loading || saving}
              size="xs"
              variant="outline"
            >
              刷新
            </Button>
          </div>
          {recentAudits.length === 0 ? (
            <div className="text-token-sm text-[color:var(--text-dim)]">
              暂无工作流联网记录。
            </div>
          ) : (
            <div className="space-y-1.5">
              {recentAudits.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  disabled={saving}
                  compact
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
      </div>

      <div className="rounded-token border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="min-w-0 flex-1 text-left"
          >
            <h2 className="mb-1 text-token-body font-semibold">
              高级规则
            </h2>
            <p className="text-token-sm text-[color:var(--text-muted)]">
              精确限制域名、URL 路径和请求方法，并查看完整网络记录。
            </p>
          </button>
          <Button
            type="button"
            onClick={() => setOpen((v) => !v)}
            size="sm"
            variant="outline"
          >
            {open ? "收起" : "展开"}
          </Button>
        </div>

      {open ? (
      <>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
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

      <div className="mt-3 flex flex-wrap items-center gap-4 text-token-body">
        <span className="text-token-sm text-[color:var(--text-muted)]">允许的请求方法</span>
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
        <span className="text-token-xs text-[color:var(--text-dim)]">
          都不勾选时不限制请求方法。
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-token-xs leading-relaxed text-[color:var(--text-dim)]">
          规则保存后，下一次工作流运行时自动生效。
        </p>
        <Button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          size="sm"
          tone="accent"
          variant="soft"
        >
          {saving ? "保存中" : "保存策略"}
        </Button>
      </div>
      {status ? <div className="mt-2 text-token-sm text-[color:var(--text-muted)]">{status}</div> : null}
      <div className="mt-5 border-t border-[color:var(--border-soft)] pt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-token-sm font-semibold text-[color:var(--text)]">
            网络访问记录
          </h3>
          <Button
            type="button"
            onClick={() => void load()}
            disabled={loading || saving}
            size="xs"
            variant="outline"
          >
            刷新审计
          </Button>
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_90px]">
          <FieldInput
            value={auditWorkflowId}
            onChange={(e) => setAuditWorkflowId(e.target.value)}
            placeholder="工作流 ID"
            className="font-mono"
          />
          <FieldInput
            value={auditOrigin}
            onChange={(e) => setAuditOrigin(e.target.value)}
            placeholder="域名，例如 https://api.example.com"
            className="font-mono"
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
            className="h-[var(--field-height)] rounded-[var(--field-radius)] border border-[color:var(--border)] bg-[color:var(--bg)] px-2 text-token-sm text-[color:var(--text)] outline-none focus:border-[color:var(--accent)]"
          >
            <option value="">全部状态</option>
            <option value="allowed">已允许</option>
            <option value="denied">已拒绝</option>
            <option value="failed">请求失败</option>
          </select>
          <select
            value={auditLimit}
            onChange={(e) => setAuditLimit(Number(e.target.value))}
            className="h-[var(--field-height)] rounded-[var(--field-radius)] border border-[color:var(--border)] bg-[color:var(--bg)] px-2 text-token-sm text-[color:var(--text)] outline-none focus:border-[color:var(--accent)]"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
          <FieldInput
            value={auditSearch}
            onChange={(e) => setAuditSearch(e.target.value)}
            placeholder="搜索 URL、原因或状态"
            className="font-mono md:col-span-4"
          />
        </div>
        {audits.length === 0 ? (
          <div className="text-token-sm text-[color:var(--text-dim)]">
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
      </div>
    </section>
  );
}

function AuditRow({
  entry,
  disabled,
  compact = false,
  onAllowOrigin,
  onDenyOrigin,
  onDenyPattern,
}: {
  entry: WorkflowNetworkAuditEntry;
  disabled: boolean;
  compact?: boolean;
  onAllowOrigin: () => void | Promise<void>;
  onDenyOrigin: () => void | Promise<void>;
  onDenyPattern: () => void | Promise<void>;
}) {
  const tone =
    entry.outcome === "allowed"
      ? "success"
      : entry.outcome === "denied"
        ? "warning"
        : "danger";
  return (
    <div className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3">
      <div className={`flex items-start gap-2 ${compact ? "flex-col md:flex-row" : ""}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-token-sm">
            <Badge tone={tone} variant="soft">
              {entry.outcome === "allowed"
                ? "已允许"
                : entry.outcome === "denied"
                  ? "已拒绝"
                  : "请求失败"}
            </Badge>
            <span className="text-[color:var(--text-muted)]">{entry.method}</span>
            {entry.status ? <span className="text-[color:var(--text-muted)]">{entry.status}</span> : null}
            <span className="font-mono text-[color:var(--text-dim)]" title={entry.workflowId}>
              {entry.workflowId.slice(0, 8)}
            </span>
            <span className="text-[color:var(--text-dim)]">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-token-sm text-[color:var(--text)]" title={entry.url}>
            {entry.url}
          </div>
          {entry.reason ? (
            <div className="mt-1 truncate text-token-xs text-[color:var(--text-dim)]" title={entry.reason}>
              {entry.reason}
            </div>
          ) : null}
        </div>
        <div className={`flex shrink-0 gap-1 ${compact ? "flex-row flex-wrap" : "flex-col"}`}>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => void onAllowOrigin()}
            size="xs"
            variant="outline"
          >
            允许该域名
          </Button>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => void onDenyOrigin()}
            size="xs"
            variant="outline"
          >
            禁止该域名
          </Button>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => void onDenyPattern()}
            size="xs"
            variant="outline"
          >
            禁止该路径
          </Button>
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
      <span className="mb-1 block text-token-sm text-[color:var(--text-muted)]">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y rounded-[var(--field-radius)] border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 font-mono text-token-sm text-[color:var(--text)] outline-none placeholder:text-[color:var(--text-dim)] focus:border-[color:var(--accent)]"
      />
    </label>
  );
}
