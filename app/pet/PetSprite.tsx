// 依赖 Task 4：./use-pet-state 需导出 PetAnimState 类型
"use client";

import { useEffect, useRef, useState } from "react";
import type { PetAnimState } from "./use-pet-state";

interface FrameConfig {
  frames: number[];
  interval: number;
}

const ANIM_CONFIG: Record<PetAnimState, FrameConfig> = {
  idle:      { frames: [1, 2, 3, 4],    interval: 500 },
  thinking:  { frames: [5, 6, 7, 8],    interval: 150 },
  running:   { frames: [9, 10, 11, 12], interval: 100 },
  attention: { frames: [13, 14],         interval: 300 },
  done:      { frames: [15, 16],         interval: 200 },
};

function frameSrc(n: number): string {
  return `/brand/diga-logo-frames/diga-logo-${String(n).padStart(2, "0")}.webp`;
}

interface Props {
  animState: PetAnimState;
  size?: number;
}

export default function PetSprite({ animState, size = 80 }: Props) {
  const config = ANIM_CONFIG[animState];
  const [frameIdx, setFrameIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // animState 切换时重置到第 0 帧，重启计时器
  useEffect(() => {
    setFrameIdx(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setFrameIdx((i) => (i + 1) % config.frames.length);
    }, config.interval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [animState, config.frames.length, config.interval]);

  const currentFrame = config.frames[frameIdx];

  return (
    <img
      src={frameSrc(currentFrame)}
      alt={`Diga ${animState}`}
      width={size}
      height={size}
      style={{
        imageRendering: "pixelated",
        userSelect: "none",
        pointerEvents: "none",
        filter: animState === "done" ? "drop-shadow(0 0 6px #7ee787)" : "none",
        transition: "filter 0.3s ease",
      }}
      draggable={false}
    />
  );
}
