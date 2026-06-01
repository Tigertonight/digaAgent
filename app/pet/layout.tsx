import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Diga Pet",
};

export default function PetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: "120px",
        height: "160px",
        overflow: "visible",
        background: "transparent",
        userSelect: "none",
        WebkitAppRegion: "no-drag" as React.CSSProperties["WebkitAppRegion"],
      }}
    >
      {children}
    </div>
  );
}
