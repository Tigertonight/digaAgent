"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  getInput,
  setInput as storeSetInput,
  subscribeInput,
  updateInput,
  type ComposerInputKey,
} from "@/lib/composer/input-store";

/**
 * 订阅 input store 中某个 key 的当前值。
 *
 * SSR safe: getServerSnapshot 总返回空串。Composer 在 SSR 下不渲染受控字符串,
 * hydrate 后客户端会再读一次真实值。
 */
export function useComposerInput(key: ComposerInputKey): string {
  return useSyncExternalStore(
    useCallback((listener) => subscribeInput(key, listener), [key]),
    useCallback(() => getInput(key), [key]),
    () => "",
  );
}

/** 返回一个稳定的写入函数,签名兼容 ChatApp 现有的 setInput(value | (prev)=>value) */
export function useComposerInputSetter(
  key: ComposerInputKey,
): (value: string | ((cur: string) => string)) => void {
  return useCallback(
    (value) => {
      if (typeof value === "function") {
        updateInput(key, value as (prev: string) => string);
      } else {
        storeSetInput(key, value);
      }
    },
    [key],
  );
}
