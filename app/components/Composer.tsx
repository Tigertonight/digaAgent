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

import NextImage from "next/image";
import type {
  ChangeEvent,
  KeyboardEvent,
  ClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  SyntheticEvent,
  RefObject,
  Dispatch,
  SetStateAction,
} from "react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
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
import type { AgentGoal } from "@/lib/goal/types";
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
import { GoalBar } from "./GoalBar";
import { useComposerInput } from "../hooks/useComposerInput";

/** autocomplete 弹层模式：跟 useAutocomplete 一致 */
type AcMode = "@" | "/" | null;

export interface ComposerProps {
  // ===== textarea =====
  inputKey: string;
  setInput: (v: string | ((cur: string) => string)) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPasteTextarea: (e: ClipboardEvent<HTMLTextAreaElement>) => void;

  // ===== 流式状态 =====
  streaming: boolean;
  abortable: boolean;
  compacting: boolean;
  agentId: string | null;
  pendingMessages: PendingMessagesSnapshot;
  goal: AgentGoal | null;

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
  onGoalPause: () => Promise<void> | void;
  onGoalResume: () => Promise<void> | void;
  onGoalClear: () => Promise<void> | void;

  // ===== Retry / Compact 错误 =====
  retryInfo: RetryInfo | null;
  compactError: string | null;

  // ===== Provider / Model / Thinking =====
  visibleProviders: ProviderInfo[];
  providerId: string;
  modelId: string;
  currentProvider: ProviderInfo | null | undefined;
  onChangeModel: (providerId: string, modelId: string) => void;
  onOpenAuth: (provider?: string) => void;
  onOpenModelsConfig: () => void;
  onOpenProviderSetup: () => void;
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
    inputKey,
    setInput,
    inputRef,
    fileInputRef,
    onKeyDown,
    onPasteTextarea,
    streaming,
    abortable,
    compacting,
    agentId,
    pendingMessages,
    goal,
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
    onGoalPause,
    onGoalResume,
    onGoalClear,
    retryInfo,
    compactError,
    visibleProviders,
    providerId,
    modelId,
    currentProvider,
    onChangeModel,
    onOpenAuth,
    onOpenModelsConfig,
    onOpenProviderSetup,
    supportsThinking,
    thinkingLevel,
    availableThinkingLevels,
    onChangeThinking,
    toolsCount,
    toggleTools,
    soundEnabled,
    onSoundToggle,
  } = props;
  const input = useComposerInput(inputKey);

  // ===== 本地 input state（P0-A）=====
  // 让 textarea 的高频 keystroke 只更新本地 state，避免每键都触发上层
  // RunnerState.input 写入（每次 setInput 都会走 updateActive→对比所有 runner→
  // 重渲染整棵 ChatApp），从而把输入卡顿降到最低。
  //
  // 同步策略：
  //   - onChange：只 setLocalInput（compose 阶段同样只更新 local，不调 refreshAutocomplete）
  //   - useDeferredValue + 空闲 effect：把 deferred 值低优先级地 flush 到 setInput
  //   - 外部写回（slash 命令、@文件、页面注释、history、setInput("")）：通过 useEffect
  //     检测 input prop 变化，且不是自己刚刚 flush 出去的值，则 sync 回 localInput
  //   - send/steer/followUp/abort/applyAutocomplete 前必须 flushSync 一次到上层，
  //     保证父组件的 useCallback 闭包（依赖 input）读到最新值
  const [localInput, setLocalInput] = useState<string>(input);
  const composingRef = useRef(false);
  // 记录"我们最近一次写给 setInput 的值"，避免 input prop 回流时把 local 覆盖回去
  const lastFlushedRef = useRef<string>(input);
  // setInput / refreshAutocomplete / closeAutocomplete 等回调本身可能依赖父组件
  // 闭包；用 ref 拿最新引用，flushSync 之后再调用，避免 stale closure。
  const setInputRef = useRef(setInput);
  setInputRef.current = setInput;
  const refreshAutocompleteRef = useRef(refreshAutocomplete);
  refreshAutocompleteRef.current = refreshAutocomplete;
  const closeAutocompleteRef = useRef(closeAutocomplete);
  closeAutocompleteRef.current = closeAutocomplete;
  const applyAutocompleteRef = useRef(applyAutocomplete);
  applyAutocompleteRef.current = applyAutocomplete;
  const sendRef = useRef(send);
  sendRef.current = send;
  const onSteerRef = useRef(onSteer);
  onSteerRef.current = onSteer;
  const onFollowUpRef = useRef(onFollowUp);
  onFollowUpRef.current = onFollowUp;
  const onAbortRef = useRef(onAbort);
  onAbortRef.current = onAbort;

  // 外部写回：父 input 变了且与本地不一致，且不是自己刚刚 flush 的值 → 覆盖回 local
  useEffect(() => {
    if (input !== localInput && input !== lastFlushedRef.current) {
      setLocalInput(input);
      lastFlushedRef.current = input;
    }
    // 注意：不把 localInput 加进依赖，否则每次本地改动也会跑这个 effect 把 local 覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // 低优先级 sync：deferred(localInput) 稳定后写回上层（idle / 下一次 paint 之后）
  const deferredLocalInput = useDeferredValue(localInput);
  useEffect(() => {
    if (deferredLocalInput === lastFlushedRef.current) return;
    type IdleHandle = number;
    const ric: ((cb: () => void) => IdleHandle) | undefined =
      typeof window !== "undefined" &&
      typeof (window as unknown as { requestIdleCallback?: unknown })
        .requestIdleCallback === "function"
        ? (cb) =>
            (
              window as unknown as {
                requestIdleCallback: (cb: () => void) => IdleHandle;
              }
            ).requestIdleCallback(cb)
        : undefined;
    const cic: ((h: IdleHandle) => void) | undefined =
      typeof window !== "undefined" &&
      typeof (window as unknown as { cancelIdleCallback?: unknown })
        .cancelIdleCallback === "function"
        ? (h) =>
            (
              window as unknown as {
                cancelIdleCallback: (h: IdleHandle) => void;
              }
            ).cancelIdleCallback(h)
        : undefined;
    const run = () => {
      lastFlushedRef.current = deferredLocalInput;
      setInputRef.current(deferredLocalInput);
    };
    if (ric) {
      const handle = ric(run);
      return () => {
        if (cic) cic(handle);
      };
    }
    const handle = window.setTimeout(run, 0);
    return () => window.clearTimeout(handle);
  }, [deferredLocalInput]);

  // 同步把 localInput flush 到上层：用于发送 / steer / followUp / abort /
  // applyAutocomplete 之前，保证父组件 useCallback 闭包读到最新文本。
  const flushLocalInput = useCallback(() => {
    if (lastFlushedRef.current === localInput) return;
    lastFlushedRef.current = localInput;
    flushSync(() => {
      setInputRef.current(localInput);
    });
  }, [localInput]);

  const handleSend = useCallback(() => {
    flushLocalInput();
    return sendRef.current();
  }, [flushLocalInput]);
  const handleSteer = useCallback(() => {
    flushLocalInput();
    return onSteerRef.current();
  }, [flushLocalInput]);
  const handleFollowUp = useCallback(() => {
    flushLocalInput();
    return onFollowUpRef.current();
  }, [flushLocalInput]);
  const handleAbort = useCallback(() => {
    flushLocalInput();
    return onAbortRef.current();
  }, [flushLocalInput]);
  // applyAutocomplete 同样依赖父 input 闭包（hook 里 input.slice(triggerPos)）
  const handlePickAutocomplete = useCallback(
    (item: AutocompleteItem) => {
      flushLocalInput();
      applyAutocompleteRef.current(item);
    },
    [flushLocalInput]
  );

  // textarea handlers
  const onTextareaChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      const caret = e.target.selectionStart ?? v.length;
      // 用 layout-style 同步更新本地值，UI 立刻看到字符
      setLocalInput(v);
      // IME compose 阶段不刷新 autocomplete，避免重复布局/请求
      if (!composingRef.current) {
        void refreshAutocompleteRef.current(v, caret);
      }
    },
    []
  );
  const onTextareaSelect = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return;
      const t = e.currentTarget;
      void refreshAutocompleteRef.current(
        t.value,
        t.selectionStart ?? t.value.length
      );
    },
    []
  );
  const onTextareaBlur = useCallback(() => {
    closeAutocompleteRef.current();
  }, []);
  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback(
    (e: ReactCompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      const t = e.currentTarget;
      const v = t.value;
      // compose 结束时 v 已是合成后的最终字符串；React onChange 也会跟一发
      // 但 caret 可能还没到末尾，这里直接用 selectionStart
      const caret = t.selectionStart ?? v.length;
      // 同步一下 localInput（防止某些浏览器 compositionend 早于最后一次 input）
      if (v !== localInput) setLocalInput(v);
      void refreshAutocompleteRef.current(v, caret);
    },
    [localInput]
  );
  const composerBlocker = getComposerBlocker({
    agentId,
    providerId,
    modelId,
    currentProvider,
    visibleProviders,
  });
  // hasDraft 用 localInput（最新本地值），避免每键都等上层 sync 才更新 send 按钮
  const hasDraft =
    localInput.trim().length > 0 ||
    pendingImages.length > 0 ||
    pendingFiles.length > 0;
  const sendDisabled =
    !hasDraft || (!agentId && Boolean(composerBlocker?.blocking));

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[820px]">
        {retryInfo && (
          <div
            className="mb-2 flex items-center gap-2 rounded-token-sm px-3 py-1.5 text-token-sm"
            style={{
              background: "var(--color-warning-bg)",
              border: "1px solid var(--color-warning)",
              color: "var(--color-warning)",
            }}
            role="status"
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
              style={{ background: "var(--color-warning)" }}
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
        <GoalBar
          goal={goal}
          agentId={agentId}
          disabled={!agentId}
          onPause={onGoalPause}
          onResume={onGoalResume}
          onClear={onGoalClear}
        />
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
                <NextImage
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`pending-${i}`}
                  width={64}
                  height={64}
                  unoptimized
                  className="block w-16 h-16 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(i)}
                  className="absolute top-0 right-0 flex h-5 w-5 items-center justify-center bg-[color:var(--color-overlay)] text-token-xs text-[color:var(--color-bg)] opacity-0 group-hover:opacity-100"
                  title="移除"
                >
                  ✕
                </button>
                <div
                  className="absolute bottom-0 left-0 right-0 truncate px-1 text-token-xs"
                  style={{
                    background: "var(--color-overlay)",
                    color: "var(--color-bg)",
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
        {composerBlocker?.blocking && !streaming && !abortable && (
          <ComposerReadinessBar
            blocker={composerBlocker}
            onOpenAuth={onOpenAuth}
            onOpenModelsConfig={onOpenModelsConfig}
            onOpenProviderSetup={onOpenProviderSetup}
          />
        )}
        {/* 卡片：textarea + 内嵌 Send */}
        <div
          className="relative rounded-token-lg border transition-colors focus-within:border-[color:var(--accent)]"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border)",
          }}
        >
          <textarea
            ref={inputRef}
            value={localInput}
            onChange={onTextareaChange}
            onSelect={onTextareaSelect}
            onBlur={onTextareaBlur}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onKeyDown={(e) => {
              // 动作键（Enter/Tab/箭头）会触发依赖父 input 的逻辑
              // （sendWithHistory / navigateInputHistory / autocomplete apply），
              // 先把 localInput 同步刷到上层，避免父闭包读到旧文本。
              if (
                !e.nativeEvent.isComposing &&
                (e.key === "Enter" ||
                  e.key === "Tab" ||
                  e.key === "ArrowUp" ||
                  e.key === "ArrowDown")
              ) {
                flushLocalInput();
              }
              onKeyDown(e);
            }}
            onPaste={onPasteTextarea}
            placeholder={
              streaming
                ? "Steer 立即注入 / Follow-up 排队…"
                : abortable
                  ? "当前进度仍在进行，可点击 Stop 中止…"
                  : "Message…"
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
              onPick={handlePickAutocomplete}
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
            {abortable ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleSteer()}
                  disabled={!streaming || (!localInput.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                  style={{ color: "var(--text-muted)" }}
                  title="Steer：立即注入当前 turn（不打断）"
                >
                  <Target size={12} />
                  Steer
                </button>
                <button
                  type="button"
                  onClick={() => void handleFollowUp()}
                  disabled={!streaming || (!localInput.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                  style={{ color: "var(--text-muted)" }}
                  title="Follow-up：排队，当前 turn 结束后自动发送"
                >
                  <CornerDownLeft size={12} />
                  Follow-up
                </button>
                <button
                  type="button"
                  onClick={() => void handleAbort()}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-token-sm bg-[color:var(--color-danger)] text-[color:var(--color-bg)] hover:opacity-90"
                  title="中止当前 turn"
                  aria-label="Stop"
                >
                  <span className="block h-2.5 w-2.5 rounded-sm bg-[color:var(--color-bg)]" />
                </button>
              </>
            ) : (
              <button
                onClick={() => void handleSend()}
                disabled={sendDisabled}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-token-ui font-medium text-[color:var(--color-bg)] transition-opacity disabled:opacity-40"
                style={{ background: "var(--accent)" }}
                title={composerBlocker?.blocking ? composerBlocker.title : "Send"}
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
              onChange={(e) => {
                const nextProviderId = e.target.value;
                const nextProvider = visibleProviders.find(
                  (p) => p.provider === nextProviderId
                );
                const nextModelId = nextProvider?.models[0]?.id ?? "";
                onChangeModel(nextProviderId, nextModelId);
              }}
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
                    ? "var(--color-danger)"
                    : "var(--border)",
                  background: "var(--bg-panel)",
                  color: compacting ? "var(--color-danger)" : "var(--text)",
                }}
                title={compacting ? "Cancel compaction" : "Compact context"}
              >
                <Minimize2
                  size={12}
                  style={{
                    color: compacting ? "var(--color-danger)" : "var(--text-muted)",
                  }}
                />
                {compacting ? "Compacting…" : "Compact"}
              </button>
              {compactError && (
                <div
                  className="absolute bottom-full right-0 z-50 mb-1.5 max-w-[320px] whitespace-nowrap rounded-md px-2.5 py-1.5 text-token-xs shadow-lg"
                  style={{
                    background: "var(--color-danger-bg)",
                    border: "1px solid var(--color-danger)",
                    color: "var(--color-danger)",
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
            <span className="ml-1 inline-flex items-center gap-1 text-[color:var(--color-warning)]">
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
        className="truncate text-token-sm font-mono"
        style={{ color: "var(--text)" }}
      >
        {att.name}
      </span>
      <span
        className="shrink-0 text-token-xs"
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
              className="mb-0.5 text-token-xs uppercase tracking-wide"
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

type ComposerBlocker =
  | {
      kind: "no-provider";
      blocking: true;
      title: string;
      detail: string;
      action: "setup";
      actionLabel: string;
    }
  | {
      kind: "no-model";
      blocking: true;
      title: string;
      detail: string;
      action: "models";
      actionLabel: string;
    }
  | {
      kind: "no-auth";
      blocking: true;
      provider: string;
      title: string;
      detail: string;
      action: "auth";
      actionLabel: string;
    }
  | {
      kind: "ready";
      blocking: false;
      title: string;
      detail: string;
      action: null;
      actionLabel: null;
    };

function getComposerBlocker({
  agentId,
  providerId,
  modelId,
  currentProvider,
  visibleProviders,
}: {
  agentId: string | null;
  providerId: string;
  modelId: string;
  currentProvider: ProviderInfo | null | undefined;
  visibleProviders: ProviderInfo[];
}): ComposerBlocker | null {
  if (agentId) {
    return {
      kind: "ready",
      blocking: false,
      title: "当前 session 已就绪",
      detail: "可以继续发消息、追加附件，或在右侧 Workbench 查看进度与产物。",
      action: null,
      actionLabel: null,
    };
  }
  if (visibleProviders.length === 0 || !providerId || !currentProvider) {
    return {
      kind: "no-provider",
      blocking: true,
      title: "还不能开始：没有可用模型",
      detail: "先完成一次模型接入；可以复用本机已有账号、填写 API Key，或添加本地/自定义端点。",
      action: "setup",
      actionLabel: "配置模型",
    };
  }
  if (!currentProvider.hasAuth) {
    return {
      kind: "no-auth",
      blocking: true,
      provider: currentProvider.provider,
      title: "还不能开始：当前 provider 未授权",
      detail: `${currentProvider.displayName} 需要先完成授权或填写 key。`,
      action: "auth",
      actionLabel: "打开 Auth",
    };
  }
  if (!modelId) {
    return {
      kind: "no-model",
      blocking: true,
      title: "还不能开始：没有选择模型",
      detail: "请为当前 provider 选择一个模型。",
      action: "models",
      actionLabel: "选择模型",
    };
  }
  return {
    kind: "ready",
    blocking: false,
    title: "准备就绪",
    detail: "输入任务后发送，agent 会把进度、输出和浏览器状态同步到 Workbench。",
    action: null,
    actionLabel: null,
  };
}

function ComposerReadinessBar({
  blocker,
  onOpenAuth,
  onOpenModelsConfig,
  onOpenProviderSetup,
}: {
  blocker: ComposerBlocker;
  onOpenAuth: (provider?: string) => void;
  onOpenModelsConfig: () => void;
  onOpenProviderSetup: () => void;
}) {
  const tone = blocker.blocking ? "var(--color-warning)" : "var(--color-success)";
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
      style={{
        background: blocker.blocking
          ? "var(--color-warning-bg)"
          : "var(--color-success-bg)",
        borderColor: blocker.blocking
          ? "var(--color-warning)"
          : "var(--color-success)",
        color: "var(--text)",
      }}
      data-testid="composer-readiness"
      role={blocker.blocking ? "alert" : "status"}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{blocker.title}</span>
        <span className="block truncate text-token-xs" style={{ color: "var(--text-muted)" }}>
          {blocker.detail}
        </span>
      </span>
      {blocker.action ? (
        <button
          type="button"
          onClick={() =>
            blocker.action === "auth"
              ? onOpenAuth(blocker.kind === "no-auth" ? blocker.provider : undefined)
              : blocker.action === "setup"
                ? onOpenProviderSetup()
              : onOpenModelsConfig()
          }
          className="shrink-0 rounded border px-2 py-1 text-token-xs hover:bg-[color:var(--bg-hover)]"
          style={{ borderColor: "var(--border)", color: "var(--text)" }}
        >
          {blocker.actionLabel}
        </button>
      ) : null}
    </div>
  );
}
