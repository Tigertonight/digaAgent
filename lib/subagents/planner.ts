import type { SubagentRole } from "./types";

export interface SubagentPlannerTask {
  id: string;
  title: string;
  prompt: string;
  role?: SubagentRole;
}

export interface SubagentPlannerSpecialistHint {
  id: string;
  title: string;
  description: string;
}

export interface SubagentPlannerInput {
  goal: string;
  candidateTasks?: Array<{
    id?: string;
    title?: string;
    prompt?: string;
    role?: SubagentRole;
  }>;
  /** Registered specialists discoverable for this request (Sprint 2 hints). */
  availableSpecialists?: SubagentPlannerSpecialistHint[];
}

export interface SubagentPlannerRecommendation {
  mode: "single-agent" | "multi-agent";
  confidence: number;
  reason: string;
  signals: string[];
  taskCount: number;
  suggestedConcurrency: number;
  tasks: SubagentPlannerTask[];
  /** Specialists the main agent may assign via task.specialistId. */
  availableSpecialists: SubagentPlannerSpecialistHint[];
}

const EXPLICIT_MULTI_AGENT_PATTERN =
  /subagent|multi[- ]?agent|多\s*agent|子\s*agent|并行|并发|分批|批量|每个.*(问题|文档|模块|文件|竞品|制度)|逐个|分别/i;
const RESEARCH_PATTERN = /调研|竞品|对比|review|审查|分析.*(多个|多份|多项)|RAG|知识库|制度问答/i;
const CODE_SPLIT_PATTERN = /模块|文件|目录|packages?|components?|hooks?|api|routes?/i;
const WRITE_PATTERN = /实现|修改|编辑|修复|patch|write|edit/i;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function scoreFromSignals(signals: string[], taskCount: number): number {
  let score = 0.25;
  if (taskCount >= 2) score += 0.2;
  if (taskCount >= 4) score += 0.2;
  if (signals.includes("explicit-multi-agent-intent")) score += 0.25;
  if (signals.includes("batch-or-research-work")) score += 0.12;
  if (signals.includes("module-or-file-split")) score += 0.12;
  if (signals.includes("write-work-needs-boundaries")) score -= 0.08;
  return Math.round(clamp(score, 0.05, 0.95) * 100) / 100;
}

function normalizeRole(value: unknown): SubagentRole | undefined {
  return value === "general" ||
    value === "rag" ||
    value === "research" ||
    value === "code-review" ||
    value === "implementation"
    ? value
    : undefined;
}

function inferRole(text: string): SubagentRole {
  if (/RAG|知识库|制度|来源|引用|文档/i.test(text)) return "rag";
  if (/代码|review|审查|bug|风险|模块|文件/i.test(text)) return "code-review";
  if (/调研|竞品|搜索|资料|对比/i.test(text)) return "research";
  if (WRITE_PATTERN.test(text)) return "implementation";
  return "general";
}

function taskFromLine(
  line: string,
  index: number,
  contextRole?: SubagentRole
): SubagentPlannerTask | null {
  const text = line
    .replace(/^\s*(?:[-*•]|\d+[.)、]|[A-Z][.)])\s*/, "")
    .trim();
  if (text.length < 4) return null;
  return {
    id: `task-${index + 1}`,
    title: text.slice(0, 80),
    prompt: text,
    role: contextRole ?? inferRole(text),
  };
}

function parseTasksFromGoal(goal: string): SubagentPlannerTask[] {
  const contextRole = /制度|知识库|RAG|来源|引用|文档/i.test(goal)
    ? "rag"
    : undefined;
  const lines = goal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marked = lines
    .filter((line) => /^\s*(?:[-*•]|\d+[.)、]|[A-Z][.)])\s+/.test(line))
    .map((line, index) => taskFromLine(line, index, contextRole))
    .filter((task): task is SubagentPlannerTask => Boolean(task));
  if (marked.length > 0) return marked.slice(0, 32);

  const questionParts = goal
    .split(/[？?]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
  if (questionParts.length >= 2) {
    return questionParts.slice(0, 32).map((part, index) => ({
      id: `q${index + 1}`,
      title: part.slice(0, 80),
      prompt: `${part}?`,
      role: contextRole ?? inferRole(part),
    }));
  }
  return [];
}

function normalizeCandidateTasks(
  input: SubagentPlannerInput
): SubagentPlannerTask[] {
  const candidates = input.candidateTasks ?? [];
  if (candidates.length > 0) {
    const out: SubagentPlannerTask[] = [];
    for (const [index, task] of candidates.entries()) {
      const prompt = (task.prompt ?? task.title ?? "").trim();
      if (!prompt) continue;
      out.push({
        id: task.id?.trim() || `task-${index + 1}`,
        title: (task.title?.trim() || prompt).slice(0, 80),
        prompt,
        role: normalizeRole(task.role) ?? inferRole(prompt),
      });
      if (out.length >= 32) break;
    }
    return out;
  }
  return parseTasksFromGoal(input.goal);
}

export function planSubagents(
  input: SubagentPlannerInput
): SubagentPlannerRecommendation {
  const goal = input.goal.trim();
  const tasks = normalizeCandidateTasks(input);
  const signals: string[] = [];
  if (EXPLICIT_MULTI_AGENT_PATTERN.test(goal)) {
    signals.push("explicit-multi-agent-intent");
  }
  if (RESEARCH_PATTERN.test(goal)) signals.push("batch-or-research-work");
  if (CODE_SPLIT_PATTERN.test(goal)) signals.push("module-or-file-split");
  if (WRITE_PATTERN.test(goal)) signals.push("write-work-needs-boundaries");
  if (tasks.length >= 2) signals.push("multiple-independent-items");
  if (tasks.length >= 4) signals.push("large-fanout");

  const confidence = scoreFromSignals(signals, tasks.length);
  const mode =
    confidence >= 0.62 && (tasks.length >= 2 || signals.includes("explicit-multi-agent-intent"))
      ? "multi-agent"
      : "single-agent";
  const suggestedConcurrency =
    mode === "multi-agent" ? clamp(Math.min(tasks.length || 4, 4), 1, 4) : 1;
  const reason =
    mode === "multi-agent"
      ? "The goal has enough independent work items or explicit multi-agent intent to justify delegated subagents."
      : "The goal does not yet show enough independent subtasks for subagent fan-out.";

  return {
    mode,
    confidence,
    reason,
    signals,
    taskCount: tasks.length,
    suggestedConcurrency,
    tasks,
    availableSpecialists: input.availableSpecialists ?? [],
  };
}
