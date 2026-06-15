"use strict";

/**
 * A4-3 \u8f85\u52a9\uff1awebview src \u534f\u8bae\u767d\u540d\u5355\u3002\u72ec\u7acb\u8bcd\u51fd\u6570\u4ee5\u4fbf vitest \u8986\u76d6\u3002
 * \u4e3b\u8fdb\u7a0b electron/main.js \u4e2d\u7684 will-attach-webview / will-navigate \u90fd\u8c03\u8fd9\u91cc\u3002
 */

/**
 * @param {string|undefined|null} src
 * @returns {{ ok: boolean, reason?: string }}
 */
function isAllowedWebviewSrc(src) {
  const raw = String(src || "").trim();
  if (!raw) return { ok: true }; // \u672a\u8bbe src\uff0c\u4ea4\u7ed9 Chromium \u9ed8\u8ba4 about:blank
  if (raw === "about:blank") return { ok: true };
  let proto;
  try {
    proto = new URL(raw).protocol;
  } catch {
    return { ok: false, reason: "malformed-url" };
  }
  if (proto === "http:" || proto === "https:") return { ok: true };
  return { ok: false, reason: `disallowed-protocol:${proto}` };
}

module.exports = { isAllowedWebviewSrc };
