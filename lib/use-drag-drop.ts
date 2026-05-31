"use client";

/**
 * 监听 dragenter/over/leave/drop，仅当 dataTransfer.items 含 image/* 时激活 overlay。
 * 用 counterRef 处理冒泡 leave 抖动。
 */
import { useState, useCallback, useRef } from "react";

export function useDragDrop(onDrop: (files: File[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  const hasImages = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.items).some((it) => it.type.startsWith("image/"));

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasImages(e)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasImages(e)) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      counterRef.current = 0;
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onDrop(files);
    },
    [onDrop]
  );

  return {
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
