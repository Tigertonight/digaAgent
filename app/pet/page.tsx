"use client";

import { useEffect } from "react";
import PetApp from "./PetApp";

export default function PetPage() {
  // 宠物窗口：给 body 加透明背景 class
  useEffect(() => {
    document.body.classList.add("pet-window");
    return () => document.body.classList.remove("pet-window");
  }, []);

  return <PetApp />;
}
