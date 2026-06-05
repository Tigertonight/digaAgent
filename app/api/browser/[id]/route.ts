import { NextResponse } from "next/server";
import { getAgent, pushExternalEvent } from "@/lib/agent-registry";
import {
  addBrowserAnnotation,
  browserBringToFront,
  browserClick,
  browserClickText,
  browserClose,
  browserExtract,
  browserFill,
  browserInput,
  browserOpen,
  browserRefresh,
  browserScreenshot,
  browserType,
  browserVerify,
  browserWaitFor,
  clearBrowserAnnotations,
  closeAllBrowsers,
  completeInAppBrowserCommand,
  getBrowserSnapshot,
  getScreencastFrame,
  isBrowserHeadless,
  pollInAppBrowserCommand,
  registerInAppBrowserHost,
  removeBrowserAnnotation,
  setBrowserAnnotationStatus,
  startScreencast,
  type BrowserInputAction,
  type InAppBrowserCommandResult,
} from "@/lib/browser/runtime";
import { agentIdFromBrowserId } from "@/lib/browser/browser-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json({
    snapshot: getBrowserSnapshot(id),
    headless: isBrowserHeadless(),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // browserId 解耦 agentId：只有 agent:<id>（或向后兼容的裸 agentId）才推 SSE；
  // standalone:/task: 域只返回 snapshot 给 BrowserPanel 本地 state。
  const ownerAgentId = agentIdFromBrowserId(id);
  const rec = ownerAgentId ? getAgent(ownerAgentId) : null;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = body.type as string | undefined;
  try {
    if (type === "open") {
      const url = body.url as string | undefined;
      if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });
      const { snapshot } = await browserOpen(id, url);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "screenshot") {
      const { snapshot } = await browserScreenshot(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "refresh") {
      const snapshot = await browserRefresh(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "close") {
      const snapshot = await browserClose(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "close_all") {
      // 兜底：关闭所有 agent 的浏览器（清理残留窗口）
      const closed = await closeAllBrowsers();
      const snapshot = getBrowserSnapshot(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, closed, snapshot });
    }

    // ===== Structured browser tools over the in-app host / fallback runtime =====
    if (type === "click") {
      const selector = typeof body.selector === "string" ? body.selector : undefined;
      const x = typeof body.x === "number" ? body.x : undefined;
      const y = typeof body.y === "number" ? body.y : undefined;
      const { snapshot } = await browserClick(id, { selector, x, y });
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "click_text") {
      const text = typeof body.text === "string" ? body.text : "";
      if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
      const { snapshot } = await browserClickText(id, {
        text,
        exact: body.exact === true,
      });
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "fill" || type === "type") {
      const text = typeof body.text === "string" ? body.text : "";
      const selector = typeof body.selector === "string" ? body.selector : undefined;
      const pressEnter = body.pressEnter === true;
      const runner = type === "fill" ? browserFill : browserType;
      const { snapshot } = await runner(id, { text, selector, pressEnter });
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "wait_for") {
      const { snapshot } = await browserWaitFor(id, {
        url: typeof body.url === "string" ? body.url : undefined,
        selector: typeof body.selector === "string" ? body.selector : undefined,
        text: typeof body.text === "string" ? body.text : undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "extract") {
      const { result, snapshot } = await browserExtract(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, result, snapshot });
    }
    if (type === "verify") {
      const expectation =
        typeof body.expectation === "string" ? body.expectation : "";
      if (!expectation) {
        return NextResponse.json({ error: "expectation required" }, { status: 400 });
      }
      const { result, snapshot } = await browserVerify(id, {
        expectation,
        selector: typeof body.selector === "string" ? body.selector : undefined,
        text: typeof body.text === "string" ? body.text : undefined,
      });
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, result, snapshot });
    }

    // ===== Electron in-app browser host =====
    // BrowserPanel owns the real <webview>; server-side browser_* tools enqueue
    // commands here so the agent controls the page inside the app instead of
    // launching a separate Playwright Chromium window.
    if (type === "host_register") {
      const snapshot = registerInAppBrowserHost(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "host_poll") {
      const { command, snapshot } = pollInAppBrowserCommand(id);
      return NextResponse.json({ ok: true, command, snapshot });
    }
    if (type === "host_complete") {
      const commandId = body.commandId as string | undefined;
      if (!commandId) {
        return NextResponse.json(
          { error: "commandId required" },
          { status: 400 }
        );
      }
      const result = (body.result ?? {}) as InAppBrowserCommandResult;
      const snapshot = completeInAppBrowserCommand(id, commandId, result);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }

    // ===== 方案 Y：实时画面 + 接管 =====
    if (type === "screencast_start") {
      const frame = await startScreencast(id);
      return NextResponse.json({ ok: true, frame });
    }
    if (type === "screencast_frame") {
      // 前端轮询：带上已知 seq，后端只在有更新时回传帧数据，省带宽
      const knownSeq = typeof body.seq === "number" ? (body.seq as number) : -1;
      const frame = await getScreencastFrame(id);
      if (!frame) return NextResponse.json({ ok: true, frame: null });
      if (frame.seq === knownSeq) {
        return NextResponse.json({ ok: true, unchanged: true, seq: frame.seq });
      }
      return NextResponse.json({ ok: true, frame });
    }
    if (type === "input") {
      const action = body.action as BrowserInputAction | undefined;
      if (!action || typeof action.kind !== "string") {
        return NextResponse.json({ error: "action required" }, { status: 400 });
      }
      await browserInput(id, action);
      return NextResponse.json({ ok: true });
    }
    if (type === "bring_to_front") {
      const shown = await browserBringToFront(id);
      return NextResponse.json({ ok: true, shown, headless: isBrowserHeadless() });
    }

    // ===== 阶段 D：页面批注 =====
    if (type === "annotate") {
      const rect = body.rect as
        | { x: number; y: number; w: number; h: number }
        | undefined;
      const comment = body.comment as string | undefined;
      if (
        !rect ||
        typeof rect.x !== "number" ||
        typeof rect.y !== "number" ||
        typeof rect.w !== "number" ||
        typeof rect.h !== "number"
      ) {
        return NextResponse.json({ error: "rect required" }, { status: 400 });
      }
      if (!comment || typeof comment !== "string" || !comment.trim()) {
        return NextResponse.json({ error: "comment required" }, { status: 400 });
      }
      const { annotation, snapshot } = addBrowserAnnotation(id, {
        rect,
        comment,
        url: typeof body.url === "string" ? body.url : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        screenshotDataUrl:
          typeof body.screenshotDataUrl === "string"
            ? body.screenshotDataUrl
            : undefined,
      });
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, annotation, snapshot });
    }
    if (type === "annotation_remove") {
      const annotationId = body.annotationId as string | undefined;
      if (!annotationId) {
        return NextResponse.json(
          { error: "annotationId required" },
          { status: 400 }
        );
      }
      const snapshot = removeBrowserAnnotation(id, annotationId);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "annotation_resolve") {
      const annotationId = body.annotationId as string | undefined;
      if (!annotationId) {
        return NextResponse.json(
          { error: "annotationId required" },
          { status: 400 }
        );
      }
      const status = body.status === "open" ? "open" : "resolved";
      const snapshot = setBrowserAnnotationStatus(id, annotationId, status);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "annotation_clear") {
      const snapshot = clearBrowserAnnotations(id);
      if (rec) pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }

    return NextResponse.json({ error: `unknown action: ${type}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
