"use client";

import { useEffect } from "react";
import PetApp from "./PetApp";

export default function PetPage() {
  useEffect(() => {
    // 强制覆盖 root layout 的 body { background: var(--bg) }
    // Electron 透明窗口要求 html + body 都是 transparent
    const html = document.documentElement;
    const body = document.body;

    const prevHtmlBg = html.style.background;
    const prevBodyBg = body.style.background;
    const prevBodyOverflow = body.style.overflow;

    html.style.setProperty("background", "transparent", "important");
    body.style.setProperty("background", "transparent", "important");
    body.style.overflow = "hidden";
    body.classList.add("pet-window");

    return () => {
      html.style.background = prevHtmlBg;
      body.style.background = prevBodyBg;
      body.style.overflow = prevBodyOverflow;
      body.classList.remove("pet-window");
    };
  }, []);

  return <PetApp />;
}
