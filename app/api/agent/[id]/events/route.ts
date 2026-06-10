/**
 * SSE 事件流：
 *   GET /api/agent/[id]/events?since=<seq>
 *
 * 行为：
 *   1. 先回放 ring buffer 里 seq > since 的所有事件
 *   2. 然后挂监听器，每来一条新事件就推送
 *   3. client 断开时清理监听器
 *
 * SSE message 格式：
 *   id: <seq>\n
 *   data: <json>\n\n
 */
import {
  getAgent,
  getEventsSince,
  getLatestEventSeq,
  onNewEvent,
} from "@/lib/agent-registry";
import { assertRemoteAuth } from "@/lib/remote/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseEncode(seq: number, payload: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) {
    return new Response("agent not found", { status: 404 });
  }

  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  // EventSource 自动重连时会带 Last-Event-ID 头(我们 sseEncode 的 `id:` 字段)
  // 优先用 ?since= 显式查询;没有就 fallback 到 Last-Event-ID
  const lastEventId = req.headers.get("last-event-id");
  const since = sinceRaw
    ? sinceRaw === "latest"
      ? getLatestEventSeq(id)
      : Number(sinceRaw)
    : lastEventId
      ? Number(lastEventId)
      : -1;

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let lastSentSeq = since;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // 1. 起手回放
      safeEnqueue(`retry: 3000\n\n`);
      for (const { seq, event } of getEventsSince(id, since)) {
        safeEnqueue(sseEncode(seq, event));
        lastSentSeq = seq;
      }

      // 2. 监听新事件 —— 用 16ms 节流合并同帧内的高频 token
      //    SDK 一个 text_delta 事件可能 5-20ms 一发,纯文本流式 50-100 events/s。
      //    每个 event 都立即 flush + 立即 SSE write 会让前端 React commit 也变成 50-100/s。
      //    把同一 16ms 窗内的事件累积一次 enqueue,前端最多 60fps 触发,刚好对齐 RAF。
      const flushNow = () => {
        flushTimer = null;
        for (const { seq, event } of getEventsSince(id, lastSentSeq)) {
          safeEnqueue(sseEncode(seq, event));
          lastSentSeq = seq;
        }
      };
      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(flushNow, 16);
      };
      unsub = onNewEvent(id, scheduleFlush);

      // 3. 心跳，避免代理/浏览器断流
      heartbeat = setInterval(() => {
        safeEnqueue(`: ping ${Date.now()}\n\n`);
      }, 15000);

      // 4. client 断开
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (unsub) unsub();
        if (heartbeat) clearInterval(heartbeat);
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      if (unsub) unsub();
      if (heartbeat) clearInterval(heartbeat);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
