"use client";

/**
 * Skills 模态对话框（对齐 pi-web SkillsConfig）。
 *
 * 形态：居中模态（800×78vh），左侧 skill 列表（按 project/global/path 分组 + 圆点指示开关），
 * 右侧详情面板（Name/Description/路径标签 + Toggle）；左下角 "+ Add skill" 切换右侧为安装搜索。
 *
 * mini-pi-web 增强：底部增加 "Configured packages" 区，列出已配置 packages，提供 update / remove。
 *
 * 注意：所有操作都打 /api/skills，cwd 由 parent 传入。
 */
import { Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "./ConfirmButton";
import { userFacingMessage } from "@/lib/user-facing-error";

interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: { source?: string; scope?: string } | null | undefined;
  disableModelInvocation: boolean;
}

interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

interface SkillsResponse {
  cwd: string;
  skills: SkillInfo[];
  diagnostics: Array<{ message: string; path?: string }>;
  packages: ConfiguredPackage[];
  error?: string;
}

interface MarketplaceResult {
  package: string;
  installs: string;
  url: string;
}

interface Props {
  cwd: string;
  onClose?: () => void;
  embedded?: boolean;
}

type GroupLabel = "project" | "global" | "path";
type Scope = "global" | "project";

function shortenPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: SkillInfo): GroupLabel {
  const src = skill.source?.source;
  const scope = skill.source?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

function Toggle({
  enabled,
  loading,
  onToggle,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={
        enabled
          ? "Visible in model prompt — click to disable"
          : "Hidden from model prompt — click to enable"
      }
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px var(--color-shadow-control)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
}: {
  skill: SkillInfo;
  cwd: string;
  onToggle: (s: SkillInfo) => void;
  toggling: boolean;
  saveError: string | null;
}) {
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;

  function displayPath(p: string): string {
    if (label === "project" && cwd && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            flexShrink: 0,
            background:
              label === "project"
                ? "var(--color-accent-bg)"
                : "var(--bg-subtle)",
            color:
              label === "project"
                ? "var(--accent)"
                : "var(--text-muted)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={skill.filePath}
        >
          {displayPath(skill.filePath)}
        </span>
        <Toggle
          enabled={enabled}
          loading={toggling}
          onToggle={() => onToggle(skill)}
        />
      </div>

      {saveError && (
        <div style={{ fontSize: 12, color: "var(--color-danger)" }}>{saveError}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          Name
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "var(--text)",
          }}
        >
          {skill.name}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          Description
        </span>
        <span
          style={{
            fontSize: 14,
            color: "var(--text-muted)",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
          }}
        >
          {skill.description || "(no description)"}
        </span>
      </div>
    </div>
  );
}

function AddSkillPanel({
  cwd,
  onInstalled,
  defaultSpec,
}: {
  cwd: string;
  onInstalled: () => void;
  defaultSpec?: string;
}) {
  const [tab, setTab] = useState<"market" | "manual">("market");
  const [scope, setScope] = useState<Scope>("global");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  // marketplace
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<MarketplaceResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // manual
  const [manualSrc, setManualSrc] = useState(defaultSpec ?? "");

  useEffect(() => {
    if (defaultSpec) {
      queueMicrotask(() => {
        setTab("manual");
        setManualSrc(defaultSpec);
      });
    }
  }, [defaultSpec]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const r = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim(), limit: 30 }),
      });
      const d = (await r.json()) as {
        results?: MarketplaceResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(userFacingMessage(d.error, { context: "skills" }));
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError("No skills found");
    } catch (e) {
      setSearchError(userFacingMessage(e, { context: "skills" }));
    } finally {
      setSearching(false);
    }
  }, []);

  const installFromMarket = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      try {
        const r = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = await r.json();
        if (!r.ok || d.error) {
          setInstallError(userFacingMessage(d.error ?? `HTTP ${r.status}`, { context: "skills" }));
          return;
        }
        setInstalled((s) => new Set(s).add(pkg));
        onInstalled();
      } catch (e) {
        setInstallError(userFacingMessage(e, { context: "skills" }));
      } finally {
        setInstalling(null);
      }
    },
    [scope, cwd, onInstalled]
  );

  const installManual = useCallback(async () => {
    const src = manualSrc.trim();
    if (!src) return;
    setInstalling(src);
    setInstallError(null);
    try {
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "install",
          source: src,
          local: scope === "project",
          cwd,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setInstallError(userFacingMessage(d.error ?? `HTTP ${r.status}`, { context: "skills" }));
        return;
      }
      setManualSrc("");
      onInstalled();
    } catch (e) {
      setInstallError(userFacingMessage(e, { context: "skills" }));
    } finally {
      setInstalling(null);
    }
  }, [manualSrc, scope, cwd, onInstalled]);

  const installPath =
    scope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(cwd || "")}/.pi/agent/skills/`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          Add Skill
        </div>

        {/* Tab */}
        <div
          style={{
            display: "flex",
            borderRadius: 5,
            border: "1px solid var(--border)",
            overflow: "hidden",
            fontSize: 12,
            width: "fit-content",
          }}
        >
          {(
            [
              ["market", "Marketplace"],
              ["manual", "Manual (npm/git)"],
            ] as const
          ).map(([k, lab], i) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              style={{
                padding: "4px 12px",
                border: "none",
                cursor: "pointer",
                background: tab === k ? "var(--bg-selected)" : "transparent",
                color: tab === k ? "var(--text)" : "var(--text-muted)",
                fontWeight: tab === k ? 600 : 400,
                borderRight: i === 0 ? "1px solid var(--border)" : "none",
              }}
            >
              {lab}
            </button>
          ))}
        </div>

        {/* Scope */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              borderRadius: 5,
              border: "1px solid var(--border)",
              overflow: "hidden",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {(["global", "project"] as const).map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  cursor: "pointer",
                  background: scope === s ? "var(--bg-selected)" : "transparent",
                  color: scope === s ? "var(--text)" : "var(--text-muted)",
                  fontWeight: scope === s ? 600 : 400,
                  borderRight: i === 0 ? "1px solid var(--border)" : "none",
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {installPath}
          </span>
        </div>

        {/* Tab body */}
        {tab === "market" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search(query);
              }}
              placeholder="e.g. react, testing, deploy"
              style={{
                flex: 1,
                padding: "7px 10px",
                fontSize: 13,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => void search(query)}
              disabled={searching || !query.trim()}
              style={{
                padding: "7px 16px",
                fontSize: 13,
                borderRadius: 6,
                border: "none",
                background: "var(--accent)",
                color: "var(--color-bg)",
                cursor:
                  searching || !query.trim() ? "not-allowed" : "pointer",
                opacity: searching || !query.trim() ? 0.5 : 1,
                flexShrink: 0,
              }}
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={manualSrc}
              onChange={(e) => setManualSrc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void installManual();
              }}
              placeholder="@scope/pkg@1.0 or git+https://..."
              style={{
                flex: 1,
                padding: "7px 10px",
                fontSize: 13,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
            <button
              type="button"
              onClick={() => void installManual()}
              disabled={installing !== null || !manualSrc.trim()}
              style={{
                padding: "7px 16px",
                fontSize: 13,
                borderRadius: 6,
                border: "none",
                background: "var(--accent)",
                color: "var(--color-bg)",
                cursor:
                  installing !== null || !manualSrc.trim()
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  installing !== null || !manualSrc.trim() ? 0.5 : 1,
                flexShrink: 0,
              }}
            >
              {installing === manualSrc.trim() ? "Installing…" : "Install"}
            </button>
          </div>
        )}

        {searchError && (
          <div style={{ fontSize: 12, color: "var(--color-danger)" }}>{searchError}</div>
        )}
        {installError && (
          <div
            style={{
              fontSize: 12,
              color: "var(--color-danger)",
              wordBreak: "break-word",
            }}
          >
            {installError}
          </div>
        )}
      </div>

      {tab === "market" && results.length > 0 && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled = installed.has(r.package);
            const isInstalling = installing === r.package;
            const atIdx = r.package.indexOf("@", 1);
            const repopart =
              atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-muted)",
                      }}
                    >
                      {repopart}
                    </span>
                    {r.installs && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          fontWeight: 500,
                        }}
                      >
                        {r.installs}
                      </span>
                    )}
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    !isInstalled &&
                    !isInstalling &&
                    void installFromMarket(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null}
                  style={{
                    flexShrink: 0,
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    cursor:
                      isInstalled || isInstalling || installing !== null
                        ? "not-allowed"
                        : "pointer",
                    background: isInstalled
                      ? "var(--color-success-bg)"
                      : "transparent",
                    color: isInstalled
                      ? "var(--color-success)"
                      : isInstalling
                      ? "var(--accent)"
                      : "var(--text-muted)",
                  }}
                >
                  {isInstalled
                    ? "✓ Installed"
                    : isInstalling
                    ? "Installing…"
                    : "Install"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "market" &&
        results.length === 0 &&
        !searching &&
        !searchError && (
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.8,
            }}
          >
            Search{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              skills.sh
            </a>{" "}
            to discover and install skills.
          </div>
        )}
    </div>
  );
}

function PackagesSection({
  packages,
  busyPackage,
  onUpdate,
  onRemove,
  onUpdateAll,
}: {
  packages: ConfiguredPackage[];
  busyPackage: string | null;
  onUpdate: (source: string) => void;
  onRemove: (source: string, scope: "user" | "project") => void;
  onUpdateAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (packages.length === 0) return null;
  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        flexShrink: 0,
        background: "var(--bg-panel)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          padding: "8px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Configured packages · {packages.length}
        <span style={{ marginLeft: "auto" }}>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (busyPackage === null) onUpdateAll();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                if (busyPackage === null) onUpdateAll();
              }
            }}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              cursor: busyPackage !== null ? "wait" : "pointer",
              opacity: busyPackage !== null ? 0.5 : 1,
            }}
            title="更新所有 packages"
          >
            ⇪ all
          </span>
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: "0 14px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 160,
            overflowY: "auto",
          }}
        >
          {packages.map((p) => (
            <div
              key={`${p.scope}:${p.source}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "4px 6px",
                borderRadius: 4,
                background: "var(--bg)",
                border: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                [{p.scope}]
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                }}
                title={p.source}
              >
                {p.source}
              </span>
              <button
                type="button"
                onClick={() => onUpdate(p.source)}
                disabled={busyPackage !== null}
                title="更新"
                style={{
                  padding: "2px 6px",
                  fontSize: 10,
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: busyPackage !== null ? "wait" : "pointer",
                  opacity: busyPackage !== null ? 0.5 : 1,
                }}
              >
                ⇪
              </button>
              <ConfirmButton
                onConfirm={() => onRemove(p.source, p.scope)}
                disabled={busyPackage !== null}
                style={{
                  padding: "2px 6px",
                  fontSize: 10,
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--color-danger)",
                }}
                title={`移除 ${p.source} (${p.scope})`}
              >
                ✕
              </ConfirmButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SkillsPanel({ cwd, onClose, embedded = false }: Props) {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [defaultSpec, setDefaultSpec] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/skills?cwd=${encodeURIComponent(cwd || "")}`
      );
      const d = (await r.json()) as SkillsResponse;
      if (d.error) {
        setError(userFacingMessage(d.error, { context: "skills" }));
      } else {
        setData(d);
        setSelected((cur) => {
          if (cur && d.skills.some((s) => s.filePath === cur)) return cur;
          return d.skills[0]?.filePath ?? null;
        });
      }
    } catch (e) {
      setError(userFacingMessage(e, { context: "skills" }));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const grouped = useMemo(() => {
    const groups: { label: GroupLabel; skills: SkillInfo[] }[] = [];
    if (!data) return groups;
    for (const grp of ["project", "global", "path"] as GroupLabel[]) {
      const items = data.skills.filter((s) => sourceLabel(s) === grp);
      if (items.length > 0) groups.push({ label: grp, skills: items });
    }
    return groups;
  }, [data]);

  const selectedSkill = useMemo(
    () => data?.skills.find((s) => s.filePath === selected) ?? null,
    [data, selected]
  );

  const toggle = useCallback(async (skill: SkillInfo) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const r = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      if (!r.ok || d.error) {
        setSaveError(userFacingMessage(d.error ?? `HTTP ${r.status}`, { context: "skills" }));
        return;
      }
      setData((prev) =>
        prev
          ? {
              ...prev,
              skills: prev.skills.map((s) =>
                s.filePath === skill.filePath
                  ? { ...s, disableModelInvocation: next }
                  : s
              ),
            }
          : prev
      );
    } catch (e) {
      setSaveError(userFacingMessage(e, { context: "skills" }));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, []);

  const doRemove = useCallback(
    async (source: string, scope: "user" | "project") => {
      setBusyPackage(source);
      setError(null);
      try {
        const r = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "remove",
            source,
            local: scope === "project",
            cwd,
          }),
        });
        const d = await r.json();
        if (d.error) setError(userFacingMessage(d.error, { context: "skills" }));
        else await load();
      } catch (e) {
        setError(userFacingMessage(e, { context: "skills" }));
      } finally {
        setBusyPackage(null);
      }
    },
    [cwd, load]
  );

  const doUpdate = useCallback(
    async (source?: string) => {
      setBusyPackage(source ?? "*all*");
      setError(null);
      try {
        const r = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update",
            source,
            cwd,
          }),
        });
        const d = await r.json();
        if (d.error) setError(userFacingMessage(d.error, { context: "skills" }));
        else await load();
      } catch (e) {
        setError(userFacingMessage(e, { context: "skills" }));
      } finally {
        setBusyPackage(null);
      }
    },
    [cwd, load]
  );

  return (
    <div
      style={{
        position: embedded ? "relative" : "fixed",
        inset: embedded ? undefined : 0,
        zIndex: embedded ? undefined : 1000,
        background: embedded ? "transparent" : "var(--color-overlay)",
        display: "flex",
        alignItems: embedded ? "stretch" : "center",
        justifyContent: "center",
        width: embedded ? "100%" : undefined,
      }}
      onClick={(e) => {
        if (!embedded && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        style={{
          width: embedded ? "100%" : 880,
          maxWidth: embedded ? "none" : "92vw",
          height: embedded ? "min(720px, calc(100vh - 260px))" : "82vh",
          minHeight: embedded ? 520 : undefined,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: embedded ? "none" : "0 8px 32px var(--color-shadow-control)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span
              style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}
            >
              技能
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                maxWidth: 360,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={cwd}
            >
              {shortenPath(cwd || "")}
            </code>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              title="刷新"
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: loading ? "wait" : "pointer",
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 4,
              }}
            >
              {loading ? "…" : "↻"}
            </button>
            {!embedded ? (
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 20,
                  lineHeight: 1,
                  padding: "2px 6px",
                }}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            style={{
              width: 220,
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  Loading…
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--color-danger)",
                    wordBreak: "break-word",
                  }}
                >
                  {error}
                </div>
              ) : grouped.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  No skills found
                </div>
              ) : (
                grouped.map(({ label, skills }) => (
                  <div key={label} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        padding: "4px 8px 3px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {label}
                    </div>
                    {skills.map((skill) => {
                      const isSelected =
                        !addMode && selected === skill.filePath;
                      const disabled = skill.disableModelInvocation;
                      return (
                        <div
                          key={skill.filePath}
                          onClick={() => {
                            setSelected(skill.filePath);
                            setAddMode(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "8px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isSelected
                              ? "var(--bg-selected)"
                              : "transparent",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected)
                              e.currentTarget.style.background =
                                "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected)
                              e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <span
                            style={{
                              flexShrink: 0,
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: disabled
                                ? "var(--border)"
                                : "var(--accent)",
                              boxShadow: disabled
                                ? "none"
                                : "0 0 4px var(--accent)",
                              transition:
                                "background 0.15s, box-shadow 0.15s",
                            }}
                          />
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: isSelected ? 600 : 400,
                              color: disabled
                                ? "var(--text-muted)"
                                : "var(--text)",
                              fontFamily: "var(--font-mono)",
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={skill.name}
                          >
                            {skill.name}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Add skill button */}
            <div
              style={{
                padding: "8px 6px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => {
                  setAddMode(true);
                  setDefaultSpec(undefined);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "transparent",
                  color: addMode ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode)
                    e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <Plus size={13} />
                Add skill
              </div>
            </div>

            {/* mini-pi-web 增强：configured packages */}
            {data && (
              <PackagesSection
                packages={data.packages}
                busyPackage={busyPackage}
                onUpdate={(s) => void doUpdate(s)}
                onRemove={(s, sc) => void doRemove(s, sc)}
                onUpdateAll={() => void doUpdate(undefined)}
              />
            )}
          </div>

          {/* Right: detail or add panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                defaultSpec={defaultSpec}
                onInstalled={() => {
                  void load();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={(s) => void toggle(s)}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 13,
                }}
              >
                Select a skill
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {!embedded ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {data && data.diagnostics.length > 0 && (
                <span style={{ color: "var(--color-warning)" }}>
                  ⚠ {data.diagnostics.length} diagnostic(s)
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 14px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Close
            </button>
          </div>
        ) : data && data.diagnostics.length > 0 ? (
          <div
            style={{
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
              fontSize: 11,
              color: "var(--color-warning)",
            }}
          >
            ⚠ {data.diagnostics.length} diagnostic(s)
          </div>
        ) : null}
      </div>
    </div>
  );
}
