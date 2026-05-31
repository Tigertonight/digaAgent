import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "./globals.css";

const notoMono = Noto_Sans_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Diga Agent",
  description: "Diga Agent — self-hosted coding agent UI",
  icons: {
    icon: "/brand/diga-logo-main.webp",
  },
};

// 在 hydrate 前同步把 theme 应用到 <html>，避免 FOUC
const themeBootstrap = `
(function(){
  try {
    var t = localStorage.getItem("pi-theme");
    if (t !== "light" && t !== "dark") t = "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      data-theme="light"
      className={notoMono.variable}
      suppressHydrationWarning
    >
      <head>
        <script

          dangerouslySetInnerHTML={{ __html: themeBootstrap }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
