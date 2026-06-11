"use client";

/**
 * 右侧消息小地图（minimap）。
 * 移植自 pi-web/components/ChatMinimap.tsx，适配 mini-pi-web 的 ChatMessage / parts 模型。
 *
 * 渲染：
 *   - 每条 user/assistant 消息一个圆点（user 是方块、assistant 是圆）
 *   - viewport 指示框跟随滚动位置
 *   - 拖拽 / 点击跳转到对应位置
 *   - hover 显示带 preview 的 tooltip 列（带防重叠算法）
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type RefObject,
} from "react";
import type { ChatMessage } from "@/lib/types";

interface Props {
  messages: ChatMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

const MINIMAP_WIDTH = 36;
const MAX_MEASURED_MESSAGES = 240;

function getMessagePreview(msg: ChatMessage): string {
  const parts = msg.parts ?? [];
  // 优先抓 text
  for (const p of parts) {
    if (p.kind === "text" && p.text) return p.text.slice(0, 200);
  }
  // assistant 没 text 但有 tool 调用，显示工具名
  if (msg.role === "assistant") {
    const clarification = parts.find((p) => p.kind === "clarification");
    if (clarification?.kind === "clarification") {
      return clarification.question.slice(0, 200);
    }
    const toolNames = parts
      .filter((p): p is Extract<typeof parts[number], { kind: "tool" }> =>
        p.kind === "tool"
      )
      .map((p) => p.toolName);
    if (toolNames.length) return toolNames.join(", ");
  }
  // 兼容旧字段
  if (msg.text) return msg.text.slice(0, 200);
  return "";
}

function getNodeColor(msg: ChatMessage): { bg: string; border: string } {
  if (msg.role === "user") {
    return {
      bg: "color-mix(in srgb, var(--accent) 18%, transparent)",
      border: "color-mix(in srgb, var(--accent) 70%, transparent)",
    };
  }
  return {
    bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)",
    border: "color-mix(in srgb, var(--text-muted) 50%, transparent)",
  };
}

function hasRenderableContent(msg: ChatMessage): boolean {
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  const parts = msg.parts ?? [];
  if (parts.some((p) => p.kind === "text" && p.text)) return true;
  if (parts.some((p) => p.kind === "tool")) return true;
  if (parts.some((p) => p.kind === "clarification")) return true;
  if (parts.some((p) => p.kind === "image")) return true;
  if (msg.text) return true;
  return false;
}

interface NodeInfo {
  topRatio: number;
  heightRatio: number;
  msg: ChatMessage;
  index: number;
}

export function ChatMinimap({
  messages,
  scrollContainer,
  messageRefs,
}: Props) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (msg) => msg.role === "user" || msg.role === "assistant"
      ),
    [messages]
  );

  const visibleMessagesRef = useRef(visibleMessages);
  visibleMessagesRef.current = visibleMessages;

  const updatePositionsRef = useRef<() => void>(() => {});
  updatePositionsRef.current = () => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const all = visibleMessagesRef.current;
    if (all.length > MAX_MEASURED_MESSAGES) {
      setVisible(false);
      setNodes([]);
      return;
    }

    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    const scrollable = totalH - clientH;

    setVisible(scrollable > 20);
    if (scrollable <= 0) {
      setScrollRatio(0);
      setViewportRatio(1);
    } else {
      setScrollRatio(scrollEl.scrollTop / scrollable);
      setViewportRatio(clientH / totalH);
    }

    const refs = messageRefs.current;
    const newNodes: NodeInfo[] = [];
    for (let i = 0; i < all.length; i++) {
      const msg = all[i];
      const el = refs?.[i];
      if (!hasRenderableContent(msg)) continue;
      if (el && totalH > 0) {
        const elRect = el.getBoundingClientRect();
        const containerRect = scrollEl.getBoundingClientRect();
        const top = elRect.top - containerRect.top + scrollEl.scrollTop;
        const h = elRect.height;
        newNodes.push({
          topRatio: top / totalH,
          heightRatio: h / totalH,
          msg,
          index: newNodes.length,
        });
      }
    }
    setNodes(newNodes);
  };

  const updatePositions = useCallback(() => updatePositionsRef.current(), []);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updatePositions, { passive: true });
    const ro = new ResizeObserver(updatePositions);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    updatePositions();
    return () => {
      el.removeEventListener("scroll", updatePositions);
      ro.disconnect();
    };
  }, [scrollContainer, updatePositions]);

  // 消息数量变（接到新消息）后重新测量
  useEffect(() => {
    const t = setTimeout(updatePositions, 50);
    return () => clearTimeout(t);
  }, [visibleMessages.length, updatePositions]);

  const scrollToMinimapRatio = useCallback(
    (viewportTopRatio: number) => {
      const el = scrollContainer.current;
      if (!el) return;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable <= 0) return;
      const clamped = Math.max(
        0,
        Math.min(1 - viewportRatio, viewportTopRatio)
      );
      el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
    },
    [scrollContainer, viewportRatio]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!visible) return;
      draggingRef.current = true;
      const rect = e.currentTarget.getBoundingClientRect();
      const clickRatio = (e.clientY - rect.top) / rect.height;
      const grabOffset =
        clickRatio - scrollRatio * (1 - viewportRatio);
      const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
      const offset = insideBox ? grabOffset : viewportRatio / 2;
      scrollToMinimapRatio(clickRatio - offset);

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const r = (ev.clientY - rect.top) / rect.height;
        scrollToMinimapRatio(r - offset);
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [visible, viewportRatio, scrollRatio, scrollToMinimapRatio]
  );

  // tooltip 防重叠位置
  const TOOLTIP_HEIGHT = 22;
  const TOOLTIP_GAP = 2;
  const minimapHeightPx = containerRef.current?.clientHeight ?? 600;

  const tooltipPositions = useMemo(() => {
    if (!minimapHovered || nodes.length === 0) return [];
    const positions = nodes.map((node) =>
      Math.round(node.topRatio * minimapHeightPx - TOOLTIP_HEIGHT / 2)
    );
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 1; i < positions.length; i++) {
        const minTop = positions[i - 1] + TOOLTIP_HEIGHT + TOOLTIP_GAP;
        if (positions[i] < minTop) positions[i] = minTop;
      }
      for (let i = positions.length - 2; i >= 0; i--) {
        const maxTop = positions[i + 1] - TOOLTIP_HEIGHT - TOOLTIP_GAP;
        if (positions[i] > maxTop) positions[i] = maxTop;
      }
    }
    for (let i = 0; i < positions.length; i++) {
      positions[i] = Math.max(
        0,
        Math.min(minimapHeightPx - TOOLTIP_HEIGHT, positions[i])
      );
    }
    return positions;
  }, [minimapHovered, nodes, minimapHeightPx]);

  if (!visible) return null;

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100;
  const viewportBoxHeight = viewportRatio * 100;

  const nearestIndex =
    mouseYRatio !== null && nodes.length > 0
      ? nodes.reduce((best, node) => {
          return Math.abs(node.topRatio - mouseYRatio) <
            Math.abs(nodes[best].topRatio - mouseYRatio)
            ? node.index
            : best;
        }, 0)
      : null;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => {
        setMinimapHovered(false);
        setMouseYRatio(null);
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMouseYRatio((e.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "default",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      {/* 中线 */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {/* viewport 指示框 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${viewportBoxTop}%`,
          height: `${viewportBoxHeight}%`,
          background: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
          borderTop: "1px solid color-mix(in srgb, var(--text-muted) 20%, transparent)",
          borderBottom: "1px solid color-mix(in srgb, var(--text-muted) 20%, transparent)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* 节点 */}
      {nodes.map((node) => {
        const color = getNodeColor(node.msg);
        const isNearest = minimapHovered && nearestIndex === node.index;
        const isUser = node.msg.role === "user";
        const dotTop = node.topRatio * 100;
        return (
          <div
            key={node.index}
            style={{
              position: "absolute",
              top: `${dotTop}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: isUser ? 8 : 6,
                height: isUser ? 8 : 6,
                borderRadius: isUser ? 2 : "50%",
                background: color.bg,
                border: `1.5px solid ${color.border}`,
                flexShrink: 0,
                transition: "transform 0.1s",
                transform: isNearest ? "scale(1.6)" : "scale(1)",
              }}
            />
          </div>
        );
      })}

      {/* hover tooltips */}
      {minimapHovered &&
        nodes.map((node, i) => {
          const preview = getMessagePreview(node.msg);
          const color = getNodeColor(node.msg);
          const isNearest = nearestIndex === node.index;
          if (!preview || tooltipPositions.length === 0) return null;
          return (
            <div
              key={node.index}
              style={{
                position: "absolute",
                top: tooltipPositions[i],
                right: "100%",
                marginRight: 6,
                background: "var(--bg)",
                borderTop: `1px solid ${
                  isNearest ? color.border : "var(--border)"
                }`,
                borderRight: `1px solid ${
                  isNearest ? color.border : "var(--border)"
                }`,
                borderBottom: `1px solid ${
                  isNearest ? color.border : "var(--border)"
                }`,
                borderLeft: `2px solid ${color.border}`,
                borderRadius: 4,
                padding: "2px 7px",
                width: 200,
                zIndex: 100,
                pointerEvents: "none",
                opacity: isNearest ? 1 : 0.45,
                transition: "top 0.1s, opacity 0.1s",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: isNearest ? "var(--text)" : "var(--text-muted)",
                  lineHeight: 1.4,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {preview}
              </div>
            </div>
          );
        })}
    </div>
  );
}

/** 给每条 visible message 准备一个稳定的 ref 数组 */
export function useMessageRefs(
  count: number
): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count)
    .fill(null)
    .map((_, i) => refs.current[i] ?? null);
  return refs;
}
