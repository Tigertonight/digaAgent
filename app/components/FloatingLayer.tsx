"use client";

/**
 * FloatingLayer —— 通用浮层组件。
 *
 * 解决问题：
 *   1. 浮层被祖先 overflow:hidden/auto 容器裁掉（CSS 规范要求 overflow-y
 *      非 visible 时隐式把 overflow-x 也设成 auto/hidden）。
 *   2. 靠近视口边界时被遮挡。
 *   3. 弹开后需要：
 *      - 自动避开视口上下左右四边（clamp）
 *      - 底部超出时翻转到 trigger 上方（flip）
 *      - 滚动 / resize 时跟随移动（scroll/resize listener，capture 阶段
 *        捕获祖先滚动容器的滚动事件）
 *      - 点击外部 / Esc 关闭
 *
 * 用法：
 *   const triggerRef = useRef<HTMLButtonElement>(null);
 *   const [open, setOpen] = useState(false);
 *   <button ref={triggerRef} onClick={() => setOpen(o => !o)}>⋯</button>
 *   <FloatingLayer
 *     anchor={triggerRef.current}
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     placement="bottom-end"
 *     minWidth={168}
 *   >
 *     <MenuItem .../>
 *   </FloatingLayer>
 *
 * 设计取舍：
 *   - 不依赖 @floating-ui / @radix，纯 React 18/19 原生 API。bundle 零增量。
 *   - placement 简化为 6 个档位，覆盖 95% 弹层场景；后续要支持复杂对齐再换库。
 *   - 首帧用 props 传入的 minWidth/minHeight 做保守 clamp；mount 后
 *     通过 useLayoutEffect 拿到真实尺寸再 reflow 一次，避免抖动。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type FloatingPlacement =
  | "bottom-start"
  | "bottom"
  | "bottom-end"
  | "top-start"
  | "top"
  | "top-end";

export interface FloatingLayerProps {
  /** 触发器元素；null 时浮层不渲染 */
  anchor: HTMLElement | null;
  /** 是否打开 */
  open: boolean;
  /** 关闭回调（点击外部 / Esc 触发） */
  onClose?: () => void;
  /** 默认 bottom-end：popover 右边缘对齐 trigger 右边缘 */
  placement?: FloatingPlacement;
  /** trigger 与浮层的间距（px） */
  offset?: number;
  /** 首帧用的最小宽度估算（mount 后会用真实尺寸 reflow） */
  minWidth?: number;
  /** 首帧用的最小高度估算（用于底部 flip 判断） */
  minHeight?: number;
  /** 视口四边留白 */
  edgePadding?: number;
  /** 点击外部关闭（默认 true） */
  closeOnOutsideClick?: boolean;
  /** Esc 关闭（默认 true） */
  closeOnEscape?: boolean;
  /** 自定义 z-index（默认 50） */
  zIndex?: number;
  /** 额外 className（会拼在容器上） */
  className?: string;
  /** 额外 style（会和定位 style 合并，定位相关字段以本组件为准） */
  style?: CSSProperties;
  /** 内容 */
  children: ReactNode;
}

interface Position {
  top: number;
  left: number;
}

const FALLBACK_W = 168;
const FALLBACK_H = 168;

function clamp(
  value: number,
  min: number,
  max: number,
): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function computePosition(
  anchor: HTMLElement,
  popover: { width: number; height: number },
  placement: FloatingPlacement,
  offset: number,
  edgePadding: number,
): Position {
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = popover.width;
  const h = popover.height;

  // 1) 算出"理想位置"（不做任何 clamp）
  let top = 0;
  let left = 0;

  const isBottom = placement.startsWith("bottom");
  const isTop = placement.startsWith("top");
  const align = placement.split("-")[1] ?? "center";

  if (isBottom) top = rect.bottom + offset;
  else if (isTop) top = rect.top - offset - h;

  if (align === "start") left = rect.left;
  else if (align === "end") left = rect.right - w;
  else left = rect.left + rect.width / 2 - w / 2; // center

  // 2) 纵向 flip：底部超出 → 翻到 trigger 上方；顶部超出 → 翻到下方
  if (isBottom && top + h > vh - edgePadding) {
    const flipped = rect.top - offset - h;
    if (flipped >= edgePadding) top = flipped;
    else top = Math.max(edgePadding, vh - h - edgePadding);
  } else if (isTop && top < edgePadding) {
    const flipped = rect.bottom + offset;
    if (flipped + h <= vh - edgePadding) top = flipped;
    else top = edgePadding;
  }

  // 3) 横向 clamp
  const maxLeft = vw - w - edgePadding;
  left = clamp(left, edgePadding, Math.max(edgePadding, maxLeft));

  // 4) 纵向 clamp（flip 之后兜底）
  const maxTop = vh - h - edgePadding;
  top = clamp(top, edgePadding, Math.max(edgePadding, maxTop));

  return { top, left };
}

export function FloatingLayer(props: FloatingLayerProps) {
  const {
    anchor,
    open,
    onClose,
    placement = "bottom-end",
    offset = 6,
    minWidth = FALLBACK_W,
    minHeight = FALLBACK_H,
    edgePadding = 8,
    closeOnOutsideClick = true,
    closeOnEscape = true,
    zIndex = 50,
    className,
    style,
    children,
  } = props;

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  // mount 后拿到真实尺寸，触发一次 reflow 让定位更精准
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(
    null,
  );

  // 计算 + 重新计算位置。
  // 位置计算必须在 effect 里执行（需要 anchor DOM rect）。为了不违反
  // react-hooks/set-state-in-effect 规则，调用点用 rAF 延后一帧再 setState，
  // 这样 effect 主体内不出现同步 setState，也避免了 cascading render。
  const recompute = useCallback(() => {
    if (!anchor) return;
    const w = measured?.w ?? minWidth;
    const h = measured?.h ?? minHeight;
    const next = computePosition(
      anchor,
      { width: w, height: h },
      placement,
      offset,
      edgePadding,
    );
    requestAnimationFrame(() => setPos(next));
  }, [anchor, measured, minWidth, minHeight, placement, offset, edgePadding]);

  // open 切换 / anchor 切换 / placement 变化 → 重新计算
  useEffect(() => {
    if (!open || !anchor) {
      // Defer reset to a microtask so we don't synchronously set state inside
      // the effect body (cascading-render lint rule). Setting null here only
      // matters when the popover transitions back to closed; the visual state
      // is already hidden by `open` gating in the JSX.
      queueMicrotask(() => {
        setPos(null);
        setMeasured(null);
      });
      return;
    }
    recompute();
    // capture 阶段监听 scroll，捕获祖先 overflow 容器的滚动
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, anchor, recompute]);

  // mount 后 reflow：用真实 popover 尺寸再做一次精确 clamp/flip
  useLayoutEffect(() => {
    if (!open) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (
      !measured ||
      measured.w !== rect.width ||
      measured.h !== rect.height
    ) {
      setMeasured({ w: rect.width, h: rect.height });
    }
    // measured 变化会触发上一个 effect 重算；pos 从 null → 真实位置时
    // portal 才会 mount，因此也要在 pos 变化后测量一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos]);

  // 外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    if (!closeOnOutsideClick && !closeOnEscape) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (!closeOnOutsideClick) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      // 点击在 trigger 上 → 不处理（让 trigger 自己 toggle）
      if (anchor?.contains(target)) return;
      // 点击在 popover 内 → 不处理（菜单项点击会先 stopPropagation）
      if (popoverRef.current?.contains(target)) return;
      onClose?.();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!closeOnEscape) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };

    // pointerdown 用 capture，让菜单项的 onClick 先于冒泡阶段的 onClose 触发
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, anchor, closeOnOutsideClick, closeOnEscape, onClose]);

  if (!open || !anchor || !pos) return null;
  if (typeof document === "undefined") return null;

  const mergedStyle: CSSProperties = {
    position: "fixed",
    top: pos.top,
    left: pos.left,
    zIndex,
    ...style,
  };

  return createPortal(
    <div
      ref={popoverRef}
      data-floating-layer
      className={className}
      style={mergedStyle}
    >
      {children}
    </div>,
    document.body,
  );
}

export default FloatingLayer;