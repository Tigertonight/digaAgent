"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ClipboardCheck,
  Inbox,
  ListChecks,
  Loader2,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge, Button, FieldInput, StatusPill } from "@/app/components/DesignPrimitives";
import type {
  LongTaskCadence,
  LongTaskDashboard,
  LongTaskDefinition,
  LongTaskRun,
  LongTaskStatus,
  TaskFinding,
  TaskFindingSeverity,
  TaskFindingStatus,
} from "@/lib/tasks/types";
import type { ProvidersResponse } from "@/lib/types";
import { curateProviderModels } from "@/lib/default-model";
import { userFacingMessage } from "@/lib/user-facing-error";

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

const STATUS_HELP: Record<LongTaskStatus, string> = {
  idle: "还没有安排自动运行，可以手动启动。",
  scheduled: "任务已布置，会按节奏自动检查。",
  running: "Agent 正在处理这个任务。",
  waiting_user: "需要你确认、授权或补充信息。",
  completed: "最近一次运行已经完成。",
  failed: "最近一次运行没有完成，需要查看原因。",
  paused: "任务已暂停，不会自动运行。",
  archived: "任务已归档，不再显示为活跃任务。",
};

const CADENCE_HELP: Record<LongTaskCadence, string> = {
  manual: "只在你点击运行时执行",
  daily: "每天自动检查一次",
  weekly: "每周自动检查一次",
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
  if (status === "running") return "text-[color:var(--color-info)]";
  if (status === "waiting_user") return "text-[color:var(--color-warning)]";
  if (status === "failed") return "text-[color:var(--color-danger)]";
  if (status === "completed" || status === "scheduled") {
    return "text-[color:var(--color-success)]";
  }
  return "text-[color:var(--text-muted)]";
}

function statusBadgeTone(status: LongTaskStatus): "default" | "success" | "warning" | "danger" | "info" {
  if (status === "running") return "info";
  if (status === "waiting_user") return "warning";
  if (status === "failed") return "danger";
  if (status === "completed" || status === "scheduled") return "success";
  return "default";
}

function findingTone(severity: TaskFindingSeverity): "info" | "warning" | "danger" {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

function severityLabel(severity: TaskFindingSeverity) {
  if (severity === "critical") return "高优先级";
  if (severity === "warning") return "需关注";
  return "信息";
}

function latestRunOf(runs: LongTaskRun[]) {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export default function TaskWorkbench() {
  const [dashboard, setDashboard] = useState<LongTaskDashboard>(EMPTY_DASHBOARD);
  const [providers, setProviders] = useState<ProvidersResponse["providers"]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => nowDraft());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
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
  const selectedFinding = selectedFindingId
    ? dashboard.findings.find((finding) => finding.id === selectedFindingId) ?? null
    : null;
  const selectedFindingRun = selectedFinding
    ? dashboard.runs.find((run) => run.id === selectedFinding.runId) ?? null
    : null;
  const selectedFindingTask = selectedFinding
    ? dashboard.tasks.find((task) => task.id === selectedFinding.taskId) ?? null
    : null;
  const latestRun = latestRunOf(selectedRuns);
  const activeTaskCount = dashboard.tasks.filter(
    (task) => task.status !== "archived"
  ).length;
  const waitingTaskCount = dashboard.tasks.filter(
    (task) => task.status === "waiting_user"
  ).length;
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
      setError(userFacingMessage(e, { context: "settings" }));
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
          if (
            selectedFindingId &&
            json.dashboard &&
            !json.dashboard.findings.some((finding) => finding.id === selectedFindingId)
          ) {
            setSelectedFindingId(null);
          }
          if (json.task) {
            setSelectedId(json.task.id);
            setDraft(draftFromTask(json.task));
          }
        } catch (e) {
          setError(userFacingMessage(e, { context: "settings" }));
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
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-panel)]">
        <div className="border-b border-[color:var(--border)] px-5 py-4">
          <Link
            href="/"
            className="mb-5 inline-flex items-center gap-2 text-token-ui text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
          >
            <ArrowLeft size={16} />
            返回应用
          </Link>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-token-title font-semibold">任务指挥台</h1>
              <p className="mt-1 text-token-ui leading-5 text-[color:var(--text-muted)]">
                把需要持续关注的工作交给 Agent，结果和阻塞点回到这里处理。
              </p>
            </div>
            <Button onClick={newTask} size="sm" variant="outline" leading={<Plus size={15} />}>
              新建
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-[color:var(--border)] p-3">
          <Metric label="活跃任务" value={activeTaskCount} />
          <Metric label="待处理" value={dashboard.inboxCount} tone="text-[color:var(--color-warning)]" />
          <Metric label="待运行" value={dashboard.dueTasks.length} tone="text-[color:var(--color-info)]" />
          <Metric label="需确认" value={waitingTaskCount} tone="text-[color:var(--color-warning)]" />
        </div>

        <div className="border-b border-[color:var(--border)] p-3">
          <SchedulerCard dashboard={dashboard} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <div className="text-token-xs font-semibold uppercase tracking-normal text-[color:var(--text-dim)]">
              任务队列
            </div>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="inline-flex items-center gap-1 text-token-xs text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
            >
              <RefreshCw size={12} />
              刷新
            </button>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3 text-token-ui text-[color:var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              正在加载任务…
            </div>
          ) : dashboard.tasks.length === 0 ? (
            <EmptyLine text="还没有任务。新建一个任务，让 Agent 按你的节奏持续检查。" />
          ) : (
            dashboard.tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => {
                  setSelectedId(task.id);
                  setDraft(draftFromTask(task));
                }}
                className={`mb-2 block w-full rounded-token border px-3 py-3 text-left transition-colors ${
                  selected?.id === task.id
                    ? "border-[color:var(--accent)] bg-[color:var(--bg-selected)]"
                    : "border-[color:var(--border-soft)] hover:bg-[color:var(--bg-hover)]"
                }`}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className={`mt-1 text-token-xs ${statusTone(task.status)}`}>●</span>
                  <span className="min-w-0 flex-1 truncate text-token-ui font-semibold">
                    {task.title}
                  </span>
                  <Badge tone={statusBadgeTone(task.status)} className="shrink-0">
                    {STATUS_LABEL[task.status]}
                  </Badge>
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-2 text-token-xs text-[color:var(--text-muted)]">
                  <span>{CADENCE_LABEL[task.cadence]}</span>
                  <span>·</span>
                  <span className="truncate">
                    {task.nextRunAt ? `下次 ${formatTime(task.nextRunAt)}` : "手动触发"}
                  </span>
                </div>
                {task.lastSummary || task.failureReason ? (
                  <div className="mt-2 line-clamp-2 text-token-xs leading-5 text-[color:var(--text-dim)]">
                    {task.failureReason || task.lastSummary}
                  </div>
                ) : null}
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--bg-panel)] px-6 py-4">
          <div className="min-w-0">
            <div className="text-token-ui text-[color:var(--text-muted)]">任务控制台</div>
            <div className="mt-0.5 truncate text-token-title font-semibold">
              {selected ? selected.title : "新建长期任务"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void loadAll()} type="button" variant="outline" leading={<RefreshCw size={15} />}>
              刷新
            </Button>
            {selected ? (
              <>
                <Button
                  variant="solid"
                  tone="accent"
                  onClick={() => taskAction({ type: "run", id: selected.id })}
                  disabled={isPending || selected.status === "running"}
                  type="button"
                  leading={
                    selected.status === "running" ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Play size={15} />
                    )
                  }
                >
                  立即运行
                </Button>
                <Button
                  variant="outline"
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
                  leading={<Pause size={15} />}
                >
                  {selected.status === "paused" ? "恢复" : "暂停"}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="border-b border-[color:var(--color-danger)] bg-[color:var(--color-danger-bg)] px-5 py-2 text-token-body text-[color:var(--color-danger)]">
            {error}
          </div>
        ) : null}

        {selected?.status === "waiting_user" ? (
          <div className="border-b border-[color:var(--color-warning)] bg-[color:var(--color-warning-bg)] px-5 py-3 text-token-body text-[color:var(--color-warning)]">
            <div className="font-medium">这个任务正在等待你决策</div>
            <div className="mt-1 text-[color:var(--color-warning)]">
              {selectedRuns[0]?.waitingReason ||
                selectedRuns[0]?.summary ||
                "请回到对应会话处理授权、确认或补充问题。"}
            </div>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] overflow-hidden">
          <div className="min-w-0 overflow-auto px-6 py-5">
            <section className="max-w-5xl">
              <TaskOverview
                selected={selected}
                draft={draft}
                latestRun={latestRun}
                selectedFindings={selectedFindings}
              />
            </section>

            <section className="mt-6 max-w-5xl">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-token-title font-semibold">布置任务</h2>
                  <p className="mt-1 text-token-ui text-[color:var(--text-muted)]">
                    用目标、节奏和安全边界定义 Agent 该如何持续工作。
                  </p>
                </div>
                <Button
                  variant="solid"
                  tone="accent"
                  type="button"
                  onClick={saveTask}
                  disabled={isPending}
                  leading={isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                >
                  保存任务
                </Button>
              </div>
              <div className="space-y-4">
                <TaskFormSection
                  index="1"
                  title="交代任务"
                  description="告诉 Agent 需要长期关注什么、什么时候汇报，以及哪些情况必须等你决策。"
                >
                  <div className="grid gap-4">
                    <Field label="任务名称">
                      <FieldInput
                        className="w-full"
                        value={draft.title}
                        onChange={(e) => setDraft((cur) => ({ ...cur, title: e.target.value }))}
                        placeholder="例如：每日检查 CI 和高优先级反馈"
                      />
                    </Field>
                    <Field label="任务目标">
                      <textarea
                        className="w-full resize-y rounded-[var(--field-radius)] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-token-body text-[color:var(--color-text)] outline-none placeholder:text-[color:var(--color-text-dim)] focus:border-[color:var(--color-accent)]"
                        style={{ minHeight: 150 }}
                        value={draft.prompt}
                        onChange={(e) => setDraft((cur) => ({ ...cur, prompt: e.target.value }))}
                        placeholder="告诉 Diga 需要持续关注什么、什么情况下需要汇报、什么时候等待你确认。"
                      />
                    </Field>
                    <Field label="工作目录">
                      <FieldInput
                        className="w-full"
                        value={draft.projectPath}
                        onChange={(e) =>
                          setDraft((cur) => ({ ...cur, projectPath: e.target.value }))
                        }
                        placeholder="/path/to/project"
                      />
                    </Field>
                  </div>
                </TaskFormSection>

                <TaskFormSection
                  index="2"
                  title="运行方式"
                  description="选择任务节奏和模型。手动任务适合一次性检查，定期任务适合持续盯进展。"
                >
                  <div className="grid grid-cols-3 gap-4">
                    <Field label="运行频率">
                      <SelectField
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
                      </SelectField>
                      <div className="mt-1 text-token-xs text-[color:var(--text-dim)]">
                        {CADENCE_HELP[draft.cadence]}
                      </div>
                    </Field>
                    <Field label="模型服务商">
                      <SelectField
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
                      </SelectField>
                    </Field>
                    <Field label="模型">
                      <SelectField
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
                      </SelectField>
                    </Field>
                  </div>
                </TaskFormSection>

                <TaskFormSection
                  index="3"
                  title="安全边界"
                  description="长期任务可以自己跑，但写文件、联网和长时间执行必须有清晰边界。"
                >
                  <div className="grid grid-cols-3 gap-3">
                    <ToggleField
                      icon={<ShieldCheck size={16} />}
                      title="写入前确认"
                      description="修改代码或文件前先等你允许。"
                      checked={draft.requireApprovalBeforeWrite}
                      onChange={(checked) =>
                        setDraft((cur) => ({
                          ...cur,
                          requireApprovalBeforeWrite: checked,
                        }))
                      }
                    />
                    <ToggleField
                      icon={<Network size={16} />}
                      title="联网前确认"
                      description="访问外部网络前先等你允许。"
                      checked={draft.requireApprovalBeforeNetwork}
                      onChange={(checked) =>
                        setDraft((cur) => ({
                          ...cur,
                          requireApprovalBeforeNetwork: checked,
                        }))
                      }
                    />
                    <Field label="最长运行">
                      <FieldInput
                        className="w-full"
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
                      <div className="mt-1 text-token-xs text-[color:var(--text-dim)]">
                        超时后任务会停止并留下运行记录。
                      </div>
                    </Field>
                  </div>
                </TaskFormSection>
              </div>
            </section>

            <section className="mt-8 max-w-5xl">
              <h2 className="mb-3 text-token-title font-semibold">运行历史</h2>
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
                <h2 className="text-token-title font-semibold">决策收件箱</h2>
                <p className="mt-1 text-token-xs text-[color:var(--text-muted)]">
                  只放需要你处理或确认的事项。
                </p>
              </div>
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] text-[color:var(--text-muted)]">
                <Inbox size={17} />
              </span>
            </div>
            <Button
              type="button"
              onClick={() => taskAction({ type: "run_due" })}
              className="mb-4 w-full"
              variant="outline"
              leading={<CalendarClock size={15} />}
            >
              运行到期任务
            </Button>
            {inbox.length === 0 ? (
              <EmptyLine text="当前没有需要你处理的新事项。" />
            ) : (
              <div className="space-y-3">
                {inbox.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    onOpen={() => setSelectedFindingId(finding.id)}
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
                <h3 className="mb-2 text-token-ui font-semibold">当前任务已处理事项</h3>
                <div className="space-y-2">
                  {selectedFindings
                    .filter((finding) => finding.status !== "unread")
                    .map((finding) => (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        compact
                        onOpen={() => setSelectedFindingId(finding.id)}
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

            {selectedFinding ? (
              <TaskReportPanel
                finding={selectedFinding}
                run={selectedFindingRun}
                task={selectedFindingTask}
                onClose={() => setSelectedFindingId(null)}
                onStatus={(status) =>
                  taskAction({
                    type: "finding_status",
                    id: selectedFinding.id,
                    status,
                  })
                }
              />
            ) : null}

            {selected ? (
              <Button
                type="button"
                onClick={() => {
                  taskAction({ type: "delete", id: selected.id });
                  newTask();
                }}
                className="mt-8 w-full"
                variant="outline"
                tone="danger"
                leading={<Trash2 size={15} />}
              >
                删除当前任务
              </Button>
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
    <div className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-2">
      <div className={`text-token-title font-semibold ${tone}`}>{value}</div>
      <div className="mt-0.5 text-token-xs text-[color:var(--text-muted)]">{label}</div>
    </div>
  );
}

function SchedulerCard({ dashboard }: { dashboard: LongTaskDashboard }) {
  const scheduler = dashboard.scheduler;
  const enabled = Boolean(scheduler?.enabled);
  const label = scheduler?.running
    ? "正在检查"
    : scheduler?.lastCheckedAt
      ? `上次 ${formatTime(scheduler.lastCheckedAt)}`
      : "待启动";
  return (
    <div className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-token-ui font-semibold">
            <ListChecks size={15} className="text-[color:var(--text-muted)]" />
            自动检查
          </div>
          <div className="mt-1 truncate text-token-xs text-[color:var(--text-muted)]">
            {label}
          </div>
        </div>
        <StatusPill tone={enabled ? "success" : "default"}>
          {enabled ? "已开启" : "未开启"}
        </StatusPill>
      </div>
      {scheduler?.lastError ? (
        <div className="mt-2 line-clamp-2 text-token-xs text-[color:var(--color-danger)]">
          {scheduler.lastError}
        </div>
      ) : null}
    </div>
  );
}

function TaskOverview({
  selected,
  draft,
  latestRun,
  selectedFindings,
}: {
  selected: LongTaskDefinition | null;
  draft: Draft;
  latestRun: LongTaskRun | null;
  selectedFindings: TaskFinding[];
}) {
  const openFindings = selectedFindings.filter((finding) => finding.status === "unread");
  const status = selected?.status ?? "idle";
  return (
    <div className="grid grid-cols-4 gap-3">
      <OverviewCard
        icon={<ClipboardCheck size={16} />}
        label="当前状态"
        title={selected ? STATUS_LABEL[status] : "正在布置"}
        tone={statusBadgeTone(status)}
        description={selected ? STATUS_HELP[status] : "保存后即可手动运行或按节奏执行。"}
      />
      <OverviewCard
        icon={<CalendarClock size={16} />}
        label="运行节奏"
        title={CADENCE_LABEL[draft.cadence]}
        description={
          selected?.nextRunAt
            ? `下次 ${formatTime(selected.nextRunAt)}`
            : CADENCE_HELP[draft.cadence]
        }
      />
      <OverviewCard
        icon={<AlertTriangle size={16} />}
        label="待处理"
        title={`${openFindings.length} 项`}
        tone={openFindings.length > 0 ? "warning" : "success"}
        description={openFindings.length > 0 ? "有结果需要你查看。" : "当前没有新的阻塞点。"}
      />
      <OverviewCard
        icon={<Clock3 size={16} />}
        label="最近运行"
        title={latestRun ? runStatusLabel(latestRun.status) : "尚未运行"}
        description={latestRun ? formatTime(latestRun.startedAt) : "运行后会生成报告和时间线。"}
      />
    </div>
  );
}

function OverviewCard({
  icon,
  label,
  title,
  description,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  description: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <div className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] text-[color:var(--text-muted)]">
          {icon}
        </span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div className="mt-3 text-token-title font-semibold">{title}</div>
      <p className="mt-1 line-clamp-2 text-token-xs leading-5 text-[color:var(--text-muted)]">
        {description}
      </p>
    </div>
  );
}

function TaskFormSection({
  index,
  title,
  description,
  children,
}: {
  index: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-surface-subtle)] text-token-xs font-semibold text-[color:var(--text-muted)]">
          {index}
        </span>
        <div className="min-w-0">
          <h3 className="text-token-body font-semibold">{title}</h3>
          <p className="mt-1 text-token-xs leading-5 text-[color:var(--text-muted)]">
            {description}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-token-ui font-medium text-[color:var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className="h-[var(--field-height)] w-full rounded-[var(--field-radius)] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 text-token-ui text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
      {...props}
    >
      {children}
    </select>
  );
}

function ToggleField({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-3" style={{ minHeight: 88 }}>
      <span className="text-[color:var(--text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-token-ui font-semibold">{title}</span>
        <span className="mt-1 block text-token-xs leading-5 text-[color:var(--text-muted)]">
          {description}
        </span>
      </span>
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
    <div className="rounded-token border border-dashed border-[color:var(--border-soft)] px-3 py-5 text-center text-token-ui text-[color:var(--text-muted)]">
      {text}
    </div>
  );
}

function RunRow({ run }: { run: LongTaskRun }) {
  return (
    <div className="flex items-start gap-3 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-3">
      <Clock3 size={16} className="mt-0.5 text-[color:var(--text-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-token-ui font-medium">
          <span>{runStatusLabel(run.status)}</span>
          <span className="text-token-xs text-[color:var(--text-muted)]">
            {formatTime(run.startedAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-token-ui leading-5 text-[color:var(--text-muted)]">
          {run.waitingReason ||
            run.summary ||
            run.error ||
            "正在执行，完成后会生成运行报告。"}
        </p>
        {run.checkpoints.length > 0 ? (
          <div className="mt-3 space-y-1.5 border-t border-[color:var(--border-soft)] pt-2">
            {run.checkpoints.slice(-4).map((checkpoint) => (
              <div
                key={checkpoint.id}
                className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-token-xs"
              >
                <span className="text-[color:var(--text-muted)]">
                  {formatTime(checkpoint.createdAt)}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{checkpoint.title}</span>
                  {checkpoint.detail ? (
                    <span className="ml-1 text-[color:var(--text-muted)]">
                      {checkpoint.detail}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {run.agentId ? (
        <Link
          className="shrink-0 rounded-token border border-[color:var(--border)] px-2 py-1 text-token-xs hover:bg-[color:var(--bg-hover)]"
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
  onOpen,
  onStatus,
}: {
  finding: TaskFinding;
  compact?: boolean;
  onOpen: () => void;
  onStatus: (status: TaskFindingStatus) => void;
}) {
  return (
    <div className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3">
      <div className="flex items-start gap-2">
        <Badge tone={findingTone(finding.severity)} className="shrink-0">
          {severityLabel(finding.severity)}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-token-ui font-semibold">{finding.title}</div>
          {!compact ? (
            <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-token-ui leading-6 text-[color:var(--text-muted)]">
              {finding.body}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={onOpen} type="button">
          查看报告
        </Button>
        {finding.status === "unread" ? (
          <>
            <Button size="xs" variant="outline" onClick={() => onStatus("reviewed")} type="button">
              已读
            </Button>
            <Button size="xs" variant="outline" onClick={() => onStatus("resolved")} type="button">
              已解决
            </Button>
          </>
        ) : null}
        <Button size="xs" variant="outline" onClick={() => onStatus("archived")} type="button" leading={<Archive size={13} />}>
          归档
        </Button>
      </div>
    </div>
  );
}

function TaskReportPanel({
  finding,
  run,
  task,
  onClose,
  onStatus,
}: {
  finding: TaskFinding;
  run?: LongTaskRun | null;
  task?: LongTaskDefinition | null;
  onClose: () => void;
  onStatus: (status: TaskFindingStatus) => void;
}) {
  const checkpoints = run?.checkpoints ?? [];
  return (
    <section
      data-testid="task-report-panel"
      className="mt-6 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-4"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-token-xs font-medium text-[color:var(--text-muted)]">
            任务报告详情
          </div>
          <h3 className="mt-1 text-token-body font-semibold leading-6">{finding.title}</h3>
        </div>
        <Button
          type="button"
          onClick={onClose}
          size="xs"
          variant="outline"
          className="shrink-0"
        >
          收起
        </Button>
      </div>

      <div className="space-y-3 text-token-ui">
        <div className="grid grid-cols-2 gap-2 text-token-xs text-[color:var(--text-muted)]">
          <div className="rounded-token border border-[color:var(--border-soft)] px-2 py-2">
            <div>关联任务</div>
            <div className="mt-1 truncate font-medium text-[color:var(--text)]">
              {task?.title ?? finding.taskId}
            </div>
          </div>
          <div className="rounded-token border border-[color:var(--border-soft)] px-2 py-2">
            <div>运行状态</div>
            <div className="mt-1 font-medium text-[color:var(--text)]">
              {run ? runStatusLabel(run.status) : "未找到运行记录"}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1 text-token-xs font-medium text-[color:var(--text-muted)]">
            报告内容
          </div>
          <div className="whitespace-pre-wrap rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2 leading-6">
            {finding.body}
          </div>
        </div>

        {run?.summary || run?.waitingReason || run?.error ? (
          <div>
            <div className="mb-1 text-token-xs font-medium text-[color:var(--text-muted)]">
              本次运行结论
            </div>
            <div className="whitespace-pre-wrap rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] px-3 py-2 leading-6">
              {run.waitingReason || run.summary || run.error}
            </div>
          </div>
        ) : null}

        <div>
          <div className="mb-1 text-token-xs font-medium text-[color:var(--text-muted)]">
            执行时间线
          </div>
          {checkpoints.length === 0 ? (
            <EmptyLine text="这个报告没有 checkpoint 记录。" />
          ) : (
            <div className="space-y-2 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] p-3">
              {checkpoints.map((checkpoint) => (
                <div
                  key={checkpoint.id}
                  className="grid grid-cols-[86px_minmax(0,1fr)] gap-2 text-token-xs"
                >
                  <span className="text-[color:var(--text-muted)]">
                    {formatTime(checkpoint.createdAt)}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium">{checkpoint.title}</span>
                    {checkpoint.detail ? (
                      <span className="ml-1 text-[color:var(--text-muted)]">
                        {checkpoint.detail}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {finding.status === "unread" ? (
          <>
            <Button size="xs" variant="outline" type="button" onClick={() => onStatus("reviewed")}>
              标记已读
            </Button>
            <Button size="xs" variant="outline" type="button" onClick={() => onStatus("resolved")}>
              标记已解决
            </Button>
          </>
        ) : null}
        <Button size="xs" variant="outline" type="button" onClick={() => onStatus("archived")} leading={<Archive size={13} />}>
          归档
        </Button>
        {run?.sessionFile ? (
          <Link
            className="inline-flex h-[var(--control-xs)] items-center justify-center rounded-[var(--button-radius)] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-token-xs font-medium hover:bg-[color:var(--color-surface-hover)]"
            href="/"
          >
            查看会话
          </Link>
        ) : null}
      </div>
    </section>
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
