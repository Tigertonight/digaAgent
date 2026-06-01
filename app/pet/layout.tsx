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
    <html style={{ background: "transparent" }}>
      <body
        style={{
          margin: 0,
          padding: 0,
          background: "transparent",
          overflow: "hidden",
          userSelect: "none",
          width: "320px",
          height: "400px",
        }}
      >
        {children}
      </body>
    </html>
  );
}
