/**
 * Composer input store —— 把 textarea 的高频按键状态从 RunnerState 解耦。
 *
 * 背景:
 *   原先 setInput 走 useRunners.updateActive,每次按键都会:
 *     1. 复制整个 RunnerState 对象
 *     2. setActiveSnapshot(next) → 触发 ChatApp 顶层重渲染
 *     3. 再级联到 Composer/TopHeader/MessagesScrollArea/WorkbenchSidebar 等所有子树
 *   长会话场景下,每个字符 keystroke 都要让几百条 message 的列表跑一次 reconcile,
 *   导致输入卡顿。
 *
 * 设计:
 *   - 独立模块级 Map<RunnerKey, string>,每个会话一个 input slot
 *   - 订阅者只关心当前 active runner 的 input(默认 RunnerKey 用 ChatApp 现有的 string)
 *   - 写入只通知订阅者,不再走 React 状态树
 *   - Composer 通过 useSyncExternalStore 订阅,而不依赖 ChatApp props
 *
 * 兼容性:
 *   - useRunners 的 setInput / updateActive(input) 仍然保留,但实现切到 store
 *   - RunnerState.input 字段保留作为冷启动默认值/序列化兜底,但日常按键不再写它
 *   - 切换 session/淘汰 runner 时由 ChatApp 显式同步
 */

export type ComposerInputKey = string;

type Listener = () => void;

const inputs = new Map<ComposerInputKey, string>();
const listeners = new Map<ComposerInputKey, Set<Listener>>();
const allListeners = new Set<Listener>();

function emit(key: ComposerInputKey): void {
  const set = listeners.get(key);
  if (set) {
    for (const l of set) l();
  }
  for (const l of allListeners) l();
}

export function getInput(key: ComposerInputKey): string {
  return inputs.get(key) ?? "";
}

export function setInput(key: ComposerInputKey, value: string): void {
  const cur = inputs.get(key) ?? "";
  if (cur === value) return;
  inputs.set(key, value);
  emit(key);
}

export function updateInput(
  key: ComposerInputKey,
  updater: (prev: string) => string,
): void {
  const next = updater(inputs.get(key) ?? "");
  setInput(key, next);
}

export function deleteInput(key: ComposerInputKey): void {
  if (!inputs.has(key)) return;
  inputs.delete(key);
  emit(key);
}

export function clearAllInputs(): void {
  inputs.clear();
  for (const l of allListeners) l();
}

export function subscribeInput(
  key: ComposerInputKey,
  listener: Listener,
): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

/** 测试 / 调试用:订阅任意 key 的变化 */
export function subscribeAll(listener: Listener): () => void {
  allListeners.add(listener);
  return () => {
    allListeners.delete(listener);
  };
}

/** 仅供 SSR / 兜底使用:同步获取当前所有 input 的快照(用于持久化或调试) */
export function snapshotAll(): Record<string, string> {
  return Object.fromEntries(inputs.entries());
}
