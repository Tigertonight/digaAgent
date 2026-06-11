"use client";

interface DropOverlayProps {
  isDragOver: boolean;
}

export function DropOverlay({ isDragOver }: DropOverlayProps) {
  if (!isDragOver) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center"
      style={{
        background: "color-mix(in srgb, var(--accent) 6%, transparent)",
        backdropFilter: "blur(1px)",
        animation: "drop-zone-in 0.15s ease both",
      }}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {[0, 0.8, 1.6].map((delay) => (
          <div
            key={delay}
            className="absolute rounded-full"
            style={{
              height: 720,
              width: 720,
              border: "1.5px solid color-mix(in srgb, var(--accent) 50%, transparent)",
              transformOrigin: "center",
              animation:
                "drop-ripple 2.4s ease-out infinite backwards",
              animationDelay: `${delay}s`,
            }}
          />
        ))}
      </div>
      <svg
        width="280"
        height="280"
        viewBox="0 0 140 140"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          filter: "drop-shadow(0 6px 18px color-mix(in srgb, var(--accent) 18%, transparent))",
        }}
      >
        <rect
          x="28"
          y="44"
          width="84"
          height="60"
          rx="8"
          fill="color-mix(in srgb, var(--accent) 8%, transparent)"
          stroke="color-mix(in srgb, var(--accent) 50%, transparent)"
          strokeWidth="1.8"
        />
        <path
          d="M36 100 L54 72 L68 88 L80 74 L104 100Z"
          fill="color-mix(in srgb, var(--accent) 16%, transparent)"
          stroke="color-mix(in srgb, var(--accent) 40%, transparent)"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle
          cx="96"
          cy="58"
          r="8"
          fill="color-mix(in srgb, var(--accent) 22%, transparent)"
          stroke="color-mix(in srgb, var(--accent) 55%, transparent)"
          strokeWidth="1.6"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          bottom: "22%",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: "var(--text-ui)",
          color: "color-mix(in srgb, var(--accent) 80%, transparent)",
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: 0,
        }}
      >
        松手添加 · 图片直接预览,文件/文件夹以 @path 形式注入
      </div>
    </div>
  );
}
