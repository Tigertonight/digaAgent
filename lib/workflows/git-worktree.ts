import "server-only";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkflowWorktree, WorkflowWorktreeManager } from "./types";

const execFileAsync = promisify(execFile);

function cleanSegment(raw: string | undefined, fallback: string): string {
  const cleaned = (raw || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function gitAllowFailure(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out`));
    }, 30000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `git ${args.join(" ")} exited ${code}`));
    });
    child.stdin.end(input);
  });
}

async function worktreePatch(worktree: WorkflowWorktree): Promise<{
  diff: string;
  stat: string;
}> {
  // Mark untracked files as intent-to-add so `git diff HEAD` includes them
  // without actually staging content for commit.
  await gitAllowFailure(worktree.path, ["add", "-N", "."]);
  const [diff, stat] = await Promise.all([
    git(worktree.path, ["diff", "--binary", "HEAD", "--"]),
    git(worktree.path, ["diff", "--stat", "HEAD", "--"]),
  ]);
  return { diff, stat };
}

export function createGitWorktreeManager(cwd: string): WorkflowWorktreeManager {
  return {
    async create(input) {
      const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
      const workflowSegment = cleanSegment(input.workflowId.slice(0, 8), "workflow");
      const nameSegment = cleanSegment(input.name, "worktree");
      const baseRef = input.baseRef?.trim() || "HEAD";
      const baseDir = path.join(os.tmpdir(), "diga-agent-worktrees");
      await mkdir(baseDir, { recursive: true });
      const dirPrefix = path.join(baseDir, `${path.basename(root)}-${workflowSegment}-${nameSegment}-`);
      const worktreePath = await mkdtemp(dirPrefix);
      const branchName = `diga-agent-workflow/${workflowSegment}/${nameSegment}`;
      await git(root, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
      return {
        id: `${workflowSegment}-${nameSegment}`,
        path: worktreePath,
        branchName,
        baseRef,
        createdAt: Date.now(),
      };
    },

    async diff(worktree: WorkflowWorktree) {
      const { diff, stat } = await worktreePatch(worktree);
      return {
        worktreeId: worktree.id,
        path: worktree.path,
        branchName: worktree.branchName,
        baseRef: worktree.baseRef,
        diff,
        stat,
        createdAt: Date.now(),
      };
    },

    async merge(worktree: WorkflowWorktree) {
      const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
      const { diff, stat } = await worktreePatch(worktree);
      if (!diff.trim()) {
        return {
          worktreeId: worktree.id,
          path: worktree.path,
          branchName: worktree.branchName,
          mergedAt: Date.now(),
          applied: false,
          summary: "No diff to apply.",
        };
      }
      await gitWithInput(root, ["apply", "--3way", "--whitespace=nowarn", "-"], diff);
      return {
        worktreeId: worktree.id,
        path: worktree.path,
        branchName: worktree.branchName,
        mergedAt: Date.now(),
        applied: true,
        summary: stat || "Patch applied to main working tree.",
      };
    },

    async remove(worktree: WorkflowWorktree) {
      const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
      await git(root, ["worktree", "remove", "--force", worktree.path]);
      await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
