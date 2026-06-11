"use client";

/**
 * 全屏图片预览（蒙层 lightbox）。
 *
 * - 订阅 imageLightboxStore：任何 previewStore.openImage() 触发都会打开
 * - ESC / 点击背景 / 关闭按钮 关闭
 * - 鼠标滚轮缩放、双击复位、拖拽平移
 * - 顶部工具栏：下载（data: URL 直链下载，http: 用 fetch+blob，本地 /api/files 直接 a[download]）
 */
import Image from "next/image";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { imageLightboxStore } from "@/lib/preview-store";

export default function ImageLightbox() {
  const state = useSyncExternalStore(
    imageLightboxStore.subscribe,
    imageLightboxStore.getSnapshot,
    imageLightboxStore.getServerSnapshot
  );

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const draggingRef = useRef<{ x: number; y: number } | null>(null);

  // 每次打开新图都复位
  useEffect(() => {
    if (state) {
      queueMicrotask(() => {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      });
    }
  }, [state]);

  const close = useCallback(() => imageLightboxStore.close(), []);

  // ESC 关闭
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "+" || e.key === "=") setScale((s) => Math.min(s * 1.2, 8));
      else if (e.key === "-") setScale((s) => Math.max(s / 1.2, 0.2));
      else if (e.key === "0") {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, close]);

  // 打开时锁 body 滚动
  useEffect(() => {
    if (!state) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [state]);

  if (!state) return null;

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setScale((s) => Math.max(0.2, Math.min(8, s * delta)));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    draggingRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    setOffset({
      x: e.clientX - draggingRef.current.x,
      y: e.clientY - draggingRef.current.y,
    });
  };
  const onMouseUp = () => {
    draggingRef.current = null;
  };

  const onDoubleClick = () => {
    if (scale !== 1) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    } else {
      setScale(2);
    }
  };

  const onDownload = async () => {
    const src = state.src;
    const filename = guessFilename(src, state.title);
    try {
      // data: URL 直链
      if (src.startsWith("data:")) {
        triggerDownload(src, filename);
        return;
      }
      // 同源/http 资源：fetch 转 blob 再下，避免跨域 a[download] 失效
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      // 兜底：直接打新窗口
      window.open(src, "_blank", "noopener");
    }
  };

  return (
    <div
      onClick={close}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "var(--image-lightbox-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: draggingRef.current ? "grabbing" : "default",
        userSelect: "none",
      }}
    >
      {/* 顶部工具栏 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          right: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          color: "var(--image-lightbox-text)",
          fontSize: "var(--text-sm)",
          fontFamily: "var(--font-mono-stack)",
          pointerEvents: "auto",
        }}
      >
        <span style={{ opacity: 0.85, maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {state.title ?? "图片预览"}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <ToolbarBtn onClick={() => setScale((s) => Math.max(0.2, s / 1.2))} title="缩小 (-)">−</ToolbarBtn>
          <ToolbarBtn onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} title="复位 (0)">
            {Math.round(scale * 100)}%
          </ToolbarBtn>
          <ToolbarBtn onClick={() => setScale((s) => Math.min(8, s * 1.2))} title="放大 (+)">+</ToolbarBtn>
          <ToolbarBtn onClick={onDownload} title="下载">下载</ToolbarBtn>
          <ToolbarBtn onClick={close} title="关闭 (Esc)">✕</ToolbarBtn>
        </div>
      </div>

      {/* 图片 */}
      <Image
        src={state.src}
        alt={state.title ?? ""}
        width={1600}
        height={1000}
        unoptimized
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        draggable={false}
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: draggingRef.current ? "none" : "transform 0.12s ease",
          cursor: scale > 1 ? (draggingRef.current ? "grabbing" : "grab") : "zoom-in",
          boxShadow: "var(--image-lightbox-shadow)",
          borderRadius: "var(--radius-xs)",
        }}
      />

      {/* 底部提示 */}
      <div
        style={{
          position: "absolute",
          bottom: 14,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "var(--image-lightbox-text-muted)",
          fontSize: "var(--text-xs)",
          fontFamily: "var(--font-mono-stack)",
          pointerEvents: "none",
        }}
      >
        滚轮缩放 · 双击切换 · 拖拽移动 · Esc 关闭
      </div>
    </div>
  );
}

function ToolbarBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: "var(--image-lightbox-control-bg)",
        border: "1px solid var(--image-lightbox-control-border)",
        color: "var(--image-lightbox-text)",
        cursor: "pointer",
        fontSize: "var(--text-sm)",
        fontFamily: "var(--font-mono-stack)",
        padding: "4px 10px",
        borderRadius: "var(--radius-xs)",
        minWidth: 32,
      }}
    >
      {children}
    </button>
  );
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function guessFilename(src: string, title?: string): string {
  // data:image/png;base64,...
  const dataMatch = /^data:image\/([a-z0-9+]+)/i.exec(src);
  if (dataMatch) {
    const ext = dataMatch[1].toLowerCase().replace("jpeg", "jpg");
    return `${sanitize(title) || "image"}.${ext}`;
  }
  // /api/files?path=/abs/x.png&raw=1 → 取 path 参数尾名
  try {
    const u = new URL(src, "http://x");
    const p = u.searchParams.get("path");
    if (p) {
      const name = p.split("/").pop();
      if (name) return name;
    }
    const tail = u.pathname.split("/").pop();
    if (tail) return tail;
  } catch {}
  return `${sanitize(title) || "image"}.png`;
}

function sanitize(s?: string): string {
  if (!s) return "";
  return s.replace(/[^\w.\-一-龥]/g, "_").slice(0, 60);
}
