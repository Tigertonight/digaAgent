"use client";

import { useCallback, useRef, useState } from "react";

/** 移动多少像素后才算"开始拖拽"（小于阈值算单击） */
const DRAG_THRESHOLD = 5;

/**
 * 宠物拖拽 hook。
 *
 * 思路：mousedown 记录起始鼠标位置（屏幕坐标），mousemove 时计算 delta，
 * 通过 IPC pet:move 通知主进程移动 BrowserWindow。
 * 因为宠物窗口是 frameless，window.screenX/screenY 给出窗口在屏幕上的位置。
 *
 * 拖拽语义：
 * - mousedown 仅记录起点，**不立刻标记为 dragging**
 * - mousemove 移动 ≥ DRAG_THRESHOLD 时才标记 dragging=true，并开始推 pet:move
 * - mouseup 清理；dragging 状态在 mouseup 后异步重置（让 click 监听者能感知刚拖过）
 *
 * 返回：
 * - onMouseDown: 挂到 sprite 上
 * - dragging: 当前是否在拖拽（用于抑制 hover 气泡 / 改变光标）
 * - justDragged: 刚拖完一次（mouseup 后 50ms 内为 true，用于让 onClick 跳过）
 */
export function usePetDrag() {
  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startWinX: number;
    startWinY: number;
    started: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const justDraggedRef = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 只响应左键
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      startMouseX: e.screenX,
      startMouseY: e.screenY,
      startWinX: window.screenX,
      startWinY: window.screenY,
      started: false,
    };

    const onMove = (ev: MouseEvent) => {
      const ref = dragRef.current;
      if (!ref) return;
      const dx = ev.screenX - ref.startMouseX;
      const dy = ev.screenY - ref.startMouseY;

      // 阈值未达：不算拖拽
      if (!ref.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
          return;
        }
        ref.started = true;
        setDragging(true);
      }

      const newX = ref.startWinX + dx;
      const newY = ref.startWinY + dy;
      const api = window.miniPi;
      api?.pet?.move?.({ x: newX, y: newY });
    };

    const onUp = () => {
      const wasDragging = dragRef.current?.started ?? false;
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (wasDragging) {
        // 让本次 mouseup 的 click 事件能识别"刚拖过"，跳过 setCardOpen 等副作用
        justDraggedRef.current = true;
        setDragging(false);
        // 下一帧清掉，避免影响后续真实点击
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 50);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return { onMouseDown, dragging, wasJustDragged: () => justDraggedRef.current };
}
