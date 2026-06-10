"use client";

/**
 * useAutocomplete —— 把 ChatApp 的「输入框自动补全 + slash 命令」模块收口到一个 hook。
 *
 * 涵盖范围：
 *   - `@<path>` 文件路径补全（从 cwd 读 /api/files）
 *   - `/<cmd>` slash 命令补全（基于 SLASH_COMMANDS）
 *   - 4 个 AC state（acMode / acQuery / acItems / acIndex）
 *   - acTriggerPosRef（记录 @// 触发位，applyAutocomplete 替换用）
 *   - 3 个 AC handler：closeAutocomplete / refreshAutocomplete / applyAutocomplete
 *   - 1 个键盘拦截方法：tryHandleAutocompleteKey（ChatApp.onKeyDown 在 Enter 之前先调）
 *   - runSlashCommand（7 个 slash 分支：clear/compact/branches/system/models/auth/help）
 *
 * 设计原则（沿用 B2-a / B3 / C1）：
 *   - hook 完全无外部状态；AC state 全部封闭在 hook 内
 *   - SLASH_COMMANDS 与 SlashName 同文件常量（其唯一使用方就是本 hook）
 *   - detectAutocompleteToken pure helper 同文件（唯一调用方就是 refreshAutocomplete）
 *   - AutocompleteItem 类型从 components/InputAutocomplete 复用（UI 也用同一份）
 *   - startNewSession 不在 hook 内（属于 session 生命周期，不属于 AC/slash）
 *     —— 通过参数注入；未来可在 useSessionLifecycle 一并迁移
 *   - 5 个 modal setter（branches/system/models/auth）+ setInput 是 slash 命令的副作用，
 *     通过参数注入，保持 hook 对 UI state 零反向依赖
 */

import type React from "react";
import { useCallback, useRef, useState } from "react";
import type { AutocompleteItem } from "../components/InputAutocomplete";

/**
 * 内置 slash 命令清单。
 * action 在 runSlashCommand 内分发到具体回调。
 */
export const SLASH_COMMANDS = [
  { name: "clear", hint: "新开 session" },
  { name: "compact", hint: "压缩当前 session 上下文" },
  { name: "branches", hint: "查看分支" },
  { name: "system", hint: "查看 system prompt" },
  { name: "models", hint: "模型配置" },
  { name: "auth", hint: "凭证管理" },
  { name: "goal", hint: "设置长期目标" },
  { name: "workflow", hint: "用 dynamic workflow 执行一个目标" },
  { name: "help", hint: "查看支持的命令" },
] as const;

export type SlashName = (typeof SLASH_COMMANDS)[number]["name"];

/**
 * 检测光标处的触发 token：返回 { mode, query, triggerPos }。
 * 触发条件：紧邻光标向左找到 `@` 或 `/`，且其左侧是行首/空白/换行。
 * `/` 仅在文本最前面（光标 ≤ 第一个非空白后）才算 slash 命令。
 */
/**
 * 把 /api/files 返回的目录条目过滤 + 排序 + 截断 + 包装为 AutocompleteItem。
 * 拆出来是因为 cache hit 与 debounce fetch 两条路径都要复用同一份格式化逻辑。
 */
function buildFileItems(
  entries: Array<{ name: string; isDir: boolean; path: string }>,
  query: string
): AutocompleteItem[] {
  return entries
    .filter(
      (e) => !e.name.startsWith(".") && e.name.toLowerCase().includes(query)
    )
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 20)
    .map<AutocompleteItem>((e) => ({
      label: e.name + (e.isDir ? "/" : ""),
      hint: e.isDir ? "dir" : "file",
      value: `@${e.path}`,
    }));
}

function detectAutocompleteToken(
  text: string,
  caret: number
): { mode: "@" | "/"; query: string; triggerPos: number } | null {
  if (caret <= 0) return null;
  // 向左扫描直到遇到空白/换行/@//
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@" || ch === "/") break;
    if (/\s/.test(ch)) return null;
    i--;
  }
  if (i < 0) return null;
  const trigger = text[i];
  // 左侧必须是行首或空白；slash 命令只在整段输入开头才触发
  const leftOk = i === 0 || /\s/.test(text[i - 1]);
  if (!leftOk) return null;
  if (trigger === "/") {
    // 只允许全文以 /xxx 开头（前面只能有空白）
    if (text.slice(0, i).trim() !== "") return null;
    return { mode: "/", query: text.slice(i + 1, caret), triggerPos: i };
  }
  return { mode: "@", query: text.slice(i + 1, caret), triggerPos: i };
}

export interface UseAutocompleteParams {
  // ── 输入框上下文 ─────────────────────────────────────────────────
  getInput: () => string;
  cwd: string | null;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput: (v: string) => void;

  // ── slash 命令分发目标 ────────────────────────────────────────────
  agentId: string | null;
  startNewSession: () => void | Promise<void>;
  onCompact: () => void | Promise<void>;
  setShowBranches: (v: boolean) => void;
  setShowSystemPrompt: (v: boolean) => void;
  setShowModelsConfig: (v: boolean) => void;
  setShowAuth: (v: boolean) => void;
}

export interface UseAutocompleteReturn {
  // ── AC state（UI 渲染需要）────────────────────────────────────────
  acMode: "@" | "/" | null;
  acItems: AutocompleteItem[];
  acIndex: number;
  setAcIndex: React.Dispatch<React.SetStateAction<number>>;

  // ── AC handler ───────────────────────────────────────────────────
  refreshAutocomplete: (text: string, caret: number) => Promise<void>;
  closeAutocomplete: () => void;
  applyAutocomplete: (item: AutocompleteItem) => void;

  /**
   * 键盘拦截：在 ChatApp.onKeyDown 内于 Enter/Tab/上下/Esc 默认行为之前调用。
   * 返回 true 表示按键已被 AC 消费（ChatApp 应直接 return），返回 false 则继续走默认逻辑。
   */
  tryHandleAutocompleteKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;

  // ── slash 命令 ───────────────────────────────────────────────────
  runSlashCommand: (name: SlashName) => void;
}

export function useAutocomplete(
  opts: UseAutocompleteParams
): UseAutocompleteReturn {
  const {
    getInput,
    cwd,
    inputRef,
    setInput,
    agentId,
    startNewSession,
    onCompact,
    setShowBranches,
    setShowSystemPrompt,
    setShowModelsConfig,
    setShowAuth,
  } = opts;

  // ── AC state ──────────────────────────────────────────────────────
  // 历史遗留：acQuery 原本是 setter-only（从未被读取），ChatApp 内 InputAutocomplete
  // 通过 items 派生，不需要单独透出 query；C2 抽离时一并清掉。
  const [acMode, setAcMode] = useState<"@" | "/" | null>(null);
  const [acItems, setAcItems] = useState<AutocompleteItem[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const acTriggerPosRef = useRef<number>(-1);

  /** 关闭 autocomplete 状态 */
  const closeAutocomplete = useCallback(() => {
    setAcMode(null);
    setAcItems([]);
    setAcIndex(0);
    acTriggerPosRef.current = -1;
  }, []);

  // ── @ 文件请求的轻量 in-memory cache + debounce（P0-B）────────────────
  // - cache：同 cwd + query 5s 内复用，避免快速反复 @ 触发重复 fetch；
  // - debounce：每次 @ 输入触发的 fetch 延后 200ms，仅最后一次真正发请求，
  //   降低连击 keystroke 的网络/解析压力。
  // - acMode 当前为 null 且未检测到触发 token 时，直接 return 不再调
  //   closeAutocomplete()，避免无谓 setState 触发上层 re-render。
  type FilesEntry = { name: string; isDir: boolean; path: string };
  const filesCacheRef = useRef<
    Map<string, { ts: number; entries: FilesEntry[] }>
  >(new Map());
  const acModeRef = useRef<"@" | "/" | null>(acMode);
  acModeRef.current = acMode;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceSeqRef = useRef(0);
  const FILES_CACHE_TTL_MS = 5000;
  const FILES_DEBOUNCE_MS = 200;

  const fetchFilesEntries = useCallback(
    async (cwdKey: string): Promise<FilesEntry[]> => {
      const cached = filesCacheRef.current.get(cwdKey);
      const now = Date.now();
      if (cached && now - cached.ts < FILES_CACHE_TTL_MS) {
        return cached.entries;
      }
      const r = await fetch(`/api/files?path=${encodeURIComponent(cwdKey)}`);
      const d = await r.json();
      const entries: FilesEntry[] = Array.isArray(d.entries) ? d.entries : [];
      filesCacheRef.current.set(cwdKey, { ts: now, entries });
      return entries;
    },
    []
  );

  /** 输入或光标位置变化时刷新 autocomplete */
  const refreshAutocomplete = useCallback(
    async (text: string, caret: number) => {
      const tok = detectAutocompleteToken(text, caret);
      if (!tok) {
        // 仅当当前确实是打开状态时才 close，避免无谓 setState
        if (acModeRef.current !== null) {
          // 同时取消 debounced fetch，否则上一个挂起的会用旧 query 写回 items
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }
          debounceSeqRef.current++;
          closeAutocomplete();
        }
        return;
      }
      acTriggerPosRef.current = tok.triggerPos;
      setAcMode(tok.mode);
      setAcIndex(0);
      if (tok.mode === "/") {
        // slash 是纯本地过滤，不走 debounce
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        const q = tok.query.toLowerCase();
        const items: AutocompleteItem[] = SLASH_COMMANDS.filter((c) =>
          c.name.startsWith(q)
        ).map((c) => ({
          label: `/${c.name}`,
          hint: c.hint,
          value: `/${c.name}`,
        }));
        setAcItems(items);
        return;
      }
      // @ 文件：debounce 200ms 后请求；同 cwd 5s 内复用
      const cwdKey = cwd ?? "";
      const query = tok.query.toLowerCase();
      const seq = ++debounceSeqRef.current;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // 命中缓存：直接同步过滤，省掉 200ms 等待
      const cached = filesCacheRef.current.get(cwdKey);
      const now = Date.now();
      if (cached && now - cached.ts < FILES_CACHE_TTL_MS) {
        setAcItems(buildFileItems(cached.entries, query));
        return;
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void (async () => {
          try {
            const entries = await fetchFilesEntries(cwdKey);
            // 过期请求：在 fetch 期间用户又改了输入 / 关掉了 AC，丢弃
            if (seq !== debounceSeqRef.current) return;
            if (acModeRef.current !== "@") return;
            setAcItems(buildFileItems(entries, query));
          } catch {
            if (seq !== debounceSeqRef.current) return;
            setAcItems([]);
          }
        })();
      }, FILES_DEBOUNCE_MS);
    },
    [cwd, closeAutocomplete, fetchFilesEntries]
  );

  // ── Slash 命令执行 ────────────────────────────────────────────────
  const runSlashCommand = useCallback(
    (name: SlashName) => {
      switch (name) {
        case "clear":
          void startNewSession();
          break;
        case "compact":
          void onCompact();
          break;
        case "branches":
          if (agentId) setShowBranches(true);
          break;
        case "system":
          setShowSystemPrompt(true);
          break;
        case "models":
          setShowModelsConfig(true);
          break;
        case "auth":
          setShowAuth(true);
          break;
        case "goal":
          setInput("/goal ");
          return;
        case "workflow":
          setInput("/workflow ");
          return;
        case "help":
          setInput(
            "支持命令：\n" +
              SLASH_COMMANDS.map((c) => `  /${c.name} — ${c.hint}`).join("\n")
          );
          return;
      }
      setInput("");
    },
    [
      agentId,
      onCompact,
      startNewSession,
      setShowBranches,
      setShowSystemPrompt,
      setShowModelsConfig,
      setShowAuth,
      setInput,
    ]
  );

  /** 选中一个补全项：替换 input 中的触发 token */
  const applyAutocomplete = useCallback(
    (item: AutocompleteItem) => {
      const ta = inputRef.current;
      const triggerPos = acTriggerPosRef.current;
      if (triggerPos < 0) {
        closeAutocomplete();
        return;
      }
      const input = getInput();
      const caret = ta?.selectionStart ?? input.length;
      // value 已经包含触发字符（@xx 或 /xx），后接一个空格便于继续输入
      const before = input.slice(0, triggerPos);
      const after = input.slice(caret);
      const insert = item.value + " ";
      const next = before + insert + after;
      setInput(next);
      const newCaret = before.length + insert.length;
      // 让 cursor 落到插入末尾
      requestAnimationFrame(() => {
        const t = inputRef.current;
        if (t) {
          t.focus();
          t.setSelectionRange(newCaret, newCaret);
        }
      });
      closeAutocomplete();
      // 如果是 slash 命令，立即执行
      if (acMode === "/" && item.value.startsWith("/")) {
        const name = item.value.slice(1) as SlashName;
        if (SLASH_COMMANDS.some((c) => c.name === name)) {
          runSlashCommand(name);
        }
      }
    },
    [acMode, getInput, inputRef, setInput, closeAutocomplete, runSlashCommand]
  );

  /**
   * 键盘拦截：上下移动选项 / Enter|Tab 应用 / Esc 关闭。
   * 中文输入法合成阶段（isComposing）不消费 Enter/Tab，避免吞掉拼音回车。
   */
  const tryHandleAutocompleteKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!acMode || acItems.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItems.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!e.nativeEvent.isComposing) {
          e.preventDefault();
          applyAutocomplete(acItems[acIndex]);
          return true;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAutocomplete();
        return true;
      }
      return false;
    },
    [acMode, acItems, acIndex, applyAutocomplete, closeAutocomplete]
  );

  return {
    acMode,
    acItems,
    acIndex,
    setAcIndex,
    refreshAutocomplete,
    closeAutocomplete,
    applyAutocomplete,
    tryHandleAutocompleteKey,
    runSlashCommand,
  };
}
