/**
 * Composer mode chip 解析 helper。
 *
 * 设计原则（用户规格）：用户敲 "/goal " 或 "/workflow " 后，前端立即把这个
 * 意图提到独立的 chip，textarea 只保留正文。这让用户气泡 / sidebar /
 * session jsonl 都看到用户原话，不会以 "/goal …" 形式留下机器友好文本。
 *
 * 此 helper 只负责字符串到结构的转换；状态写入由调用方完成。
 */

export type ComposerMode = "goal" | "workflow";

export const COMPOSER_MODES: readonly ComposerMode[] = ["goal", "workflow"];

export interface ModeExtractionResult {
  mode: ComposerMode | null;
  /** 抽离 mode token 之后的剩余文本（不再含 "/goal " 前缀）。 */
  text: string;
}

/**
 * 在用户键入时识别 mode：仅当**文本以 "/goal " 或 "/workflow " 开头**时（注意
 * 命令名后要有至少一个空白字符），把命令名提为 mode、剩余作为正文返回。
 *
 * 严格匹配 "/goalXXX" 之类不识别（与 lib/slash-command 保持一致）。
 *
 * 没有 mode 命中时返回 mode=null + text 原样（不 trim，保留用户输入光标位）。
 */
export function extractModeFromInput(raw: string): ModeExtractionResult {
  if (!raw) return { mode: null, text: raw };
  for (const mode of COMPOSER_MODES) {
    const prefix = `/${mode}`;
    if (raw.startsWith(prefix)) {
      const next = raw.charAt(prefix.length);
      // 要求命令名后跟空格 / 制表符，避免 /goalxxx 误识别。
      if (next === " " || next === "\t") {
        return { mode, text: raw.slice(prefix.length + 1) };
      }
      // "/goal" 后是换行 / 字符串末尾 → 视为「正在打」，先不识别（让用户继续输入）。
    }
  }
  return { mode: null, text: raw };
}

/**
 * 给定 mode 和当前正文，给出"如果用户继续输入会出现的展示等价文本"。
 *
 * 仅在调试 / 兼容路径用：例如复制 Composer 内容到剪贴板时，给一个用户能再次
 * 粘贴回 Composer 复现的字面文本。生产 send 路径使用 mode + text 结构化字段。
 */
export function serializeModeAndText(
  mode: ComposerMode | null,
  text: string
): string {
  if (!mode) return text;
  return text ? `/${mode} ${text}` : `/${mode}`;
}
