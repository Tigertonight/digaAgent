import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function usage() {
  return `Usage:
  node scripts/agent-team-validation-summary.mjs [--run <teamId>] [--root <digaRoot>] [--out <file>] [--strict]
  node scripts/agent-team-validation-summary.mjs --list [--root <digaRoot>] [--limit <n>]

Reads a persisted Agent Team run and writes a redacted validation summary.
Default root: ~/.diga-agent
Default run: newest JSON file under agent-teams/runs
`;
}

function parseArgs(argv) {
  const args = {
    root: path.join(os.homedir(), ".diga-agent"),
    runId: "",
    out: "",
    strict: false,
    list: false,
    limit: 20,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (item === "--strict") {
      args.strict = true;
      continue;
    }
    if (item === "--list") {
      args.list = true;
      continue;
    }
    if (item === "--root" || item === "--run" || item === "--out" || item === "--limit") {
      const next = argv[i + 1];
      if (!next) throw new Error(`${item} requires a value`);
      i += 1;
      if (item === "--root") args.root = next;
      if (item === "--run") args.runId = next;
      if (item === "--out") args.out = next;
      if (item === "--limit") {
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
        args.limit = parsed;
      }
      continue;
    }
    throw new Error(`unknown argument: ${item}`);
  }
  return args;
}

function runsDir(root) {
  return path.join(root, "agent-teams", "runs");
}

function listRunFiles(root) {
  const dir = runsDir(root);
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const filePath = path.join(dir, file);
      return { file, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function loadRun(root, runId) {
  const files = listRunFiles(root);
  if (files.length === 0) {
    throw new Error(`no Agent Team runs found under ${runsDir(root)}`);
  }
  const selected = runId
    ? files.find((item) => item.file === `${runId}.json`)
    : files[0];
  if (!selected) {
    throw new Error(`Agent Team run ${runId} not found under ${runsDir(root)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(selected.filePath, "utf8"));
  const run = parsed?.kind === "agent-team-run" ? parsed.run : parsed;
  if (!run || typeof run !== "object" || typeof run.id !== "string") {
    throw new Error(`invalid Agent Team run file: ${selected.filePath}`);
  }
  return { run, filePath: selected.filePath };
}

function loadRunFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const run = parsed?.kind === "agent-team-run" ? parsed.run : parsed;
  if (!run || typeof run !== "object" || typeof run.id !== "string") {
    throw new Error(`invalid Agent Team run file: ${filePath}`);
  }
  return run;
}

function countBy(items, fn) {
  const out = new Map();
  for (const item of items ?? []) {
    const key = fn(item);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

function mapToInline(map) {
  if (!map.size) return "none";
  return [...map.entries()]
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

function hasOpenWorktree(run) {
  return (run.members ?? []).some(
    (member) =>
      member?.worktree?.status === "active" ||
      member?.worktree?.status === "merge_pending"
  );
}

function hasMissingMember(run) {
  return (run.members ?? []).some(
    (member) =>
      member?.hydrateState === "missing" ||
      member?.status === "blocked" && String(member?.latestOutput ?? "").includes("Session")
  );
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function evaluate(run) {
  const board = run.board ?? {};
  const tasks = board.tasks ?? [];
  const required = tasks.filter((task) => task.required !== false);
  const requiredComplete =
    required.length > 0 && required.every((task) => task.status === "completed");
  const openChallenges = (board.challenges ?? []).filter(
    (challenge) => challenge.status === "open"
  );
  const decisions = board.decisions ?? [];
  const results = board.results ?? [];
  const findings = board.findings ?? [];
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const coordinationAudit = run.coordinationAudit ?? [];
  const decisionTraceable = decisions.some(
    (decision) => {
      const acceptedFindingIds = decision.acceptedFindingIds ?? [];
      const sourceResultIds = decision.sourceResultIds ?? [];
      if (!nonEmptyArray(acceptedFindingIds) || !nonEmptyArray(sourceResultIds)) {
        return false;
      }
      if (nonEmptyArray(decision.evidenceRefs)) return true;
      const sourceResultHasEvidence = sourceResultIds.some((id) =>
        nonEmptyArray(resultsById.get(id)?.evidenceRefs)
      );
      if (sourceResultHasEvidence) return true;
      return acceptedFindingIds.some((id) =>
        nonEmptyArray(findingsById.get(id)?.evidenceRefs)
      );
    }
  );
  const resultWithEvidence = results.some((result) => nonEmptyArray(result.evidenceRefs));
  const findingWithEvidence = findings.some((finding) => nonEmptyArray(finding.evidenceRefs));
  const coordinationUsed = coordinationAudit.some((call) =>
    String(call.toolName ?? "").startsWith("team_")
  );
  const openWorktree = hasOpenWorktree(run);
  const missingMember = hasMissingMember(run);

  return [
    {
      id: "required_tasks_complete",
      label: "Required tasks complete",
      ok: requiredComplete,
      detail: `${required.filter((task) => task.status === "completed").length}/${required.length}`,
    },
    {
      id: "coordination_tools_used",
      label: "Teammate coordination tools used",
      ok: coordinationUsed,
      detail: mapToInline(countBy(coordinationAudit, (call) => call.toolName ?? "unknown")),
    },
    {
      id: "results_with_evidence",
      label: "Results include evidence refs",
      ok: resultWithEvidence,
      detail: `${results.length} result(s)`,
    },
    {
      id: "findings_with_evidence",
      label: "Findings include evidence refs",
      ok: findingWithEvidence,
      detail: `${findings.length} finding(s)`,
    },
    {
      id: "no_open_challenges",
      label: "No open blocking challenges",
      ok: openChallenges.length === 0,
      detail: `${openChallenges.length} open`,
    },
    {
      id: "traceable_decision",
      label: "Final decision is traceable",
      ok: decisionTraceable,
      detail: `${decisions.length} decision(s)`,
    },
    {
      id: "worktrees_closed",
      label: "No active or pending worktrees",
      ok: !openWorktree,
      detail: mapToInline(countBy(run.members ?? [], (member) => member?.worktree?.status ?? "none")),
    },
    {
      id: "no_missing_teammates",
      label: "No missing teammate sessions",
      ok: !missingMember,
      detail: mapToInline(countBy(run.members ?? [], (member) => member?.hydrateState ?? "intact")),
    },
  ];
}

function redactPath(value) {
  if (!value || typeof value !== "string") return "";
  const home = os.homedir();
  if (value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}

function renderMarkdown(run, filePath, checks) {
  const board = run.board ?? {};
  const taskStatuses = countBy(board.tasks ?? [], (task) => task.status ?? "unknown");
  const memberStatuses = countBy(run.members ?? [], (member) => member.status ?? "unknown");
  const worktreeStatuses = countBy(run.members ?? [], (member) => member?.worktree?.status ?? "none");
  const toolCounts = countBy(run.coordinationAudit ?? [], (call) => call.toolName ?? "unknown");
  const gateStatuses = countBy(board.qualityGates ?? [], (gate) => gate.status ?? "unknown");
  const passCount = checks.filter((check) => check.ok).length;

  const lines = [];
  lines.push("# Agent Team Real Model Validation Summary");
  lines.push("");
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Run file: \`${redactPath(filePath)}\``);
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push(`- id: \`${run.id}\``);
  lines.push(`- status: \`${run.status}\``);
  lines.push(`- leadState: \`${run.leadState ?? "unknown"}\``);
  lines.push(`- memberScale: \`${run.settings?.memberScale ?? "unknown"}\``);
  lines.push(`- coordinationProfile: \`${run.settings?.coordinationProfile ?? "unknown"}\``);
  lines.push(`- worktreePolicy: \`${run.settings?.worktreePolicy ?? "unknown"}\``);
  lines.push(`- requirePlanApproval: \`${run.settings?.requirePlanApproval === true}\``);
  lines.push("");
  lines.push("Objective is intentionally omitted from this summary to avoid copying user content.");
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(`- members: ${(run.members ?? []).length} (${mapToInline(memberStatuses)})`);
  lines.push(`- tasks: ${(board.tasks ?? []).length} (${mapToInline(taskStatuses)})`);
  lines.push(`- results: ${(board.results ?? []).length}`);
  lines.push(`- findings: ${(board.findings ?? []).length}`);
  lines.push(`- challenges: ${(board.challenges ?? []).length}`);
  lines.push(`- decisions: ${(board.decisions ?? []).length}`);
  lines.push(`- coordination calls: ${(run.coordinationAudit ?? []).length} (${mapToInline(toolCounts)})`);
  lines.push(`- quality gates: ${(board.qualityGates ?? []).length} (${mapToInline(gateStatuses)})`);
  lines.push(`- worktrees: ${mapToInline(worktreeStatuses)}`);
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push(`Passed ${passCount}/${checks.length} checks.`);
  lines.push("");
  lines.push("| Check | Status | Detail |");
  lines.push("| --- | --- | --- |");
  for (const check of checks) {
    lines.push(`| ${check.label} | ${check.ok ? "pass" : "needs review"} | ${check.detail} |`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- This file is a redacted summary. It does not include raw teammate output, user prompts, or result bodies.");
  lines.push("- Keep full run JSON, screenshots, and videos outside the repository unless they are manually redacted.");
  return `${lines.join("\n")}\n`;
}

function renderRunList(root, limit) {
  const rows = listRunFiles(root).map((file) => {
    const run = loadRunFile(file.filePath);
    const checks = evaluate(run);
    const passed = checks.filter((check) => check.ok).length;
    const failed = checks.filter((check) => !check.ok).map((check) => check.id);
    return {
      id: run.id,
      mtime: new Date(file.mtimeMs).toISOString(),
      status: run.status ?? "unknown",
      leadState: run.leadState ?? "unknown",
      memberScale: run.settings?.memberScale ?? "unknown",
      score: `${passed}/${checks.length}`,
      failed: failed.length > 0 ? failed.join(",") : "none",
    };
  });
  rows.sort((a, b) => {
    const scoreDiff = Number(b.score.split("/")[0]) - Number(a.score.split("/")[0]);
    if (scoreDiff !== 0) return scoreDiff;
    return b.mtime.localeCompare(a.mtime);
  });
  const lines = [];
  lines.push("# Agent Team Validation Candidates");
  lines.push("");
  lines.push(`Root: \`${redactPath(runsDir(root))}\``);
  lines.push("");
  lines.push("| Score | Status | Lead | Scale | Missing checks | Run id | Updated |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows.slice(0, limit)) {
    lines.push(
      `| ${row.score} | ${row.status} | ${row.leadState} | ${row.memberScale} | ${row.failed} | \`${row.id}\` | ${row.mtime} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    const markdown = renderRunList(args.root, args.limit);
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, markdown, "utf8");
    } else {
      process.stdout.write(markdown);
    }
    return;
  }
  const { run, filePath } = loadRun(args.root, args.runId);
  const checks = evaluate(run);
  const markdown = renderMarkdown(run, filePath, checks);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
  if (args.strict && checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage());
  process.exit(2);
}
