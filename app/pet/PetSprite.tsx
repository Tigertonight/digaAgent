"use client";

import type { PetAnimState } from "./use-pet-state";

interface Props {
  animState: PetAnimState;
  size?: number;
}

/**
 * 宠物 sprite —— 当前阶段用主 logo 静态显示。
 * 后续补充帧动画对应关系后在此替换实现。
 */
export default function PetSprite({ animState, size = 80 }: Props) {
  const isDone = animState === "done";

  return (
    <img
      src="/brand/diga-logo-main.webp"
      alt="Diga"
      width={size}
      height={size}
      style={{
        display: "block",
        userSelect: "none",
        pointerEvents: "none",
        filter: isDone ? "drop-shadow(0 0 6px #7ee787)" : "none",
        transition: "filter 0.3s ease",
      }}
      draggable={false}
    />
  );
}
