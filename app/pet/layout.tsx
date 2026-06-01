import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Diga Pet",
};

export default function PetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // pet/layout.tsx 不输出 <html>/<body>（由 root layout 控制）
  // 透明背景由 page.tsx 的 useEffect 通过 JS 直接设置 document.documentElement 和 body
  return <>{children}</>;
}
