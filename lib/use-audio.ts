"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const STORAGE_KEY = "pi-sound-enabled";

/**
 * 双音 sine chord 完成提示音 + 静音开关。
 * 移植自 pi-web/hooks/useAudio.ts。
 */
export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore (private mode)
      }
      return next;
    });
  }, []);

  const playDone = useCallback(() => {
    if (!enabledRef.current) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const freqs = [523.25, 659.25];
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = freq;
        const t = now + i * 0.18;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        osc.start(t);
        osc.stop(t + 0.45);
      });
      setTimeout(() => ctx.close(), 1200);
    } catch {
      // AudioContext not available
    }
  }, []);

  return {
    soundEnabled: enabled,
    onSoundToggle: toggle,
    playDoneSound: playDone,
  };
}
