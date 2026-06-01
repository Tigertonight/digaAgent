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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(({ WebkitAppRegion: "no-drag" } as any) as React.CSSProperties),
      }}
    >
      {children}
    </div>
  );
}
