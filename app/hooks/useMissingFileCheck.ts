"use client";

/**
 * useMissingFileCheck —— 结构化 Composer Phase C：
 *
 * 监听 pendingFiles 列表变化，对每条引用调 POST /api/files?op=exists，结果汇成
 * 一个 Set<string>，UI 可据此把 FileChip 改 warning tone + 加 tooltip。
 *
 * 设计要点：
 *   - 只在新出现的路径触发 fetch（避免每次列表变化全量重检）
 *   - 单 fetch 周期 200ms 内合批（防止用户快速点 mention 时 N 次 round-trip）
 *   - 单一来源：missingPaths Set；存在 / 检查中 / 不存在 三态由 UI 自行从 hook 派生
 *   - 路径被移除时清理对应记忆
 */

import { useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "@/lib/session-runner";

interface CheckOutcome {
  /** 检查过且确认存在 */
  knownExists: Set<string>;
  /** 检查过且确认缺失 / 不可读 */
  knownMissing: Set<string>;
}

export interface UseMissingFileCheckReturn {
  /** 已被服务端确认缺失的路径（用于 UI warning tone）。 */
  missingPaths: Set<string>;
}

export function useMissingFileCheck(
  pendingFiles: PendingAttachment[]
): UseMissingFileCheckReturn {
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set());
  const cacheRef = useRef<CheckOutcome>({
    knownExists: new Set(),
    knownMissing: new Set(),
  });
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 先把 pendingFiles 变化清算到 missingPaths：
    //   - 已知 missing 但不再在列表里 → 从 cacheMissing 清掉、UI Set 同步
    //   - 已知 exists / unknown 维持现状
    const current = new Set(pendingFiles.map((p) => p.path));
    const cache = cacheRef.current;
    let dirty = false;
    for (const p of [...cache.knownMissing]) {
      if (!current.has(p)) {
        cache.knownMissing.delete(p);
        dirty = true;
      }
    }
    for (const p of [...cache.knownExists]) {
      if (!current.has(p)) cache.knownExists.delete(p);
    }
    if (dirty) {
      setMissingPaths(new Set(cache.knownMissing));
    }

    // 收集"未检查过 + 当前需要"的 path，攒进 pendingPathsRef
    let needsBatch = false;
    for (const p of current) {
      if (cache.knownExists.has(p) || cache.knownMissing.has(p)) continue;
      pendingPathsRef.current.add(p);
      needsBatch = true;
    }
    if (!needsBatch) return;

    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(async () => {
      pendingTimerRef.current = null;
      const batch = [...pendingPathsRef.current];
      pendingPathsRef.current.clear();
      if (batch.length === 0) return;
      try {
        const r = await fetch("/api/files?op=exists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: batch }),
        });
        if (!r.ok) return;
        const data = (await r.json()) as { paths?: Record<string, boolean> };
        const paths = data.paths ?? {};
        for (const [p, ok] of Object.entries(paths)) {
          if (ok) cache.knownExists.add(p);
          else cache.knownMissing.add(p);
        }
        // 推进 UI：所有 missing（合并新旧）
        setMissingPaths(new Set(cache.knownMissing));
      } catch {
        // 失败保持未知；下一次列表变化会重试
      }
    }, 200);

    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [pendingFiles]);

  return { missingPaths };
}
