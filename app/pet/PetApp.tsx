"use client";

import { useEffect, useRef, useState } from "react";
import { usePetState } from "./use-pet-state";
import { usePetDrag } from "./use-pet-drag";
import PetSprite from "./PetSprite";
import PetBubble from "./PetBubble";
import PetCard from "./PetCard";

export default function PetApp() {
  const {
    animState,
    displaySession,
    allSessions,
    localFocusId,
    setLocalFocusId,
    focusMain,
    bubbleText,
  } = usePetState();

  const { onMouseDown, dragging, wasJustDragged } = usePetDrag();

  // hover 状态拆分：sprite 上 / 气泡上 / 关闭延迟计时器
  // 任意一个 hover=true 时气泡显示；都 false 时延迟 300ms 关闭
  // 这样鼠标从 sprite 移动到气泡的"空隙"瞬间不会闪烁，且鼠标在气泡上时气泡不消失
  const [spriteHover, setSpriteHover] = useState(false);
  const [bubbleHover, setBubbleHover] = useState(false);
  const [bubbleVisible, setBubbleVisible] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [cardOpen, setCardOpen] = useState(false);
  const spriteRef = useRef<HTMLDivElement>(null);

  // 任一区域 hover → 立即取消关闭计时 + 显示气泡
  useEffect(() => {
    const anyHover = spriteHover || bubbleHover;
    if (anyHover) {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setBubbleVisible(true);
    } else if (bubbleVisible) {
      // 离开后 300ms 才关闭，给鼠标"sprite ↔ 气泡"切换的缓冲
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setBubbleVisible(false);
      }, 300);
    }
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [spriteHover, bubbleHover, bubbleVisible]);

  // 拖拽中或卡片打开时强制隐藏气泡
  const showBubble = bubbleVisible && !cardOpen && !dragging;
  // 窗口需"独占鼠标事件"的条件：sprite/气泡正在被 hover、或卡片已打开
  // 关闭延迟（bubbleVisible 还为 true）期间仍设 forward 模式：透明区域穿透，
  // 但鼠标重新进入 sprite/气泡时 mouseenter 仍能触发（preload setIgnoreMouseEvents
  // 已带 forward:true）
  const hasUI = spriteHover || bubbleHover || cardOpen;

  // 根据是否有 UI 交互动态控制鼠标穿透
  // hasUI=true → 关闭穿透（窗口接收所有事件）
  // hasUI=false → 开启穿透（透明区域鼠标穿透到下方窗口）
  useEffect(() => {
    window.miniPi?.pet?.setIgnoreMouse?.(!hasUI);
  }, [hasUI]);

  // 组件挂载时开启穿透（默认 idle 状态）
  useEffect(() => {
    window.miniPi?.pet?.setIgnoreMouse?.(true);
    return () => {
      window.miniPi?.pet?.setIgnoreMouse?.(false);
    };
  }, []);

  return (
    // 整个窗口大小 320×400，透明，宠物 sprite 在右下角
    <div
      style={{
        position: "fixed",
        inset: 0,
        width: 320,
        height: 400,
        background: "transparent",
        overflow: "visible",
        pointerEvents: "none", // 默认不捕获事件，由子元素按需启用
      }}
    >
      {/* hover 气泡 —— 在 sprite 上方，sprite 右侧对齐（拖拽时隐藏）
          鼠标在气泡上时也保持显示（粘性气泡） */}
      {showBubble && (
        <div
          onMouseEnter={() => setBubbleHover(true)}
          onMouseLeave={() => setBubbleHover(false)}
          style={{
            position: "absolute",
            right: 0,
            bottom: 120 + 8, // sprite 高度 + 间距
            pointerEvents: "auto",
          }}
        >
          <PetBubble animState={animState} bubbleText={bubbleText} />
        </div>
      )}

      {/* 操作卡片 —— 在 sprite 上方 */}
      {cardOpen && (
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 120 + 8,
            pointerEvents: "auto",
          }}
        >
          <PetCard
            session={displaySession}
            animState={animState}
            bubbleText={bubbleText}
            allSessions={allSessions}
            localFocusId={localFocusId}
            onClose={() => setCardOpen(false)}
            onFocusMain={() => {
              focusMain(displaySession?.id);
              setCardOpen(false);
            }}
            onSwitchLocalSession={(id) => setLocalFocusId(id)}
          />
        </div>
      )}

      {/* 宠物主体：固定在右下角，可拖拽 + hover + 点击 */}
      <div
        ref={spriteRef}
        onMouseDown={onMouseDown}
        onMouseEnter={() => setSpriteHover(true)}
        onMouseLeave={() => setSpriteHover(false)}
        onClick={() => {
          // 刚拖完一次的 click 应忽略（避免松手即弹卡片）
          if (wasJustDragged()) return;
          if (!cardOpen) {
            setCardOpen(true);
            // 卡片打开后立即清空 hover 状态 + 让气泡关闭
            setSpriteHover(false);
            setBubbleHover(false);
            setBubbleVisible(false);
          }
        }}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 100,
          height: 120,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "auto", // sprite 区域接收鼠标事件
        }}
        title="Diga Agent"
      >
        <PetSprite animState={animState} size={80} />
      </div>
    </div>
  );
}
