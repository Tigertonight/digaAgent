/**
 * useComposerAttachments — 输入框图片/文件附件子模块（RFC-1 阶段 B2-b）
 *
 * 把 ChatApp.tsx 内"用户拖入/粘贴附件"相关的 4 个 callback 收口：
 *
 *   addImageFiles      —— 一组 File 转 ImageContentLite，append 到 pendingImages
 *   removePendingImage —— 按 index 从 pendingImages 移除
 *   onDropFiles        —— 拖入分流（图片走 base64 内联，其它走 @path 引用）
 *   removePendingFile  —— 按 path 从 pendingFiles 移除
 *
 * 设计要点：
 * 1. hook 完全无状态——pendingImages / pendingFiles 仍是 runner state，
 *    通过 setter 注入；hook 只做"接收用户输入 → 转换 → 落入 runner"
 * 2. kindFromName 作为内部 helper 一起搬入（ChatApp 内仅 onDropFiles 调用一次）
 * 3. Web 模式没有 webUtils → 在 onDropFiles 内通过 setError 提示用户改用文件浏览器
 *
 * 不在 hook 内的：
 * - PendingAttachment / PendingAttachmentKind 类型定义（已在 lib/session-runner.ts 导出）
 * - FileChip 视图组件（C 阶段 UI 拆分）
 */
import { useCallback } from "react";
import type { ImageContentLite } from "@/lib/types";
import { fileToImageContent } from "@/lib/image-utils";
import { getElectronApi } from "@/lib/electron-bridge";
import type {
  PendingAttachment,
  PendingAttachmentKind,
} from "@/lib/session-runner";
import { userFacingMessage } from "@/lib/user-facing-error";

type Updater<T> = T | ((prev: T) => T);

/** 按扩展名粗分类，只用来选附件 chip 的 icon/底色 */
function kindFromName(
  name: string
): Exclude<PendingAttachmentKind, "folder"> {
  const lower = name.toLowerCase();
  if (/\.(zip|tar|gz|tgz|bz2|7z|rar|xz)$/.test(lower)) return "archive";
  if (/\.pdf$/.test(lower)) return "pdf";
  if (/\.(csv|tsv|xlsx?|ods|numbers)$/.test(lower)) return "table";
  if (/\.(md|markdown|txt|rtf|docx?|pages|odt)$/.test(lower)) return "doc";
  if (
    /\.(js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|cs|rb|php|swift|kt|sh|bash|zsh|json|toml|yaml|yml|xml|html?|css|scss|sql)$/.test(
      lower
    )
  )
    return "code";
  return "other";
}

export interface UseComposerAttachmentsParams {
  setPendingImages: (v: Updater<ImageContentLite[]>) => void;
  setPendingFiles: (v: Updater<PendingAttachment[]>) => void;
  setError: (e: string | null) => void;
}

export interface UseComposerAttachmentsReturn {
  addImageFiles: (files: File[] | FileList) => Promise<void>;
  removePendingImage: (idx: number) => void;
  onDropFiles: (files: File[]) => void;
  removePendingFile: (path: string) => void;
}

export function useComposerAttachments(
  params: UseComposerAttachmentsParams
): UseComposerAttachmentsReturn {
  const { setPendingImages, setPendingFiles, setError } = params;

  /** 把一组 File 转 ImageContentLite 并 append 到 pendingImages */
  const addImageFiles = useCallback(
    async (files: File[] | FileList) => {
      const arr = Array.from(files).filter((f) =>
        f.type.startsWith("image/")
      );
      if (arr.length === 0) return;
      try {
        const converted = await Promise.all(
          arr.map((f) => fileToImageContent(f))
        );
        setPendingImages((prev) => [...prev, ...converted]);
      } catch (e) {
        setError(userFacingMessage(e));
      }
    },
    [setPendingImages, setError]
  );

  const removePendingImage = useCallback(
    (idx: number) => {
      setPendingImages((prev) => prev.filter((_, i) => i !== idx));
    },
    [setPendingImages]
  );

  /**
   * 拖入分流：
   *   - 图片（image/*）→ 转 base64 进 pendingImages 内联预览
   *   - 其它（zip/pdf/csv/md/txt/word/folder）→ 通过 Electron webUtils 拿绝对路径，
   *     以"附件 chip"塞进 pendingFiles，发送时自动拼成 @path 注入 prompt 头
   *
   * Web 模式没有 webUtils → 文件路径不可得，提示用户改用文件浏览器。
   */
  const onDropFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      const others = files.filter((f) => !f.type.startsWith("image/"));

      if (images.length) void addImageFiles(images);

      if (others.length === 0) return;

      const api = getElectronApi();
      if (!api?.getPathForFile) {
        setError(
          "拖拽非图片文件需要在桌面端使用（浏览器无法获取绝对路径）。请用左下文件浏览器选择文件。"
        );
        return;
      }
      const newAttachments: PendingAttachment[] = [];
      for (const f of others) {
        const p = api.getPathForFile(f);
        if (!p) continue;
        // File API 给文件夹时 type === "" 且 size === 0，作为粗略识别
        const isFolder =
          f.type === "" && f.size === 0 && !/\.[a-z0-9]{1,8}$/i.test(f.name);
        newAttachments.push({
          path: p,
          name: f.name || p.split("/").pop() || p,
          size: isFolder ? null : f.size,
          kind: isFolder ? "folder" : kindFromName(f.name),
        });
      }
      if (newAttachments.length === 0) {
        setError("无法获取拖入文件的路径。");
        return;
      }
      setPendingFiles((prev) => {
        const seen = new Set(prev.map((a) => a.path));
        return [
          ...prev,
          ...newAttachments.filter((a) => !seen.has(a.path)),
        ];
      });
    },
    [addImageFiles, setPendingFiles, setError]
  );

  const removePendingFile = useCallback(
    (path: string) => {
      setPendingFiles((prev) => prev.filter((a) => a.path !== path));
    },
    [setPendingFiles]
  );

  return {
    addImageFiles,
    removePendingImage,
    onDropFiles,
    removePendingFile,
  };
}
