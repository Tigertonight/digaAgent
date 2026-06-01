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
    setLocalFocusId,
    focusMain,
    bubbleText,
  } = usePetState();

  const { onMouseDown } = usePetDrag();

  const [hovered, setHovered] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const spriteRef = useRef<HTMLDivElement>(null);

  const hasUI = hovered || cardOpen;

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
      {/* hover 气泡 —— 在 sprite 上方，sprite 右侧对齐 */}
      {hovered && !cardOpen && (
        <div
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
            onClose={() => setCardOpen(false)}
            onFocusMain={() => {
              focusMain(displaySession?.id);
              setCardOpen(false);
            }}
          />
        </div>
      )}

      {/* 宠物主体：固定在右下角，可拖拽 + hover + 点击 */}
      <div
        ref={spriteRef}
        onMouseDown={onMouseDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          // 离开 sprite 时，如果卡片开着就保持，否则关闭气泡
          if (!cardOpen) setHovered(false);
        }}
        onClick={() => {
          if (!cardOpen) {
            setCardOpen(true);
            setHovered(false);
          }
        }}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 100,
          height: 120,
          cursor: "grab",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "auto", // sprite 区域接收鼠标事件
        }}
        title="Diga Agent"
      >
        <div style={{ position: "relative" }}>
          <PetSprite animState={animState} size={80} />

          {/* 状态指示点 */}
          {animState !== "idle" && (
            <div
              style={{
                position: "absolute",
                top: 4,
                right: 4,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  animState === "thinking" ? "#60a5fa" :
                  animState === "running"   ? "#f59e0b" :
                  animState === "attention" ? "#f87171" :
                  "#7ee787",
                boxShadow: `0 0 6px ${
                  animState === "thinking" ? "#60a5fa" :
                  animState === "running"   ? "#f59e0b" :
                  animState === "attention" ? "#f87171" :
                  "#7ee787"
                }`,
                animation: animState === "attention" ? "pulse 1s infinite" : "none",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
