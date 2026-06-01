"use client";

import type { PetAnimState } from "./use-pet-state";

interface Props {
  animState: PetAnimState;
  size?: number;
}

/**
 * 宠物 sprite —— 主 logo 静态显示 + 状态层（光晕 / 滤镜 / 动画 / 徽章）。
 *
 * 视觉规范见 docs/plans/2026-06-01-pet-interaction-design.md §1 / §2。
 *
 * 结构（外→内）：
 *   wrapper (size×size, 圆形, 承载光晕 box-shadow + 动画)
 *     └─ img (主 logo, 承载滤镜)
 *     └─ badge (attention 红点 / offline 灰叉, absolute 右上)
 */
export default function PetSprite({ animState, size = 80 }: Props) {
  // 包裹圆形容器的样式：根据状态切动画 + box-shadow
  const wrapperAnim = (() => {
    switch (animState) {
      case "idle":
        return "pet-breathe 4s ease-in-out infinite";
      case "thinking":
        return "pet-glow-thinking 1.2s ease-in-out infinite";
      case "running":
        return "pet-glow-running 2s linear infinite";
      case "done":
        // key 变化时让 pop 重播
        return "pet-pop 600ms cubic-bezier(.34,1.56,.64,1) 1";
      case "error":
        return "pet-glow-error 1.5s ease-in-out infinite";
      case "attention":
        return "pet-breathe 4s ease-in-out infinite";
      case "offline":
        // offline 时呼吸暂停，整体静止
        return "none";
    }
  })();

  // 主图滤镜（offline 灰度 / error 红色 tint）
  const imgFilter = (() => {
    if (animState === "offline") return "grayscale(0.85) brightness(0.85)";
    if (animState === "error") return "saturate(1.2)";
    return "none";
  })();

  // 徽章：attention=蓝点脉动（提示性而非警告性）/ offline=灰色叉
  const badge = (() => {
    if (animState === "attention") {
      return (
        <span
          aria-label="有新回复"
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#6366f1",
            border: "2px solid rgba(17,24,39,0.6)",
            animation: "pet-badge-pulse 1.4s ease-out infinite",
          }}
        />
      );
    }
    if (animState === "offline") {
      return (
        <span
          aria-label="已离线"
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#dc2626",
            color: "#fff",
            border: "2px solid rgba(17,24,39,0.7)",
            fontSize: 11,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
          }}
        >
          ×
        </span>
      );
    }
    return null;
  })();

  return (
    <div
      // key=animState 让 done 等"单次播放"动画在状态切换时强制重启
      key={animState}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        animation: wrapperAnim,
        transition: "filter 200ms ease, transform 200ms ease",
      }}
    >
      <img
        src="/brand/diga-logo-main.webp"
        alt="Diga"
        width={size}
        height={size}
        style={{
          display: "block",
          width: size,
          height: size,
          userSelect: "none",
          pointerEvents: "none",
          filter: imgFilter,
          transition: "filter 200ms ease",
        }}
        draggable={false}
      />
      {badge}
    </div>
  );
}
