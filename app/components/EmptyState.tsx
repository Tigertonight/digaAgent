"use client";

import { Typewriter, TYPEWRITER_PHRASES } from "./Typewriter";
import { BrandLogo } from "./BrandLogo";

export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-[820px]">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginLeft: 16,
            marginRight: 52,
            fontFamily: "var(--font-mono)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
              flex: 1,
              lineHeight: 1.4,
            }}
          >
            <div style={{ flexShrink: 0 }}>
              <BrandLogo size={56} />
            </div>
            <span
              style={{
                fontSize: 22,
                color: "var(--text)",
                fontWeight: 700,
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Diga Agent
            </span>
            <span
              style={{
                fontSize: 14,
                minWidth: 0,
                flex: 1,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              <Typewriter phrases={TYPEWRITER_PHRASES} />
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 2,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              web{" "}
              <span style={{ color: "var(--text)" }}>
                v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}
              </span>
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              pi{" "}
              <span style={{ color: "var(--text)" }}>
                v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
