import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Diga Agent",
  description: "Diga Agent — self-hosted coding agent UI",
  icons: {
    icon: "/brand/diga-logo-main.webp",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      data-theme="light"
      suppressHydrationWarning
    >
      <head />
      <body>{children}</body>
    </html>
  );
}
