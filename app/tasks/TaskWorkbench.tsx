"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Inbox,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  LongTaskCadence,
  LongTaskDashboard,
  LongTaskDefinition,
  LongTaskRun,
  LongTaskStatus,
  TaskFinding,
  TaskFindingStatus,
} from "@/lib/tasks/types";
import type { ProvidersResponse } from "@/lib/types";
import { curateProviderModels } from "@/lib/default-model";

type Draft = {
  title: string;
  prompt: string;
  projectPath: string;
  provider: string;
  modelId: string;
  cadence: LongTaskCadence;
  enabled: boolean;
  requireApprovalBeforeWrite: boolean;
  requireApprovalBeforeNetwork: boolean;
  maxDurationMinutes: number;
};

const EMPTY_DASHBOARD: LongTaskDashboard = {
  tasks: [],
  runs: [],
  findings: [],
  dueTasks: [],
  inboxCount: 0,
};

const CADENCE_LABEL: Record<LongTaskCadence, string> = {
  manual: "手动",
  daily: "每天",
  weekly: "每周",
};

const STATUS_LABEL: Record<LongTaskStatus, string> = {
  idle: "空闲",
  scheduled: "等待下次运行",
  running: "执行中",
  waiting_user: "等待你决策",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停",
  archived: "已归档",
};

function nowDraft(): Draft {
  return {
    title: "",
    prompt: "",
    projectPath: "",
    provider: "",
    modelId: "",
    cadence: "manual",
    enabled: true,
    requireApprovalBeforeWrite: true,
    requireApprovalBeforeNetwork: true,
    maxDurationMinutes: 60,
  };
}

function draftFromTask(task: LongTaskDefinition): Draft {
  return {
    title: task.title,
    prompt: task.prompt,
    projectPath: task.projectPath,
    provider: task.provider,
    modelId: task.modelId,
    cadence: task.cadence,
    enabled: task.enabled,
    requireApprovalBeforeWrite: task.permissionPolicy.requireApprovalBeforeWrite,
    requireApprovalBeforeNetwork: task.permissionPolicy.requireApprovalBeforeNetwork,
    maxDurationMinutes: task.permissionPolicy.maxDurationMinutes,
  };
}

function formatTime(value?: number) {
  if (!value) return "尚未运行";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function statusTone(status: LongTaskStatus) {
  if (status === "running") return "text-blue-600 dark:text-blue-300";
  if (status === "waiting_user") return "text-amber-600 dark:text-amber-300";
  if (status === "failed") return "text-red-600 dark:text-red-300";
  if (status === "completed" || status === "scheduled") {
    return "text-emerald-600 dark:text-emerald-300";
  }
  return "text-[color:var(--text-muted)]";
}

export default function TaskWorkbench() {
  const [dashboard, setDashboard] = useState<LongTaskDashboard>(EMPTY_DASHBOARD);
  const [providers, setProviders] = useState<ProvidersResponse["providers"]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => nowDraft());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();

  const selected = selectedId
    ? dashboard.tasks.find((task) => task.id === selectedId) ?? null
    : null;
  const selectedRuns = useMemo(
    () => dashboard.runs.filter((run) => run.taskId === selected?.id),
    [dashboard.runs, selected?.id]
  );
  const selectedFindings = useMemo(
    () => dashboard.findings.filter((finding) => finding.taskId === selected?.id),
    [dashboard.findings, selected?.id]
  );
  const inbox = dashboard.findings.filter((finding) => finding.status === "unread");
  const curatedProviders = curateProviderModels(providers).filter((p) => p.hasAuth);
  const currentProvider =
    curatedProviders.find((provider) => provider.provider === draft.provider) ??
    curatedProviders[0];

  const loadAll = async () => {
    setError(null);
    try {
      const [tasksRes, providersRes, cwdRes] = await Promise.all([
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/default-cwd", { cache: "no-store" }),
      ]);
      const tasksJson = (await tasksRes.json()) as LongTaskDashboard & {
        error?: string;
      };
      const providersJson = (await providersRes.json()) as ProvidersResponse;
      const cwdJson = (await cwdRes.json().catch(() => ({}))) as { cwd?: string };
      if (!tasksRes.ok || tasksJson.error) {
        throw new Error(tasksJson.error ?? "任务数据加载失败");
      }
      const nextProviders = Array.isArray(providersJson.providers)
        ? providersJson.providers
        : [];
      const nextDashboard = {
        ...EMPTY_DASHBOARD,
        ...tasksJson,
        tasks: Array.isArray(tasksJson.tasks) ? tasksJson.tasks : [],
        runs: Array.isArray(tasksJson.runs) ? tasksJson.runs : [],
        findings: Array.isArray(tasksJson.findings) ? tasksJson.findings : [],
        dueTasks: Array.isArray(tasksJson.dueTasks) ? tasksJson.dueTasks : [],
      };
      setProviders(nextProviders);
      setDashboard(nextDashboard);
      const nextSelected =
        selectedId && nextDashboard.tasks.some((task) => task.id === selectedId)
          ? selectedId
          : nextDashboard.tasks[0]?.id ?? null;
      setSelectedId(nextSelected);
      const provider = curateProviderModels(nextProviders).find((p) => p.hasAuth);
      const model = provider?.models[0];
      if (nextSelected) {
        const task = nextDashboard.tasks.find((item) => item.id === nextSelected);
        if (task) setDraft(draftFromTask(task));
      } else {
        setDraft({
          ...nowDraft(),
          projectPath: cwdJson.cwd ?? "",
          provider: provider?.provider ?? "",
          modelId: model?.id ?? "",
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    queueMicrotask(() => void loadAll());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taskAction = (body: Record<string, unknown>) => {
    startTransition(() => {
      void (async () => {
        setError(null);
        try {
          const res = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const json = (await res.json()) as {
            error?: string;
            dashboard?: LongTaskDashboard;
            task?: LongTaskDefinition;
          };
          if (!res.ok || json.error) throw new Error(json.error ?? "操作失败");
          if (json.dashboard) setDashboard(json.dashboard);
          if (json.task) {
            setSelectedId(json.task.id);
            setDraft(draftFromTask(json.task));
          }
        } catch (e) {
          setError((e as Error).message);
        }
      })();
    });
  };

  const saveTask = () => {
    const body = {
      ...(selected ? { type: "update", id: selected.id } : { type: "create" }),
      title: draft.title,
      prompt: draft.prompt,
      projectPath: draft.projectPath,
      provider: draft.provider,
      modelId: draft.modelId,
      cadence: draft.cadence,
      enabled: draft.enabled,
      permissionPolicy: {
        requireApprovalBeforeWrite: draft.requireApprovalBeforeWrite,
        requireApprovalBeforeNetwork: draft.requireApprovalBeforeNetwork,
        maxDurationMinutes: draft.maxDurationMinutes,
      },
    };
    taskAction(body);
  };

  const newTask = () => {
    setSelectedId(null);
    setDraft({
      ...nowDraft(),
      projectPath: draft.projectPath,
      provider: currentProvider?.provider ?? draft.provider,
      modelId: currentProvider?.models[0]?.id ?? draft.modelId,
    });
  };

  return (
    <main className="flex h-screen min-w-0 bg-[color:var(--bg)] text-[color:var(--text)]">
      <aside className="flex w-[330px] shrink-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-panel)]">
        <div className="border-b border-[color:var(--border)] p-4">
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
          >
            <ArrowLeft size={16} />
            返回应用
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">长期任务</h1>
              <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                盯事、跑事、汇报事，等你决策。
              </p>
            </div>
            <button
              type="button"
              onClick={newTask}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-[color:var(--border)] bg-[color:var(--bg)]"
              title="新建任务"
            >
              <Plus size={17} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 border-b border-[color:var(--border)] p-3 text-center text-xs">
          <Metric label="任务" value={dashboard.tasks.length} />
          <Metric label="待处理" value={dashboard.inboxCount} tone="text-amber-600 dark:text-amber-300" />
          <Metric label="到期" value={dashboard.dueTasks.length} tone="text-blue-600 dark:text-blue-300" />
        </div>

        <div className="border-b border-[color:var(--border)] px-3 py-2 text-xs text-[color:var(--text-muted)]">
          <div className="flex items-center justify-between gap-2 rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-2">
            <span className="inline-flex items-center gap-2">
              <span
                className={
                  dashboard.scheduler?.enabled
                    ? "text-emerald-500"
                    : "text-[color:var(--text-muted)]"
                }
              >
                ●
              </span>
              自动盯事
            </span>
            <span className="truncate">
              {dashboard.scheduler?.running
                ? "检查中"
                : dashboard.scheduler?.lastCheckedAt
                  ? `上次 ${formatTime(dashboard.scheduler.lastCheckedAt)}`
                  : "待启动"}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-[color:var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              正在加载任务…
            </div>
          ) : dashboard.tasks.length === 0 ? (
            <div className="p-4 text-sm text-[color:var(--text-muted)]">
              还没有长期任务。创建一个任务，让 Diga 定期帮你检查。
            </div>
          ) : (
            dashboard.tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => {
                  setSelectedId(task.id);
                  setDraft(draftFromTask(task));
                }}
                className={`mb-2 block w-full rounded border p-3 text-left ${
                  selected?.id === task.id
                    ? "border-[color:var(--accent)] bg-[color:var(--bg-selected)]"
                    : "border-[color:var(--border-soft)] hover:bg-[color:var(--bg-hover)]"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`text-xs ${statusTone(task.status)}`}>
                    ●
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {task.title}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
                  <span>{CADENCE_LABEL[task.cadence]}</span>
                  <span>·</span>
                  <span>{STATUS_LABEL[task.status]}</span>
                </div>
                <div className="mt-1 truncate text-xs text-[color:var(--text-muted)]">
                  下次：{task.nextRunAt ? formatTime(task.nextRunAt) : "手动触发"}
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--bg-panel)] px-5 py-3">
          <div className="min-w-0">
            <div className="text-sm text-[color:var(--text-muted)]">任务控制台</div>
            <div className="truncate text-lg font-semibold">
              {selected ? selected.title : "新建长期任务"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="task-btn" onClick={() => void loadAll()} type="button">
              <RefreshCw size={15} />
              刷新
            </button>
            {selected ? (
              <>
                <button
                  className="task-btn task-btn-primary"
                  onClick={() => taskAction({ type: "run", id: selected.id })}
                  disabled={isPending || selected.status === "running"}
                  type="button"
                >
                  {selected.status === "running" ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Play size={15} />
                  )}
                  立即运行
                </button>
                <button
                  className="task-btn"
                  onClick={() =>
                    taskAction({
                      type: "update",
                      id: selected.id,
                      ...draft,
                      enabled: selected.status === "paused",
                      status: selected.status === "paused" ? "scheduled" : "paused",
                      permissionPolicy: {
                        requireApprovalBeforeWrite: draft.requireApprovalBeforeWrite,
                        requireApprovalBeforeNetwork: draft.requireApprovalBeforeNetwork,
                        maxDurationMinutes: draft.maxDurationMinutes,
                      },
                    })
                  }
                  type="button"
                >
                  <Pause size={15} />
                  {selected.status === "paused" ? "恢复" : "暂停"}
                </button>
              </>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-sm text-red-700 dark:text-red-200">
            {error}
          </div>
        ) : null}

        {selected?.status === "waiting_user" ? (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-sm text-amber-800 dark:text-amber-100">
            <div className="font-medium">这个任务正在等待你决策</div>
            <div className="mt-1 text-amber-700 dark:text-amber-200">
              {selectedRuns[0]?.waitingReason ||
                selectedRuns[0]?.summary ||
                "请回到对应会话处理授权、确认或补充问题。"}
            </div>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] overflow-hidden">
          <div className="min-w-0 overflow-auto px-6 py-5">
            <section className="max-w-4xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">任务配置</h2>
                <button
                  className="task-btn task-btn-primary"
                  type="button"
                  onClick={saveTask}
                  disabled={isPending}
                >
                  {isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                  保存任务
                </button>
              </div>
              <div className="grid gap-4">
                <Field label="任务名称">
                  <input
                    className="task-input"
                    value={draft.title}
                    onChange={(e) => setDraft((cur) => ({ ...cur, title: e.target.value }))}
                    placeholder="例如：每日检查 CI 和高优先级反馈"
                  />
                </Field>
                <Field label="任务目标">
                  <textarea
                    className="task-input min-h-[150px] resize-y"
                    value={draft.prompt}
                    onChange={(e) => setDraft((cur) => ({ ...cur, prompt: e.target.value }))}
                    placeholder="告诉 Diga 需要持续关注什么、什么情况下需要汇报、什么时候等待你确认。"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="项目路径">
                    <input
                      className="task-input"
                      value={draft.projectPath}
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, projectPath: e.target.value }))
                      }
                    />
                  </Field>
                  <Field label="运行频率">
                    <select
                      className="task-input"
                      value={draft.cadence}
                      onChange={(e) =>
                        setDraft((cur) => ({
                          ...cur,
                          cadence: e.target.value as LongTaskCadence,
                        }))
                      }
                    >
                      <option value="manual">手动</option>
                      <option value="daily">每天</option>
                      <option value="weekly">每周</option>
                    </select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="模型服务">
                    <select
                      className="task-input"
                      value={draft.provider}
                      onChange={(e) => {
                        const provider = curatedProviders.find(
                          (item) => item.provider === e.target.value
                        );
                        setDraft((cur) => ({
                          ...cur,
                          provider: e.target.value,
                          modelId: provider?.models[0]?.id ?? "",
                        }));
                      }}
                    >
                      {curatedProviders.map((provider) => (
                        <option key={provider.provider} value={provider.provider}>
                          {provider.displayName || provider.provider}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="模型">
                    <select
                      className="task-input"
                      value={draft.modelId}
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, modelId: e.target.value }))
                      }
                    >
                      {(currentProvider?.models ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name || model.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <ToggleField
                    icon={<ShieldCheck size={16} />}
                    title="写入前确认"
                    checked={draft.requireApprovalBeforeWrite}
                    onChange={(checked) =>
                      setDraft((cur) => ({
                        ...cur,
                        requireApprovalBeforeWrite: checked,
                      }))
                    }
                  />
                  <ToggleField
                    icon={<Bell size={16} />}
                    title="联网前确认"
                    checked={draft.requireApprovalBeforeNetwork}
                    onChange={(checked) =>
                      setDraft((cur) => ({
                        ...cur,
                        requireApprovalBeforeNetwork: checked,
                      }))
                    }
                  />
                  <Field label="最长运行">
                    <input
                      className="task-input"
                      type="number"
                      min={5}
                      max={1440}
                      value={draft.maxDurationMinutes}
                      onChange={(e) =>
                        setDraft((cur) => ({
                          ...cur,
                          maxDurationMinutes: Number(e.target.value),
                        }))
                      }
                    />
                  </Field>
                </div>
              </div>
            </section>

            <section className="mt-8 max-w-4xl">
              <h2 className="mb-3 text-base font-semibold">运行历史</h2>
              {selectedRuns.length === 0 ? (
                <EmptyLine text="这个任务还没有运行记录。" />
              ) : (
                <div className="space-y-2">
                  {selectedRuns.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="min-h-0 overflow-auto border-l border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">收件箱</h2>
                <p className="text-xs text-[color:var(--text-muted)]">
                  只放需要你处理或确认的事项。
                </p>
              </div>
              <Inbox size={18} className="text-[color:var(--text-muted)]" />
            </div>
            <button
              type="button"
              onClick={() => taskAction({ type: "run_due" })}
              className="mb-4 flex w-full items-center justify-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-sm"
            >
              <CalendarClock size={15} />
              运行到期任务
            </button>
            {inbox.length === 0 ? (
              <EmptyLine text="当前没有需要你处理的新事项。" />
            ) : (
              <div className="space-y-3">
                {inbox.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    onStatus={(status) =>
                      taskAction({
                        type: "finding_status",
                        id: finding.id,
                        status,
                      })
                    }
                  />
                ))}
              </div>
            )}

            {selectedFindings.length > inbox.length ? (
              <div className="mt-8">
                <h3 className="mb-2 text-sm font-semibold">当前任务已处理事项</h3>
                <div className="space-y-2">
                  {selectedFindings
                    .filter((finding) => finding.status !== "unread")
                    .map((finding) => (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        compact
                        onStatus={(status) =>
                          taskAction({
                            type: "finding_status",
                            id: finding.id,
                            status,
                          })
                        }
                      />
                    ))}
                </div>
              </div>
            ) : null}

            {selected ? (
              <button
                type="button"
                onClick={() => {
                  taskAction({ type: "delete", id: selected.id });
                  newTask();
                }}
                className="mt-8 flex w-full items-center justify-center gap-2 rounded border border-red-500/40 px-3 py-2 text-sm text-red-600 dark:text-red-300"
              >
                <Trash2 size={15} />
                删除当前任务
              </button>
            ) : null}
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  tone = "text-[color:var(--text)]",
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-2 py-2">
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-[11px] text-[color:var(--text-muted)]">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[color:var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function ToggleField({
  icon,
  title,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-3">
      <span className="text-[color:var(--text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1 text-sm font-medium">{title}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-[color:var(--border-soft)] px-3 py-5 text-center text-sm text-[color:var(--text-muted)]">
      {text}
    </div>
  );
}

function RunRow({ run }: { run: LongTaskRun }) {
  return (
    <div className="flex items-start gap-3 rounded border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-3">
      <Clock3 size={16} className="mt-0.5 text-[color:var(--text-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>{runStatusLabel(run.status)}</span>
          <span className="text-xs text-[color:var(--text-muted)]">
            {formatTime(run.startedAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-[color:var(--text-muted)]">
          {run.waitingReason ||
            run.summary ||
            run.error ||
            "正在执行，完成后会生成运行报告。"}
        </p>
      </div>
      {run.agentId ? (
        <Link
          className="shrink-0 rounded border border-[color:var(--border)] px-2 py-1 text-xs"
          href="/"
        >
          查看会话
        </Link>
      ) : null}
    </div>
  );
}

function FindingCard({
  finding,
  compact,
  onStatus,
}: {
  finding: TaskFinding;
  compact?: boolean;
  onStatus: (status: TaskFindingStatus) => void;
}) {
  return (
    <div className="rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3">
      <div className="flex items-start gap-2">
        <span className={severityClass(finding.severity)}>●</span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-semibold">{finding.title}</div>
          {!compact ? (
            <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-[color:var(--text-muted)]">
              {finding.body}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {finding.status === "unread" ? (
          <>
            <button className="task-mini-btn" onClick={() => onStatus("reviewed")} type="button">
              已读
            </button>
            <button className="task-mini-btn" onClick={() => onStatus("resolved")} type="button">
              已解决
            </button>
          </>
        ) : null}
        <button className="task-mini-btn" onClick={() => onStatus("archived")} type="button">
          <Archive size={13} />
          归档
        </button>
      </div>
    </div>
  );
}

function runStatusLabel(status: LongTaskRun["status"]) {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "waiting_user") return "等待你决策";
  if (status === "completed_with_findings") return "已汇报事项";
  if (status === "completed_empty") return "无新事项";
  if (status === "failed") return "失败";
  return "已中止";
}

function severityClass(severity: TaskFinding["severity"]) {
  if (severity === "critical") return "mt-0.5 text-red-500";
  if (severity === "warning") return "mt-0.5 text-amber-500";
  return "mt-0.5 text-blue-500";
}
