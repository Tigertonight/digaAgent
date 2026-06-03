import "server-only";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

export interface ClipboardWriteResult {
  ok: true;
  length: number;
}

export async function writeClipboardText(
  text: string
): Promise<ClipboardWriteResult> {
  const value = text.trim();
  if (!value) throw new Error("text required");
  await copyToClipboard(value);
  return { ok: true, length: value.length };
}
