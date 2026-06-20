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
  MouseEvent as ReactMouseEvent,
  SyntheticEvent,
  RefObject,
  Dispatch,
  SetStateAction,
} from "react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
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
  ChevronDown,
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
import { extractModeFromInput } from "@/lib/composer/mode-chip";
import type { ComposerMode } from "@/lib/composer/mode-chip";
import { ModeChip } from "./ModeChip";
import { ProfileChip } from "./ProfileChip";
import { computeDisambigByPath } from "@/lib/composer/disambig";
import { extractStructuredInput } from "@/lib/composer/structured-input";
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
  statusHint?: string | null;

  // ===== 附件 =====
  pendingImages: ImageContentLite[];
  pendingFiles: PendingAttachment[];
  /** Phase C：服务端检查后认定不存在的路径集合。默认空。 */
  missingFilePaths?: Set<string>;
  /** F1：重复添加同路径时，ChatApp 设该 path 闪一下；300ms 后自清。 */
  flashedFilePath?: string | null;
  removePendingImage: (index: number) => void;
  removePendingFile: (path: string) => void;
  addImageFiles: (files: FileList) => Promise<void> | void;
  /** 程序化恢复 input 中的 @/abs/path 时，也走和粘贴/Explorer 一样的结构化入口。 */
  addPathAttachment: (absPath: string) => "added" | "duplicate";

  // ===== 结构化 Composer：mode chip =====
  /** 用户选中的 mode（当前 “goal” 或 “workflow”）。null = 普通 prompt。 */
  composerMode: ComposerMode | null;
  /** 从 chip 渲染点调：× 删除 / Backspace 连击删除。 */
  setComposerMode: (mode: ComposerMode | null) => void;

  // ===== 自动补全 =====
  acMode: AcMode;
  acItems: AutocompleteItem[];
  acIndex: number;
  setAcIndex: Dispatch<SetStateAction<number>>;
  applyAutocomplete: (item: AutocompleteItem) => void;
  refreshAutocomplete: (value: string, cursor: number) => Promise<void> | void;
  closeAutocomplete: () => void;

  // ===== 发送动作 =====
  send: (textOverride?: string) => Promise<void> | void;
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
    statusHint,
    pendingImages,
    pendingFiles,
    missingFilePaths,
    flashedFilePath,
    removePendingImage,
    removePendingFile,
    addImageFiles,
    addPathAttachment,
    composerMode,
    setComposerMode,
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
  const setComposerModeRef = useRef(setComposerMode);
  setComposerModeRef.current = setComposerMode;
  const composerModeRef = useRef<ComposerMode | null>(composerMode);
  composerModeRef.current = composerMode;

  // 外部写回：先归一化结构化旧字面量，再决定是否覆盖 local。
  // 同时兜底处理“程序化/重启恢复”的旧字面量：
  //   - /goal foo      → mode chip + textarea foo
  //   - /workflow foo  → mode chip + textarea foo
  //   - @/abs/path     → FileChip reference + textarea 删除该 token
  // 冷启动时 input/localInput/lastFlushed 可能三者相等，也必须先解析。
  useEffect(() => {
    const structured = extractStructuredInput(input, composerModeRef.current);
    if (structured.changed) {
      if (structured.mode) setComposerModeRef.current(structured.mode);
      for (const p of structured.paths) addPathAttachment(p);
      setLocalInput(structured.text);
      lastFlushedRef.current = structured.text;
      if (structured.text !== input) {
        // 回写父层，避免下一次发送/恢复仍带着机器友好字面量。
        setInputRef.current(structured.text);
      }
      return;
    }

    if (input !== localInput && input !== lastFlushedRef.current) {
      setLocalInput(input);
      lastFlushedRef.current = input;
    }
    // 注意：不把 localInput 加进依赖，否则每次本地改动也会跑这个 effect 把 local 覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, addPathAttachment]);

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
    // 【性能】点击 Send 后的响应路径优化：
    //   1. 立即同步清空 localInput（textarea 在下一帧显空，用户反馈快）。
    //   2. 同步写 lastFlushedRef 避免 effect 反复重置。
    //   3. 把原始文本传给 send(textOverride)，不再走 flushSync。
    // 这样点击 → textarea 清空 只走最轻量的 setState，不再被上层 store 列表 commit 拖累。
    const text = localInput;
    setLocalInput("");
    lastFlushedRef.current = "";
    return sendRef.current(text);
  }, [localInput]);
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

  // 结构化 Composer：“/goal ”/“/workflow ” 一旦出现在输入头，提为 chip。
  // 这里用 ref 保证 stale closure 安全。
  // chip “键盘选中”态：第一次 Backspace at caret=0 激活，第二次 Backspace 删除。
  // mode 被清时 chipActive 自然不再被渲染看到。避免在 effect 中 setState。
  const [chipActive, setChipActive] = useState(false);

  // F4：FileChip 多选集合。与 mode chipActive 独立。Backspace at caret=0 会优先处理多选删除。
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(
    () => new Set()
  );
  // 范围选择的“锚点” path，简化 Shift+Click 实现。
  const lastSelectedAnchorRef = useRef<string | null>(null);
  // 当 pendingFiles 里不再有某选中 path 时，同步清除。避免 effect 中 setState：
  // 直接在 onClick / onKeyDown / removePendingFile 路径中裁减。
  // 另外：外部 pendingFiles 变化路径（从设置 UI / 其他 hook）都走 useMemo 裁减。
  const selectedFilePathsSafe = useMemo(() => {
    const known = new Set(pendingFiles.map((p) => p.path));
    let dirty = false;
    const next = new Set<string>();
    for (const p of selectedFilePaths) {
      if (known.has(p)) next.add(p);
      else dirty = true;
    }
    return dirty ? next : selectedFilePaths;
  }, [pendingFiles, selectedFilePaths]);

  // F2：同名冲突时的 disambig 映射，只随 pendingFiles 重计。
  const disambigByPath = useMemo(
    () => computeDisambigByPath(pendingFiles.map((f) => f.path)),
    [pendingFiles]
  );

  // F3：是否走“折叠为 popover”。启发式：超过 5 个 chip 。
  // 联动实现上：Composer 顶部只渲染前 2 个 chip，剩下只作为 [N references ▾]。
  const collapseFiles = pendingFiles.length > 5;
  const [filesPopoverOpen, setFilesPopoverOpen] = useState(false);

  // textarea handlers
  const onTextareaChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      const caret = e.target.selectionStart ?? v.length;
      // 结构化：仅在还没选中 mode 时检测。识别到后提为 chip，
      // textarea 清空为该 mode 之后的正文。
      if (!composerModeRef.current) {
        const detected = extractModeFromInput(v);
        if (detected.mode) {
          // 准备上报 + 设为正文。调顺序：先 setLocalInput（起 caret 重置）再变 mode。
          setLocalInput(detected.text);
          setComposerModeRef.current(detected.mode);
          if (!composingRef.current) {
            void refreshAutocompleteRef.current(detected.text, detected.text.length);
          }
          return;
        }
      }
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
          <FileChipRow
            pendingFiles={pendingFiles}
            missingFilePaths={missingFilePaths}
            flashedFilePath={flashedFilePath}
            disambigByPath={disambigByPath}
            collapse={collapseFiles}
            popoverOpen={filesPopoverOpen}
            setPopoverOpen={setFilesPopoverOpen}
            selectedPaths={selectedFilePathsSafe}
            onClickChip={(path, e) => {
              const isCmd = e.metaKey || e.ctrlKey;
              const isShift = e.shiftKey;
              setSelectedFilePaths((prev) => {
                const next = new Set(prev);
                if (isShift && lastSelectedAnchorRef.current) {
                  // 范围选：以锚点为起点，拾 pendingFiles 顺序中两者之间的所有 path
                  const list = pendingFiles.map((p) => p.path);
                  const a = list.indexOf(lastSelectedAnchorRef.current);
                  const b = list.indexOf(path);
                  if (a >= 0 && b >= 0) {
                    const [lo, hi] = a <= b ? [a, b] : [b, a];
                    for (let i = lo; i <= hi; i += 1) next.add(list[i]);
                    return next;
                  }
                }
                if (isCmd) {
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  lastSelectedAnchorRef.current = path;
                  return next;
                }
                // 普通点击：独选该 chip
                next.clear();
                next.add(path);
                lastSelectedAnchorRef.current = path;
                return next;
              });
            }}
            onRemoveChip={(path) => {
              removePendingFile(path);
              setSelectedFilePaths((prev) => {
                if (!prev.has(path)) return prev;
                const next = new Set(prev);
                next.delete(path);
                return next;
              });
            }}
            onClearSelection={() => setSelectedFilePaths(new Set())}
          />
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
        {statusHint ? (
          <div
            className="mb-2 rounded-token-sm border px-3 py-1.5 text-token-sm"
            style={{
              borderColor: "var(--color-warning)",
              background: "var(--color-warning-bg)",
              color: "var(--color-warning)",
            }}
            role="status"
          >
            {statusHint}
          </div>
        ) : null}
        {/* 卡片：textarea + 内嵌 Send */}
        <div
          className="relative rounded-token-lg border transition-colors focus-within:border-[color:var(--accent)]"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border)",
          }}
        >
          {composerMode && (
            <div
              className="flex flex-wrap gap-1.5 px-3 pt-2"
              style={{ marginBottom: -4 }}
            >
              <ModeChip
                mode={composerMode}
                active={chipActive}
                onRemove={() => setComposerMode(null)}
              />
            </div>
          )}
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
              // F4 chip 多选键盘交互：仅在 textarea 空 / autocomplete 未打开 / IME 未合成。
              if (
                !e.nativeEvent.isComposing &&
                !acMode &&
                pendingFiles.length > 0
              ) {
                const ta = e.currentTarget;
                const at0 = ta.selectionStart === 0 && ta.selectionEnd === 0;
                const isCmd = e.metaKey || e.ctrlKey;
                // Cmd+A （textarea 空）→ 全选 chip
                if (
                  isCmd &&
                  e.key.toLowerCase() === "a" &&
                  ta.value.length === 0
                ) {
                  e.preventDefault();
                  setSelectedFilePaths(
                    new Set(pendingFiles.map((p) => p.path))
                  );
                  return;
                }
                // Esc → 如果有选中，先清选中态
                if (e.key === "Escape" && selectedFilePathsSafe.size > 0) {
                  e.preventDefault();
                  setSelectedFilePaths(new Set());
                  return;
                }
                // Backspace/Delete 且有选中 → 批删
                if (
                  (e.key === "Backspace" || e.key === "Delete") &&
                  selectedFilePathsSafe.size > 0 &&
                  at0
                ) {
                  e.preventDefault();
                  for (const p of selectedFilePathsSafe) removePendingFile(p);
                  setSelectedFilePaths(new Set());
                  return;
                }
              }
              // 结构化：Backspace at caret=0 连击删 chip、Esc 取消选中态。
              // 只在未合成 / autocomplete 未打开时处理，避免与 IME / 选项面板冲突。
              if (
                composerModeRef.current &&
                !e.nativeEvent.isComposing &&
                !acMode
              ) {
                if (e.key === "Escape" && chipActive) {
                  e.preventDefault();
                  setChipActive(false);
                  return;
                }
                if (e.key === "Backspace" || e.key === "Delete") {
                  const ta = e.currentTarget;
                  const at0 =
                    ta.selectionStart === 0 && ta.selectionEnd === 0;
                  if (at0) {
                    if (!chipActive) {
                      e.preventDefault();
                      setChipActive(true);
                      return;
                    }
                    e.preventDefault();
                    setComposerModeRef.current(null);
                    return;
                  }
                }
                // 任何其他输入取消 chip 选中态
                if (chipActive) setChipActive(false);
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
                type="button"
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

          {/* 4.5 Profile（只读预览，Phase B） */}
          <ProfileChip />

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

/**
 * F3：多 chip 的顺序渲染 + 超量折叠。全部 “single-source-of-truth” 都是
 * pendingFiles；selectedPaths / disambig / missing / flashing 都以依赖注入。
 */
function FileChipRow({
  pendingFiles,
  missingFilePaths,
  flashedFilePath,
  disambigByPath,
  collapse,
  popoverOpen,
  setPopoverOpen,
  selectedPaths,
  onClickChip,
  onRemoveChip,
  onClearSelection,
}: {
  pendingFiles: PendingAttachment[];
  missingFilePaths?: Set<string>;
  flashedFilePath?: string | null;
  disambigByPath: Map<string, string>;
  collapse: boolean;
  popoverOpen: boolean;
  setPopoverOpen: Dispatch<SetStateAction<boolean>>;
  selectedPaths: Set<string>;
  onClickChip: (path: string, e: ReactMouseEvent<HTMLDivElement>) => void;
  onRemoveChip: (path: string) => void;
  onClearSelection: () => void;
}) {
  // collapse 时只顶层露前 2 个 + [N references ▾]。展开后 popover 列出全部。
  const visibleHead = collapse ? pendingFiles.slice(0, 2) : pendingFiles;
  const remainder = collapse ? pendingFiles.slice(2) : [];
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // 点顶布 outside 关闭 popover
  useEffect(() => {
    if (!popoverOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = popoverRef.current;
      if (el && !el.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [popoverOpen, setPopoverOpen]);
  return (
    <div className="flex flex-wrap gap-1.5 mb-2 items-center">
      {visibleHead.map((att) => (
        <FileChip
          key={att.path}
          att={att}
          missing={missingFilePaths?.has(att.path)}
          flashing={flashedFilePath === att.path}
          selected={selectedPaths.has(att.path)}
          disambig={disambigByPath.get(att.path)}
          onRemove={() => onRemoveChip(att.path)}
          onClick={(e) => onClickChip(att.path, e)}
        />
      ))}
      {collapse && remainder.length > 0 && (
        <div className="relative" ref={popoverRef}>
          <button
            type="button"
            onClick={() => setPopoverOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-[color:var(--bg-hover)]"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-muted)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
            aria-expanded={popoverOpen}
            title="展开查看全部引用"
          >
            +{remainder.length} reference{remainder.length > 1 ? "s" : ""}
            <ChevronDown size={12} aria-hidden />
          </button>
          {popoverOpen && (
            <div
              className="absolute z-20 mt-1 max-h-72 w-[320px] overflow-auto rounded-md border p-2 shadow-md"
              style={{
                background: "var(--bg-panel)",
                borderColor: "var(--border)",
              }}
              role="dialog"
            >
              <div
                className="flex items-center justify-between mb-2"
                style={{ color: "var(--text-muted)", fontSize: 12 }}
              >
                <span>{pendingFiles.length} references</span>
                {selectedPaths.size > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const p of [...selectedPaths]) onRemoveChip(p);
                      onClearSelection();
                    }}
                    className="hover:text-[color:var(--color-warning)]"
                  >
                    删除选中 ({selectedPaths.size})
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {pendingFiles.map((att) => (
                  <FileChip
                    key={att.path}
                    att={att}
                    missing={missingFilePaths?.has(att.path)}
                    flashing={flashedFilePath === att.path}
                    selected={selectedPaths.has(att.path)}
                    disambig={disambigByPath.get(att.path)}
                    onRemove={() => onRemoveChip(att.path)}
                    onClick={(e) => onClickChip(att.path, e)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 拖入附件 chip：图标 + 文件名 + 大小 + ✕ 移除 */
function FileChip({
  att,
  missing,
  flashing,
  selected,
  disambig,
  onRemove,
  onClick,
}: {
  att: PendingAttachment;
  /** Phase C：服务端检查后被认为不存在/不可读。UI 走 warning tone。 */
  missing?: boolean;
  /** F1：重复添加同路径时，原 chip 闪一下。 */
  flashing?: boolean;
  /** F4：多选选中态。 */
  selected?: boolean;
  /** F2：同名重名后附加的父路径提示（例：app/api/auth）。 */
  disambig?: string;
  onRemove: () => void;
  /** F4：点击 chip 本体的响应（选中 / 范围选 / Cmd+点击多选）。 */
  onClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
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
  const tooltip = missing
    ? `路径不存在或不可读：${att.path}`
    : att.path;
  // F1 flash：outline 闪一下，使用与选中态同色但不同动作。
  // F4 selected：outline。
  const ringColor = selected
    ? "var(--accent)"
    : flashing
      ? "var(--color-warning)"
      : null;
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border pl-2 pr-1 py-1 max-w-[260px] cursor-default select-none"
      style={{
        background:
          selected
            ? "var(--bg-hover)"
            : missing
              ? "var(--bg-panel-2)"
              : "var(--bg-panel)",
        borderColor: missing ? "var(--color-warning)" : "var(--border)",
        outline: ringColor ? `2px solid ${ringColor}` : "none",
        outlineOffset: 1,
        transition: "outline-color 80ms, background 80ms",
      }}
      title={tooltip}
      data-missing={missing ? "true" : "false"}
      data-flashing={flashing ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      onClick={onClick}
    >
      <Icon
        size={14}
        style={{
          color: missing ? "var(--color-warning)" : "var(--text-muted)",
          flexShrink: 0,
        }}
      />
      <span
        className="truncate text-token-sm font-mono"
        style={{
          color: missing ? "var(--color-warning)" : "var(--text)",
          textDecoration: missing ? "line-through" : undefined,
        }}
      >
        {att.name}
      </span>
      {disambig && (
        <span
          className="shrink-0 text-token-xs"
          style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}
          aria-hidden
        >
          · {disambig}
        </span>
      )}
      <span
        className="shrink-0 text-token-xs"
        style={{ color: "var(--text-muted)" }}
      >
        {missing ? "missing" : att.size == null ? "dir" : formatBytes(att.size)}
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
