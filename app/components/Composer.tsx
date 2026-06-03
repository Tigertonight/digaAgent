"use client";

/**
 * Composer —— 输入区（textarea + 控制条 + 内嵌发送/Steer/Follow-up/Abort）。
 * RFC-1 阶段 C5：从 ChatApp.tsx 抽出，纯展示+受控组件。
 *
 * 结构：
 *   1. Retry 提示条（顶部）
 *   2. 图片附件预览 + ✕ 移除
 *   3. 文件 chip 预览 + ✕ 移除
 *   4. 卡片：textarea + InputAutocomplete 浮层 + 隐藏 file input
 *      右下：streaming 时 [Steer | Follow-up | Abort]；空闲时 [Send]
 *   5. 控制条：[+图片] [Provider] [Model] [Thinking] [Tools] [Compact] [🔊]
 *
 * 设计要点：
 *   - 纯受控：所有 state 走 props，自身只放局部 DOM 用的 ref（fileInputRef 也来自父）
 *   - props 接口约 36 个，但每个都 1:1 对应原 ChatApp 内联代码，零行为改动
 *   - PendingAttachment 类型从 lib/session-runner 统一来源（去重）
 */

import type {
  ChangeEvent,
  KeyboardEvent,
  ClipboardEvent,
  RefObject,
  Dispatch,
  SetStateAction,
} from "react";
import {
  Target,
  CornerDownLeft,
  AlertTriangle,
  Image as ImageIcon,
  Cpu,
  Lightbulb,
  Wrench,
  Minimize2,
  Volume2,
  VolumeX,
  FileText,
  Folder,
  FileArchive,
  FileSpreadsheet,
  FileCode,
  Paperclip,
  X,
} from "lucide-react";
import type {
  PendingAttachment,
  PendingMessagesSnapshot,
  RetryInfo,
  ToolsCountSnapshot,
} from "@/lib/session-runner";
import type {
  ProviderInfo,
  ImageContentLite,
  ThinkingLevel,
} from "@/lib/types";
import { THINKING_LEVEL_LABELS } from "@/lib/types";
import { approxBase64Bytes, formatBytes } from "@/lib/image-utils";
import { InputAutocomplete } from "./InputAutocomplete";
import type { AutocompleteItem } from "./InputAutocomplete";
import { PillSelect } from "./PillSelect";
import { ProviderIcon } from "./ProviderIcon";

/** autocomplete 弹层模式：跟 useAutocomplete 一致 */
type AcMode = "@" | "/" | null;

export interface ComposerProps {
  // ===== textarea =====
  input: string;
  setInput: (v: string | ((cur: string) => string)) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPasteTextarea: (e: ClipboardEvent<HTMLTextAreaElement>) => void;

  // ===== 流式状态 =====
  streaming: boolean;
  compacting: boolean;
  agentId: string | null;
  pendingMessages: PendingMessagesSnapshot;

  // ===== 附件 =====
  pendingImages: ImageContentLite[];
  pendingFiles: PendingAttachment[];
  removePendingImage: (index: number) => void;
  removePendingFile: (path: string) => void;
  addImageFiles: (files: FileList) => Promise<void> | void;

  // ===== 自动补全 =====
  acMode: AcMode;
  acItems: AutocompleteItem[];
  acIndex: number;
  setAcIndex: Dispatch<SetStateAction<number>>;
  applyAutocomplete: (item: AutocompleteItem) => void;
  refreshAutocomplete: (value: string, cursor: number) => Promise<void> | void;
  closeAutocomplete: () => void;

  // ===== 发送动作 =====
  send: () => Promise<void> | void;
  onSteer: () => Promise<void> | void;
  onFollowUp: () => Promise<void> | void;
  onAbort: () => Promise<void> | void;
  onCompact: () => Promise<void> | void;
  onAbortCompaction: () => Promise<void> | void;

  // ===== Retry / Compact 错误 =====
  retryInfo: RetryInfo | null;
  compactError: string | null;

  // ===== Provider / Model / Thinking =====
  visibleProviders: ProviderInfo[];
  providerId: string;
  modelId: string;
  currentProvider: ProviderInfo | null | undefined;
  onChangeModel: (providerId: string, modelId: string) => void;
  supportsThinking: boolean;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  onChangeThinking: (lv: ThinkingLevel) => Promise<void> | void;

  // ===== Tools =====
  toolsCount: ToolsCountSnapshot | null;
  toggleTools: () => void;

  // ===== Sound =====
  soundEnabled: boolean;
  onSoundToggle: () => void;
}

export function Composer(props: ComposerProps) {
  const {
    input,
    setInput,
    inputRef,
    fileInputRef,
    onKeyDown,
    onPasteTextarea,
    streaming,
    compacting,
    agentId,
    pendingMessages,
    pendingImages,
    pendingFiles,
    removePendingImage,
    removePendingFile,
    addImageFiles,
    acMode,
    acItems,
    acIndex,
    setAcIndex,
    applyAutocomplete,
    refreshAutocomplete,
    closeAutocomplete,
    send,
    onSteer,
    onFollowUp,
    onAbort,
    onCompact,
    onAbortCompaction,
    retryInfo,
    compactError,
    visibleProviders,
    providerId,
    modelId,
    currentProvider,
    onChangeModel,
    supportsThinking,
    thinkingLevel,
    availableThinkingLevels,
    onChangeThinking,
    toolsCount,
    toggleTools,
    soundEnabled,
    onSoundToggle,
  } = props;

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[820px]">
        {retryInfo && (
          <div
            className="mb-2 px-3 py-1.5 rounded-md text-[12px] flex items-center gap-2"
            style={{
              background: "rgba(234,179,8,0.10)",
              border: "1px solid rgba(234,179,8,0.35)",
              color: "#a16207",
            }}
            role="status"
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
              style={{ background: "#eab308" }}
            />
            <span className="font-medium">
              Retrying ({retryInfo.attempt}/{retryInfo.maxAttempts})…
            </span>
            {retryInfo.errorMessage && (
              <span
                className="truncate opacity-80"
                title={retryInfo.errorMessage}
              >
                {retryInfo.errorMessage}
              </span>
            )}
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pendingImages.map((img, i) => (
              <div
                key={i}
                className="relative group rounded border overflow-hidden"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-panel)",
                }}
                title={`${img.mimeType} · ${formatBytes(approxBase64Bytes(img.data))}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`pending-${i}`}
                  className="block w-16 h-16 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(i)}
                  className="absolute top-0 right-0 w-5 h-5 flex items-center justify-center text-[10px] bg-black/60 text-white opacity-0 group-hover:opacity-100"
                  title="移除"
                >
                  ✕
                </button>
                <div
                  className="absolute bottom-0 left-0 right-0 text-[10px] px-1 truncate"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    color: "#fff",
                  }}
                >
                  {formatBytes(approxBase64Bytes(img.data))}
                </div>
              </div>
            ))}
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {pendingFiles.map((att) => (
              <FileChip
                key={att.path}
                att={att}
                onRemove={() => removePendingFile(att.path)}
              />
            ))}
          </div>
        )}
        <QueuedMessagesBar pendingMessages={pendingMessages} />
        {/* 卡片：textarea + 内嵌 Send */}
        <div
          className="relative rounded-xl border transition-colors focus-within:border-[color:var(--accent)]"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border)",
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              void refreshAutocomplete(v, e.target.selectionStart ?? v.length);
            }}
            onSelect={(e) => {
              const t = e.currentTarget;
              void refreshAutocomplete(t.value, t.selectionStart ?? t.value.length);
            }}
            onBlur={() => closeAutocomplete()}
            onKeyDown={onKeyDown}
            onPaste={onPasteTextarea}
            placeholder={
              streaming ? "Steer 立即注入 / Follow-up 排队…" : "Message…"
            }
            rows={3}
            className="w-full bg-transparent resize-none outline-none border-0 text-sm px-4 pt-3 pb-12"
            style={{ color: "var(--text)" }}
          />
          {acMode && (
            <InputAutocomplete
              mode={acMode}
              items={acItems}
              selectedIndex={acIndex}
              onPick={applyAutocomplete}
              onHover={setAcIndex}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              if (e.target.files && e.target.files.length > 0) {
                void addImageFiles(e.target.files);
              }
              e.target.value = "";
            }}
          />
          {/* 卡片底部内嵌：右下 Send */}
          <div className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5">
            {streaming ? (
              <>
                <button
                  type="button"
                  onClick={() => void onSteer()}
                  disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                  style={{ color: "var(--text-muted)" }}
                  title="Steer：立即注入当前 turn（不打断）"
                >
                  <Target size={12} />
                  Steer
                </button>
                <button
                  type="button"
                  onClick={() => void onFollowUp()}
                  disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                  style={{ color: "var(--text-muted)" }}
                  title="Follow-up：排队，当前 turn 结束后自动发送"
                >
                  <CornerDownLeft size={12} />
                  Follow-up
                </button>
                <button
                  type="button"
                  onClick={() => void onAbort()}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-red-600 hover:bg-red-500"
                  title="中止当前 turn"
                  aria-label="Stop"
                >
                  <span className="block w-2.5 h-2.5 bg-white rounded-sm" />
                </button>
              </>
            ) : (
              <button
                onClick={() => void send()}
                disabled={
                  (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) ||
                  (!agentId && (!providerId || !modelId))
                }
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium text-white disabled:opacity-40 transition-opacity"
                style={{ background: "var(--accent)" }}
                title="Send"
              >
                <span aria-hidden="true">→</span>
                Send
              </button>
            )}
          </div>
        </div>

        {/* 控制条：与 pi-web 对齐的 6 控件横排 */}
        <div
          className="flex items-center mt-2 gap-1.5 text-xs flex-wrap"
          style={{ color: "var(--text-muted)" }}
        >
          {/* 1. 图片附件 */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center justify-center h-6 w-6 rounded-full border hover:bg-[color:var(--bg-hover)]"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
            }}
            title="附加图片"
            aria-label="附加图片"
          >
            <ImageIcon size={12} />
          </button>

          {/* 2. Provider（紧凑显示，仅当 show all 或多 provider 时） */}
          {visibleProviders.length > 1 && (
            <PillSelect
              value={providerId}
              onChange={(e) => onChangeModel(e.target.value, "")}
              title={
                currentProvider?.hasAuth
                  ? `auth: ${currentProvider.authSource ?? "?"} (${currentProvider.authLabel ?? ""})`
                  : "no auth configured"
              }
              leading={
                providerId ? (
                  <ProviderIcon provider={providerId} size={12} />
                ) : null
              }
            >
              {visibleProviders.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.hasAuth ? "✓ " : "  "}
                  {p.displayName}
                </option>
              ))}
            </PillSelect>
          )}

          {/* 3. Model（Cpu 图标 + 模型名） */}
          <PillSelect
            value={modelId}
            onChange={(e) => onChangeModel(providerId, e.target.value)}
            disabled={!currentProvider}
            widthClassName="max-w-[180px]"
            leading={<Cpu size={12} />}
            title={
              currentProvider
                ? `${currentProvider.displayName} / ${modelId || "(no model)"}`
                : "no provider"
            }
          >
            {currentProvider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.reasoning ? " ·thinking" : ""}
              </option>
            ))}
          </PillSelect>

          {/* 4. Thinking level（Lightbulb 图标） */}
          {supportsThinking && (
            <PillSelect
              value={thinkingLevel}
              onChange={(e) =>
                void onChangeThinking(e.target.value as ThinkingLevel)
              }
              leading={<Lightbulb size={12} />}
              title="thinking level"
            >
              {availableThinkingLevels.map((lv) => (
                <option key={lv} value={lv}>
                  {THINKING_LEVEL_LABELS[lv]}
                </option>
              ))}
            </PillSelect>
          )}

          {/* 5. Tools（Wrench 图标 + 启用计数） */}
          {agentId && (
            <button
              type="button"
              onClick={toggleTools}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-[color:var(--bg-hover)]"
              style={{
                borderColor: "var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
              }}
              title="管理可用工具"
            >
              <Wrench
                size={12}
                style={{ color: "var(--text-muted)" }}
              />
              {toolsCount
                ? `${toolsCount.active}/${toolsCount.total}`
                : "Tools"}
            </button>
          )}

          {/* 6. Compact（Minimize2 图标） */}
          {!streaming && agentId && (
            <span className="relative inline-flex">
              <button
                type="button"
                onClick={() =>
                  compacting ? void onAbortCompaction() : void onCompact()
                }
                className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-[color:var(--bg-hover)]"
                style={{
                  borderColor: compacting
                    ? "rgba(248,113,113,0.45)"
                    : "var(--border)",
                  background: "var(--bg-panel)",
                  color: compacting ? "#ef4444" : "var(--text)",
                }}
                title={compacting ? "Cancel compaction" : "Compact context"}
              >
                <Minimize2
                  size={12}
                  style={{
                    color: compacting ? "#ef4444" : "var(--text-muted)",
                  }}
                />
                {compacting ? "Compacting…" : "Compact"}
              </button>
              {compactError && (
                <div
                  className="absolute bottom-full mb-1.5 right-0 z-50 rounded-md px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap max-w-[320px]"
                  style={{
                    background: "rgba(127,29,29,0.95)",
                    border: "1px solid rgba(248,113,113,0.6)",
                    color: "#fecaca",
                  }}
                  role="alert"
                >
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle size={11} />
                    <span className="font-medium">Compact failed</span>
                  </div>
                  <div className="mt-0.5 opacity-90 truncate">
                    {compactError}
                  </div>
                </div>
              )}
            </span>
          )}

          {/* 7. 完成提示音开关 */}
          <button
            type="button"
            onClick={onSoundToggle}
            className="inline-flex items-center justify-center h-6 w-6 rounded-full border"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-panel)",
              color: soundEnabled
                ? "var(--text)"
                : "var(--text-muted)",
              opacity: soundEnabled ? 1 : 0.55,
            }}
            title={soundEnabled ? "完成提示音：开" : "完成提示音：关"}
            aria-label="Sound toggle"
            aria-pressed={soundEnabled}
          >
            {soundEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
          </button>

          {/* 右侧状态：no key 警告（折到末尾，避免抢眼） */}
          {currentProvider && !currentProvider.hasAuth && (
            <span className="text-yellow-600 dark:text-yellow-500 inline-flex items-center gap-1 ml-1">
              <AlertTriangle size={12} />
              no key
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 拖入附件 chip：图标 + 文件名 + 大小 + ✕ 移除 */
function FileChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  const Icon =
    att.kind === "folder"
      ? Folder
      : att.kind === "archive"
      ? FileArchive
      : att.kind === "table"
      ? FileSpreadsheet
      : att.kind === "code"
      ? FileCode
      : att.kind === "doc" || att.kind === "pdf"
      ? FileText
      : Paperclip;
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border pl-2 pr-1 py-1 max-w-[260px]"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
      }}
      title={att.path}
    >
      <Icon size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
      <span
        className="truncate text-[12px] font-mono"
        style={{ color: "var(--text)" }}
      >
        {att.name}
      </span>
      <span
        className="text-[10px] shrink-0"
        style={{ color: "var(--text-muted)" }}
      >
        {att.size == null ? "dir" : formatBytes(att.size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center justify-center w-4 h-4 rounded hover:bg-[color:var(--bg-hover)]"
        style={{ color: "var(--text-muted)", flexShrink: 0 }}
        title="移除"
        aria-label="移除附件"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function QueuedMessagesBar({
  pendingMessages,
}: {
  pendingMessages: PendingMessagesSnapshot;
}) {
  const items = [
    ...pendingMessages.steering.map((text, index) => ({
      id: `steer-${index}`,
      kind: "Steer",
      text,
    })),
    ...pendingMessages.followUp.map((text, index) => ({
      id: `follow-${index}`,
      kind: "Follow-up",
      text,
    })),
  ];
  if (items.length === 0) return null;

  return (
    <details
      className="mb-2 rounded-md border px-3 py-2 text-xs"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border-soft)",
        color: "var(--text-muted)",
      }}
    >
      <summary className="cursor-pointer select-none font-medium">
        Queued {items.length} message{items.length > 1 ? "s" : ""}
        {pendingMessages.followUp.length > 0 &&
          ` · ${pendingMessages.followUp.length} follow-up`}
        {pendingMessages.steering.length > 0 &&
          ` · ${pendingMessages.steering.length} steer`}
      </summary>
      <div className="mt-2 space-y-1.5">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="rounded border px-2 py-1.5"
            style={{
              borderColor: "var(--border-soft)",
              background: "var(--bg-panel-2)",
            }}
          >
            <div
              className="mb-0.5 text-[10px] uppercase tracking-wide"
              style={{ color: "var(--fg-faint)" }}
            >
              {index + 1}. {item.kind}
            </div>
            <div
              className="whitespace-pre-wrap break-words line-clamp-3"
              style={{ color: "var(--text)" }}
            >
              {item.text}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
