"use client";

import { useCallback, useRef, useState } from "react";

/** 移动多少像素后才算"开始拖拽"（小于阈值算单击） */
const DRAG_THRESHOLD = 5;

/** ===== 吸附常量（设计 §3.4 边缘吸附） ===== */
/** sprite 中心到屏幕边缘小于此距离时触发吸附 */
const SNAP_TRIGGER_PX = 80;
/** 吸附后 sprite 边缘距离 workArea 边缘的留白 */
const SNAP_MARGIN_PX = 16;

/**
 * sprite 在宠物窗口中的几何位置（与 PetApp.tsx 布局耦合）：
 *   窗口尺寸：320×400
 *   sprite 容器：right:0 bottom:0 100×120
 *   sprite 本体：80×80 居中于容器
 *
 * 所以 sprite 中心相对窗口左上角的偏移：
 *   container 中心 X = 320 - 100/2 = 270
 *   container 中心 Y = 400 - 120/2 = 340
 * sprite 占地半径：40
 */
const PET_WIN_W = 320;
const PET_WIN_H = 400;
const SPRITE_CENTER_OFFSET_X = 270;
const SPRITE_CENTER_OFFSET_Y = 340;
const SPRITE_HALF = 40;

/**
 * 把窗口左上角坐标 → sprite 中心坐标
 */
function winToSpriteCenter(winX: number, winY: number) {
  return {
    cx: winX + SPRITE_CENTER_OFFSET_X,
    cy: winY + SPRITE_CENTER_OFFSET_Y,
  };
}

/**
 * 给定希望的 sprite 中心坐标，反推窗口左上角坐标
 */
function spriteCenterToWin(cx: number, cy: number) {
  return {
    x: cx - SPRITE_CENTER_OFFSET_X,
    y: cy - SPRITE_CENTER_OFFSET_Y,
  };
}

/**
 * 根据 sprite 当前中心 + workArea 计算吸附后的窗口坐标。
 *
 * 水平和垂直独立判断：
 *   - 距左边 < SNAP_TRIGGER_PX：吸到左边（sprite 边距 workArea 左 SNAP_MARGIN_PX）
 *   - 距右边 < SNAP_TRIGGER_PX：吸到右边
 *   - 上下同理
 *   - 同时满足左右/上下时（不可能，workArea > 160px），left 优先（理论不触发）
 *
 * 不在阈值内时返回 null（不吸附）。
 */
function computeSnap(
  cx: number,
  cy: number,
  wa: { x: number; y: number; width: number; height: number }
): { x: number; y: number } | null {
  const distLeft = cx - wa.x;
  const distRight = wa.x + wa.width - cx;
  const distTop = cy - wa.y;
  const distBottom = wa.y + wa.height - cy;

  let snappedCx = cx;
  let snappedCy = cy;
  let didSnap = false;

  if (distLeft < SNAP_TRIGGER_PX) {
    snappedCx = wa.x + SNAP_MARGIN_PX + SPRITE_HALF;
    didSnap = true;
  } else if (distRight < SNAP_TRIGGER_PX) {
    snappedCx = wa.x + wa.width - SNAP_MARGIN_PX - SPRITE_HALF;
    didSnap = true;
  }

  if (distTop < SNAP_TRIGGER_PX) {
    snappedCy = wa.y + SNAP_MARGIN_PX + SPRITE_HALF;
    didSnap = true;
  } else if (distBottom < SNAP_TRIGGER_PX) {
    snappedCy = wa.y + wa.height - SNAP_MARGIN_PX - SPRITE_HALF;
    didSnap = true;
  }

  if (!didSnap) return null;
  return spriteCenterToWin(snappedCx, snappedCy);
}

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
 * - mouseup：若发生过拖拽，向主进程查 workArea，触发边缘吸附（设计 §3.4）
 * - dragging 状态在 mouseup 后异步重置（让 click 监听者能感知刚拖过）
 *
 * 返回：
 * - onMouseDown: 挂到 sprite 上
 * - dragging: 当前是否在拖拽（用于抑制 hover 气泡 / 改变光标）
 * - wasJustDragged: 刚拖完一次（mouseup 后 50ms 内为 true，用于让 onClick 跳过）
 */
export function usePetDrag() {
  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startWinX: number;
    startWinY: number;
    started: boolean;
    /** 最近一次 move 推出去的窗口坐标，用于 mouseup 吸附计算 */
    lastX: number;
    lastY: number;
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
      lastX: window.screenX,
      lastY: window.screenY,
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
      ref.lastX = newX;
      ref.lastY = newY;
      const api = window.digaAgent;
      api?.pet?.move?.({ x: newX, y: newY });
    };

    const onUp = () => {
      const ref = dragRef.current;
      const wasDragging = ref?.started ?? false;
      const finalX = ref?.lastX ?? window.screenX;
      const finalY = ref?.lastY ?? window.screenY;
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);

      if (!wasDragging) return;

      // 让本次 mouseup 的 click 事件能识别"刚拖过"，跳过 setCardOpen 等副作用
      justDraggedRef.current = true;
      setDragging(false);
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 50);

      // 边缘吸附：mouseup 时查 workArea 算最终位置，平滑推一次 pet.move
      // 异步进行，不阻塞 mouseup 后续流程
      const api = window.digaAgent;
      if (!api?.pet?.getWorkArea) return;
      void (async () => {
        const wa = await api.pet.getWorkArea();
        if (!wa) return;
        const { cx, cy } = winToSpriteCenter(finalX, finalY);
        const snapped = computeSnap(cx, cy, wa);
        if (!snapped) return;
        // 仅在确实需要移动时推（避免 setPosition 抖动）
        if (snapped.x !== finalX || snapped.y !== finalY) {
          api.pet.move({ x: snapped.x, y: snapped.y });
        }
      })();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return { onMouseDown, dragging, wasJustDragged: () => justDraggedRef.current };
}

// 内部辅助函数对外不导出，但保留 PET_WIN_W/H 防 lint unused-warning
void PET_WIN_W;
void PET_WIN_H;
