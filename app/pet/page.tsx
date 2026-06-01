"use client";

import { useEffect } from "react";

export default function PetPage() {
  // 宠物窗口：给 body 加透明背景 class（Task 11 会定义这个 class）
  useEffect(() => {
    document.body.classList.add("pet-window");
    return () => document.body.classList.remove("pet-window");
  }, []);

  return (
    <div
      style={{
        width: 120,
        height: 160,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        color: "white",
        fontSize: 12,
      }}
    >
      🐾 Diga Pet
    </div>
  );
}
