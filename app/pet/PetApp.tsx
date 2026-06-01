"use client";

import { useState } from "react";
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
  } = usePetState();

  const { onMouseDown } = usePetDrag();

  const [hovered, setHovered] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);

  const focusedId = displaySession?.id ?? null;

  return (
    // 宠物整体容器：透明背景，相对定位（子组件气泡/卡片用 absolute 弹出）
    <div
      style={{
        position: "relative",
        width: 120,
        height: 160,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 16,
        background: "transparent",
        overflow: "visible",
      }}
    >
      {/* hover 气泡 */}
      {hovered && !cardOpen && (
        <PetBubble
          animState={animState}
          session={displaySession}
          allSessions={allSessions}
          focusedId={focusedId}
          onSwitchSession={(id) => setLocalFocusId(id)}
        />
      )}

      {/* 操作卡片 */}
      {cardOpen && (
        <PetCard
          session={displaySession}
          onClose={() => setCardOpen(false)}
          onFocusMain={() => {
            focusMain(displaySession?.id);
            setCardOpen(false);
          }}
        />
      )}

      {/* 宠物主体：可拖拽 + hover + 点击 */}
      <div
        onMouseDown={onMouseDown}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (!cardOpen) setCardOpen(true);
        }}
        style={{
          cursor: "grab",
          userSelect: "none",
          position: "relative",
        }}
        title="Diga Agent"
      >
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
                animState === "running" ? "#f59e0b" :
                animState === "attention" ? "#f87171" :
                "#7ee787",
              boxShadow: `0 0 6px ${
                animState === "thinking" ? "#60a5fa" :
                animState === "running" ? "#f59e0b" :
                animState === "attention" ? "#f87171" :
                "#7ee787"
              }`,
              animation: animState === "attention" ? "pulse 1s infinite" : "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
