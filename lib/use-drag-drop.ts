"use client";

/**
 * 监听 dragenter/over/leave/drop。
 * 任何 dataTransfer 含 Files 都激活 overlay（图片/文档/zip/文件夹一视同仁）。
 * 用 counterRef 处理冒泡 leave 抖动。
 *
 * onDrop 回调拿到 files 自己分流（图片塞 pendingImages,其它走 @path 注入输入框）。
 */
import { useState, useCallback, useRef } from "react";

export function useDragDrop(onDrop: (files: File[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  /**
   * dataTransfer.items 至少有一个 kind === "file" 即认为是有效拖拽。
   * - 浏览器拖文件:items[i].kind === "file"
   * - 文件夹同样命中(items[i].webkitGetAsEntry().isDirectory === true)
   * - 单纯拖文本/链接:items[i].kind === "string",不激活 overlay
   */
  const hasFiles = (e: React.DragEvent) => {
    const items = e.dataTransfer?.items;
    if (!items) return false;
    for (const it of items) {
      if (it.kind === "file") return true;
    }
    return false;
  };

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    // 显式声明 copy 类型,系统光标显示成 + 而不是禁止图标
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
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
