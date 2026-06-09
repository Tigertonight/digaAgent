"use client";

import { useEffect, useState } from "react";

// 同一句话的多语言轮播：「只要相信光,我来为你解决难题」—— 致敬迪迦
export const TYPEWRITER_PHRASES = [
  "只要相信光,我来为你解决难题。",
  "Just believe in the light — I'll solve your problems.",
  "光を信じれば、私が君の問題を解決する。",
  "빛을 믿기만 하면, 제가 당신의 문제를 해결해드릴게요.",
];

export function Typewriter({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    if (phrases.length <= 1) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setPhraseIdx(Math.floor(Math.random() * phrases.length));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [phrases.length]);

  useEffect(() => {
    const blink = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx];
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      queueMicrotask(() => {
        setDeleting(false);
        setPhraseIdx((i) => (i + 1) % phrases.length);
      });
    } else {
      const next = deleting
        ? current.slice(0, text.length - 1)
        : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, phraseIdx, phrases]);

  return (
    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
      {text}
      <span
        style={{
          opacity: caretOn ? 1 : 0,
          color: "var(--accent)",
          marginLeft: 1,
        }}
      >
        ▍
      </span>
    </span>
  );
}
