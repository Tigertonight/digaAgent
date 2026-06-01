"use client";

import { useCallback, useRef } from "react";

/**
 * 宠物拖拽 hook。
 *
 * 思路：mousedown 记录起始鼠标位置（屏幕坐标），mousemove 时计算 delta，
 * 通过 IPC pet:move 通知主进程移动 BrowserWindow。
 * 因为宠物窗口是 frameless，window.screenX/screenY 给出窗口在屏幕上的位置。
 */
export function usePetDrag() {
  const dragRef = useRef<{ startMouseX: number; startMouseY: number; startWinX: number; startWinY: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 只响应左键
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      startMouseX: e.screenX,
      startMouseY: e.screenY,
      startWinX: window.screenX,
      startWinY: window.screenY,
    };

    const onMove = (ev: MouseEvent) => {
      const ref = dragRef.current;
      if (!ref) return;
      const dx = ev.screenX - ref.startMouseX;
      const dy = ev.screenY - ref.startMouseY;
      const newX = ref.startWinX + dx;
      const newY = ref.startWinY + dy;
      const api = window.miniPi;
      api?.pet?.move?.({ x: newX, y: newY });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return { onMouseDown };
}
