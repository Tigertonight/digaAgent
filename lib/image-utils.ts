/** 图片处理工具：File → ImageContentLite */
import type { ImageContentLite } from "./types";

/**
 * 把 File 读成 base64（不带 data: 前缀）和 mimeType。
 * 不做压缩 —— SDK 内部会按需 resize。
 */
export async function fileToImageContent(file: File): Promise<ImageContentLite> {
  if (!file.type.startsWith("image/")) {
    throw new Error(`not an image: ${file.type || "unknown"}`);
  }
  const dataUrl = await readFileAsDataURL(file);
  // dataUrl: "data:image/png;base64,iVBORw0..."
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("failed to parse data url");
  return {
    type: "image",
    mimeType: m[1],
    data: m[2],
  };
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error("read error"));
    fr.onload = () => {
      const r = fr.result;
      if (typeof r === "string") resolve(r);
      else reject(new Error("expected string result"));
    };
    fr.readAsDataURL(file);
  });
}

/** 从粘贴板事件抽取图片 File 列表 */
export function extractImagesFromClipboard(
  e: React.ClipboardEvent | ClipboardEvent
): File[] {
  const out: File[] = [];
  const cd =
    (e as React.ClipboardEvent).clipboardData ??
    (e as ClipboardEvent).clipboardData;
  if (!cd) return out;
  // items 优先（能拿到 PNG/JPEG 等截图）
  if (cd.items && cd.items.length > 0) {
    for (let i = 0; i < cd.items.length; i++) {
      const it = cd.items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  // 兜底：files
  if (out.length === 0 && cd.files && cd.files.length > 0) {
    for (let i = 0; i < cd.files.length; i++) {
      const f = cd.files[i];
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

/** 估算 base64 解码后字节数 */
export function approxBase64Bytes(b64: string): number {
  // base64 4 chars = 3 bytes
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
