import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import {
  abortSubagentsForParent,
  abortWorkflowsForParent,
  getAgent,
  retryWorkflowScriptForParent,
} from "@/lib/agent-registry";
import { buildWorkflowDebugBundle } from "@/lib/workflows/debug-bundle";
import { createGitWorktreeManager } from "@/lib/workflows/git-worktree";
import {
  getWorkflowRun,
  listWorkflowRuns,
  putWorkflowArtifact,
  workflowResumeSnapshot,
} from "@/lib/workflows/server-store";
import type { WorkflowWorktree } from "@/lib/workflows/types";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// F12：workflow 历史是持久化存储，不应该依赖 live agent registry。
// 如果重启 / 版本更新后 in-memory agent 丢失，历史 workflow 还在 server-store 里，
// 只要 parentAgentId 匹配，GET 仍然返回。注意：这里仍需远程鉴权。
export const GET = withRemoteAuth(async function (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const workflowId = url.searchParams.get("id") ?? url.searchParams.get("workflowId");
  const debug = url.searchParams.get("debug") === "1";
  if (workflowId) {
    const workflow = getWorkflowRun(workflowId);
    if (!workflow || workflow.parentAgentId !== id) {
      return NextResponse.json({ error: "workflow not found" }, { status: 404 });
    }
    if (debug) {
      return NextResponse.json({
        debugBundle: buildWorkflowDebugBundle(workflow),
      });
    }
    return NextResponse.json({
      workflow,
      resume: workflowResumeSnapshot(workflow),
    });
  }
  const workflows = listWorkflowRuns(id);
  return NextResponse.json({
    workflows,
    resumes: workflows.map(workflowResumeSnapshot),
  });
});

export const POST = withRemoteAuth(async function (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const type = body.type as string | undefined;
  if (type === "abort") {
    await abortWorkflowsForParent(id);
    await abortSubagentsForParent(id);
    return NextResponse.json({ ok: true });
  }

  if (type === "retry_workflow_script") {
    const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
    if (!workflowId) {
      return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
    }
    try {
      const result = await retryWorkflowScriptForParent(id, workflowId);
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }

  if (type === "retry_merge_worktree" || type === "cleanup_worktree") {
    const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
    const workflow = workflowId ? getWorkflowRun(workflowId) : undefined;
    if (!workflow || workflow.parentAgentId !== id) {
      return NextResponse.json({ error: "workflow not found" }, { status: 404 });
    }
    const worktree = parseWorkflowWorktree(body.worktree);
    if (!worktree || !isSafeWorkflowWorktreePath(worktree.path)) {
      return NextResponse.json(
        { error: "valid workflow worktree metadata is required" },
        { status: 400 }
      );
    }
    // F11：验证该 worktree 是该 workflow 创建的 artifact。
    // 创建时 script-runtime 会 putWorkflowArtifact(workflowId, { name: `worktree:${id}`, value: <metadata>, ... })。
    // 这里要求 artifact 名匹配 且 value.path 与传入 worktree.path 一致。
    const ownerArtifact = workflow.artifacts.find(
      (a) => a.name === `worktree:${worktree.id}`
    );
    if (!ownerArtifact) {
      return NextResponse.json(
        {
          error: `worktree ${worktree.id} is not part of workflow ${workflowId}`,
        },
        { status: 403 }
      );
    }
    const artifactValue = ownerArtifact.value as
      | { path?: unknown; branchName?: unknown }
      | null;
    if (
      !artifactValue ||
      typeof artifactValue.path !== "string" ||
      artifactValue.path !== worktree.path ||
      typeof artifactValue.branchName !== "string" ||
      artifactValue.branchName !== worktree.branchName
    ) {
      return NextResponse.json(
        {
          error: `worktree metadata mismatch with original workflow artifact`,
        },
        { status: 403 }
      );
    }
    const manager = createGitWorktreeManager(rec.cwd);
    try {
      if (type === "retry_merge_worktree") {
        const result = await manager.merge?.(worktree);
        if (!result) {
          return NextResponse.json(
            { error: "worktree merge runtime is not available" },
            { status: 500 }
          );
        }
        const artifact = {
          name: `worktree-manual-merge:${worktree.id}`,
          value: result,
          createdAt: result.mergedAt,
        };
        putWorkflowArtifact(workflowId, artifact);
        return NextResponse.json({ ok: true, result, artifact });
      }
      await manager.remove?.(worktree);
      const artifact = {
        name: `worktree-cleanup:${worktree.id}`,
        value: {
          worktreeId: worktree.id,
          path: worktree.path,
          branchName: worktree.branchName,
          baseRef: worktree.baseRef,
          cleanedAt: Date.now(),
        },
        createdAt: Date.now(),
      };
      putWorkflowArtifact(workflowId, artifact);
      return NextResponse.json({ ok: true, artifact });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }

  {
    return NextResponse.json(
      { error: `unknown action: ${type ?? "(missing)"}` },
      { status: 400 }
    );
  }
});

function parseWorkflowWorktree(raw: unknown): WorkflowWorktree | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  const pathValue = typeof obj.path === "string" ? obj.path : "";
  const branchName = typeof obj.branchName === "string" ? obj.branchName : "";
  const baseRef = typeof obj.baseRef === "string" ? obj.baseRef : "HEAD";
  if (!id || !pathValue || !branchName) return null;
  return {
    id,
    path: pathValue,
    branchName,
    baseRef,
    createdAt:
      typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt)
        ? obj.createdAt
        : Date.now(),
  };
}

function isSafeWorkflowWorktreePath(rawPath: string): boolean {
  const resolved = path.resolve(rawPath);
  const root = path.resolve(os.tmpdir(), "diga-agent-worktrees");
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
