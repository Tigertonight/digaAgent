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
import { getAgent, getEventsSince, onNewEvent } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseEncode(seq: number, payload: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) {
    return new Response("agent not found", { status: 404 });
  }

  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : -1;

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
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

      // 2. 监听新事件
      const flush = () => {
        for (const { seq, event } of getEventsSince(id, lastSentSeq)) {
          safeEnqueue(sseEncode(seq, event));
          lastSentSeq = seq;
        }
      };
      unsub = onNewEvent(id, flush);

      // 3. 心跳，避免代理/浏览器断流
      heartbeat = setInterval(() => {
        safeEnqueue(`: ping ${Date.now()}\n\n`);
      }, 15000);

      // 4. client 断开
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (unsub) unsub();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      if (unsub) unsub();
      if (heartbeat) clearInterval(heartbeat);
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
