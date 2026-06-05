"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";

const MAIN_LOGO = "/brand/diga-logo-main.webp";

const HOVER_LOGO_FRAMES = [
  "/brand/diga-logo-frames/diga-logo-01.webp",
  "/brand/diga-logo-frames/diga-logo-05.webp",
  "/brand/diga-logo-frames/diga-logo-06.webp",
  "/brand/diga-logo-frames/diga-logo-07.webp",
  "/brand/diga-logo-frames/diga-logo-08.webp",
  "/brand/diga-logo-frames/diga-logo-09.webp",
  "/brand/diga-logo-frames/diga-logo-10.webp",
  "/brand/diga-logo-frames/diga-logo-11.webp",
  "/brand/diga-logo-frames/diga-logo-12.webp",
  "/brand/diga-logo-frames/diga-logo-13.webp",
  "/brand/diga-logo-frames/diga-logo-14.webp",
  "/brand/diga-logo-frames/diga-logo-15.webp",
  "/brand/diga-logo-frames/diga-logo-16.webp",
];

interface BrandLogoProps {
  size: number;
  className?: string;
}

function BrandLogoComponent({ size, className }: BrandLogoProps) {
  const [src, setSrc] = useState(MAIN_LOGO);
  const frameIndexRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopCycling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    frameIndexRef.current = 0;
    setSrc(MAIN_LOGO);
  }, []);

  const startCycling = useCallback(() => {
    if (intervalRef.current) return;

    setSrc(HOVER_LOGO_FRAMES[0]);
    frameIndexRef.current = 1;
    intervalRef.current = setInterval(() => {
      setSrc(HOVER_LOGO_FRAMES[frameIndexRef.current % HOVER_LOGO_FRAMES.length]);
      frameIndexRef.current += 1;
    }, 70);
  }, []);

  useEffect(() => stopCycling, [stopCycling]);

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flex: "0 0 auto",
      }}
      onMouseEnter={startCycling}
      onMouseLeave={stopCycling}
      onFocus={startCycling}
      onBlur={stopCycling}
      tabIndex={-1}
    >
      { }
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{
          display: "block",
          width: size,
          height: size,
          objectFit: "contain",
          imageRendering: "pixelated",
        }}
      />
    </span>
  );
}

export const BrandLogo = memo(BrandLogoComponent);
