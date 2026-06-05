"use client";

 
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { BrowserSnapshot } from "@/lib/browser/types";

type Command = {
  id: string;
  action: string;
  label: string;
  payload: Record<string, unknown>;
};

type WebviewPocApi = {
  navigate?: (webContentsId: number, url: string) => Promise<unknown>;
  click?: (webContentsId: number, x: number, y: number) => Promise<unknown>;
  screenshot?: (
    webContentsId: number
  ) => Promise<{ ok: boolean; dataUrl?: string | null }>;
};

type ElectronWebviewElement = HTMLElement & {
  src: string;
  getWebContentsId: () => number;
  loadURL: (url: string) => Promise<void>;
  reload?: () => void;
  executeJavaScript: <T = unknown>(
    code: string,
    userGesture?: boolean
  ) => Promise<T>;
};

type EmbeddedBrowserElement = ElectronWebviewElement | HTMLIFrameElement;

function getElectronApi(): { webviewPoc?: WebviewPocApi } | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { miniPi?: { webviewPoc?: WebviewPocApi } })
    .miniPi ?? null);
}

function q(value: unknown): string {
  return JSON.stringify(value);
}

const inspectScript = `(() => ({
  url: location.href,
  title: document.title,
  screenshotDataUrl: null
}))()`;

const extractScript = `(() => {
  const visibleText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 4000);
  const selectorFor = (el, fallback) => {
    const id = el.getAttribute("id");
    if (id) return "#" + CSS.escape(id);
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + "[name=\\"" + CSS.escape(name) + "\\"]";
    return fallback;
  };
  const links = Array.from(document.querySelectorAll("a")).slice(0, 30).map((a) => ({
    text: (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
    href: a.href,
  })).filter((x) => x.text || x.href);
  const inputs = Array.from(document.querySelectorAll("input, textarea, select")).slice(0, 30).map((el) => {
    const id = el.id;
    const label = (id && document.querySelector("label[for=\\"" + CSS.escape(id) + "\\"]")?.textContent) ||
      el.getAttribute("aria-label") || el.name || "";
    return {
      label: label.replace(/\\s+/g, " ").trim().slice(0, 120),
      type: el.type || el.tagName.toLowerCase(),
      name: el.name || "",
      placeholder: el.placeholder || "",
    };
  });
  const actions = [
    ...Array.from(document.querySelectorAll("a")).slice(0, 20).map((el, index) => ({
      kind: "link",
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      selectorHint: selectorFor(el, "a:nth-of-type(" + (index + 1) + ")"),
    })),
    ...Array.from(document.querySelectorAll("button, [role='button']")).slice(0, 20).map((el, index) => ({
      kind: "button",
      text: (el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      selectorHint: selectorFor(el, "button:nth-of-type(" + (index + 1) + ")"),
    })),
    ...Array.from(document.querySelectorAll("input, textarea, [role='textbox'], [role='searchbox']")).slice(0, 20).map((el, index) => ({
      kind: "input",
      text: (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "")
        .replace(/\\s+/g, " ").trim().slice(0, 120),
      selectorHint: selectorFor(el, "input:nth-of-type(" + (index + 1) + ")"),
    })),
  ].filter((x) => x.text || x.selectorHint);
  return { url: location.href, title: document.title, screenshotDataUrl: null, text: visibleText, links, inputs, actions };
})()`;

function hasTextScript(text: unknown, exact = false): string {
  return `(() => {
    const needle = ${q(String(text ?? ""))};
    const hay = document.body?.innerText || "";
    return ${exact ? "hay === needle" : "hay.includes(needle)"};
  })()`;
}

function selectorExistsScript(selector: unknown): string {
  return `(() => !!document.querySelector(${q(String(selector ?? ""))}))()`;
}

function firstEditableScript(): string {
  return `document.querySelector("input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable='true'], [role='textbox'], [role='searchbox']")`;
}

function isCurrentAppRootUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function isBlankUrl(value: unknown): boolean {
  return typeof value === "string" && value === "about:blank";
}

function resolveWebContentsId(
  el: EmbeddedBrowserElement,
  fallback: number | null
): number | null {
  if ("getWebContentsId" in el) {
    const id = el.getWebContentsId();
    return Number.isFinite(id) && id > 0 ? id : fallback;
  }
  return fallback;
}

async function waitForCondition(
  run: <T>(script: string) => Promise<T>,
  input: { url?: unknown; selector?: unknown; text?: unknown; timeoutMs?: unknown }
) {
  const timeout = Math.min(
    Math.max(typeof input.timeoutMs === "number" ? input.timeoutMs : 10_000, 200),
    60_000
  );
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const checks: boolean[] = [];
    if (input.url) {
      checks.push(
        await run<boolean>(
          `(() => location.href.includes(${q(String(input.url))}))()`
        )
      );
    }
    if (input.selector) {
      checks.push(await run<boolean>(selectorExistsScript(input.selector)));
    }
    if (input.text) {
      checks.push(await run<boolean>(hasTextScript(input.text)));
    }
    if (checks.length > 0 && checks.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("wait_for condition timed out");
}

export function InAppBrowserSurface({
  browserId,
  url,
  onSnapshot,
  onError,
}: {
  browserId: string;
  url: string;
  onSnapshot: (snapshot: BrowserSnapshot) => void;
  onError: (error: string | null) => void;
}) {
  const api = getElectronApi();
  const embeddedRef = useRef<EmbeddedBrowserElement | null>(null);
  const [ready, setReady] = useState(false);
  const [wcId, setWcId] = useState<number | null>(null);
  const isElectron = !!api?.webviewPoc;

  useEffect(() => {
    const el = embeddedRef.current;
    if (!el) return;
    const sync = async () => {
      try {
        if (isElectron && "getWebContentsId" in el) {
          const id = el.getWebContentsId();
          setWcId(id);
        }
        setReady(true);
        const result = await runScriptOnElement<Record<string, unknown>>(
          el,
          inspectScript
        );
        if (isBlankUrl(result.url) && url !== "about:blank") {
          return;
        }
        const r = await fetch(`/api/browser/${browserId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "host_complete",
            commandId: `snapshot_${Date.now()}`,
            result,
          }),
        });
        const data = (await r.json().catch(() => ({}))) as {
          snapshot?: BrowserSnapshot;
        };
        if (data.snapshot) onSnapshot(data.snapshot);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    };
    const readyEvent = isElectron ? "dom-ready" : "load";
    el.addEventListener(readyEvent, sync as EventListener);
    if (isElectron) {
      el.addEventListener("did-navigate", sync as EventListener);
      el.addEventListener("did-navigate-in-page", sync as EventListener);
    }
    return () => {
      el.removeEventListener(readyEvent, sync as EventListener);
      if (isElectron) {
        el.removeEventListener("did-navigate", sync as EventListener);
        el.removeEventListener("did-navigate-in-page", sync as EventListener);
      }
    };
  }, [browserId, isElectron, onError, onSnapshot, url]);

  useEffect(() => {
    let cancelled = false;
    const register = async () => {
      const r = await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "host_register" }),
      }).catch(() => null);
      if (!r) return;
      const data = (await r.json().catch(() => ({}))) as {
        snapshot?: BrowserSnapshot;
      };
      if (!cancelled && data.snapshot) onSnapshot(data.snapshot);
    };
    void register();
    const t = setInterval(() => void register(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [browserId, onSnapshot]);

  const runJs = useCallback(async <T,>(script: string): Promise<T> => {
    const el = embeddedRef.current;
    if (!el) throw new Error("in-app browser surface is not mounted");
    return runScriptOnElement<T>(el, script);
  }, []);

  const inspect = useCallback(
    () => runJs<Record<string, unknown>>(inspectScript),
    [runJs]
  );

  const executeInAppCommand = useCallback(async (command: Command) => {
    const el = embeddedRef.current;
    if (!el) throw new Error("in-app browser surface is not mounted");
    const payload = command.payload ?? {};
    switch (command.action) {
      case "open": {
        const target = String(payload.url ?? "");
        if (!target) throw new Error("url required");
        if (isCurrentAppRootUrl(target)) {
          throw new Error(
            "Refusing to embed the Diga Agent app shell. Open a specific route or external page instead."
          );
        }
        await loadEmbeddedUrl(el, target, api?.webviewPoc, wcId);
        return inspect();
      }
      case "refresh":
        return inspect();
      case "screenshot": {
        const currentWcId = resolveWebContentsId(el, wcId);
        if (api?.webviewPoc?.screenshot && currentWcId != null) {
          const shot = await withTimeout(
            api.webviewPoc.screenshot(currentWcId),
            10_000,
            "in-app webview screenshot timed out"
          );
          return { ...(await inspect()), screenshotDataUrl: shot.dataUrl ?? null };
        }
        return inspect();
      }
      case "click": {
        if (typeof payload.selector === "string" && payload.selector) {
          return runJs<Record<string, unknown>>(`(() => {
            const el = document.querySelector(${q(payload.selector)});
            if (!el) throw new Error("selector not found: ${String(payload.selector).replace(/"/g, '\\"')}");
            const box = el.getBoundingClientRect();
            el.click();
            return {
              url: location.href,
              title: document.title,
              screenshotDataUrl: null,
              pointer: { x: (box.left + box.width / 2) / innerWidth, y: (box.top + box.height / 2) / innerHeight, action: "click", label: ${q(payload.selector)}, updatedAt: Date.now() }
            };
          })()`);
        }
        if (typeof payload.x === "number" && typeof payload.y === "number") {
          if (!api?.webviewPoc?.click || wcId == null) {
            throw new Error("coordinate click requires Electron webview CDP");
          }
          await api.webviewPoc.click(wcId, payload.x, payload.y);
          return {
            ...(await inspect()),
            pointer: {
              x: payload.x / Math.max(el.clientWidth, 1),
              y: payload.y / Math.max(el.clientHeight, 1),
              action: "click",
              label: `${payload.x},${payload.y}`,
              updatedAt: Date.now(),
            },
          };
        }
        throw new Error("selector or x/y required");
      }
      case "click_text": {
        const result = await runJs<Record<string, unknown>>(`(() => {
          const needle = ${q(String(payload.text ?? ""))};
          const exact = ${payload.exact ? "true" : "false"};
          const candidates = Array.from(document.querySelectorAll("a, button, [role='button'], input[type=button], input[type=submit]"));
          const target = candidates.find((el) => {
            const text = (el.innerText || el.textContent || el.value || "").trim();
            return exact ? text === needle : text.includes(needle);
          });
          if (!target) throw new Error("text target not found: " + needle);
          const box = target.getBoundingClientRect();
          const href = target.tagName.toLowerCase() === "a" ? target.href : null;
          if (!href) {
            target.click();
          }
          return {
            url: location.href,
            title: document.title,
            screenshotDataUrl: null,
            href,
            pointer: { x: (box.left + box.width / 2) / innerWidth, y: (box.top + box.height / 2) / innerHeight, action: "click", label: needle, updatedAt: Date.now() }
          };
        })()`);
        if (typeof result.href === "string" && result.href) {
          await loadEmbeddedUrl(el, result.href, api?.webviewPoc, wcId);
          return { ...(await inspect()), pointer: result.pointer };
        }
        return result;
      }
      case "fill":
      case "type": {
        const selector =
          typeof payload.selector === "string" && payload.selector
            ? `document.querySelector(${q(payload.selector)})`
            : firstEditableScript();
        const result = await runJs<Record<string, unknown>>(`(() => {
          const target = ${selector};
          if (!target) throw new Error("editable target not found");
          const text = ${q(String(payload.text ?? ""))};
          target.focus();
          if (target.isContentEditable) {
            target.textContent = text;
            target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          } else {
            target.value = text;
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const box = target.getBoundingClientRect();
          return {
            url: location.href,
            title: document.title,
            screenshotDataUrl: null,
            pointer: { x: (box.left + box.width / 2) / innerWidth, y: (box.top + box.height / 2) / innerHeight, action: "type", label: ${q(String(payload.selector ?? "first editable"))}, updatedAt: Date.now() }
          };
        })()`);
        if (payload.pressEnter) {
          await runJs(`(() => {
            const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true });
            document.activeElement?.dispatchEvent(event);
          })()`);
        }
        return result;
      }
      case "wait":
        if (payload.ms && !payload.selector && !payload.text) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(Math.max(Number(payload.ms), 100), 30_000))
          );
        } else {
          await waitForCondition(runJs, payload);
        }
        return inspect();
      case "wait_for":
        await waitForCondition(runJs, payload);
        return inspect();
      case "extract":
        return runJs<Record<string, unknown>>(extractScript);
      case "verify": {
        const expectation = String(payload.expectation ?? "");
        let passed = false;
        let evidence = "";
        if (payload.selector) {
          passed = await runJs<boolean>(selectorExistsScript(payload.selector));
          evidence = passed
            ? `Selector is visible: ${payload.selector}`
            : `Selector was not found: ${payload.selector}`;
        } else if (payload.text) {
          passed = await runJs<boolean>(hasTextScript(payload.text));
          evidence = passed
            ? `Text is visible: ${payload.text}`
            : `Text was not found: ${payload.text}`;
        } else {
          passed = await runJs<boolean>(hasTextScript(expectation.slice(0, 80)));
          evidence = passed
            ? "Expectation text appears in the page body."
            : "Expectation text was not found in the page body.";
        }
        return { ...(await inspect()), passed, expectation, evidence };
      }
      case "input":
        return inspect();
      case "close":
        await loadEmbeddedUrl(el, "about:blank", api?.webviewPoc, wcId).catch((e) => {
          if (!isNavigationAbort(e)) throw e;
        });
        return { url: null, title: null, screenshotDataUrl: null };
      default:
        throw new Error(`unknown in-app browser command: ${command.action}`);
    }
  }, [api?.webviewPoc, inspect, runJs, wcId]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let inFlight = false;

    const complete = async (
      command: Command,
      result: Record<string, unknown>
    ) => {
      const r = await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "host_complete",
          commandId: command.id,
          result,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        snapshot?: BrowserSnapshot;
      };
      if (!cancelled && data.snapshot) onSnapshot(data.snapshot);
    };

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(`/api/browser/${browserId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "host_poll" }),
        });
        const data = (await r.json().catch(() => ({}))) as {
          command?: Command | null;
        };
        if (data.command) {
          try {
            await complete(
              data.command,
              await executeInAppCommand(data.command)
            );
          } catch (e) {
            await complete(data.command, {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      } catch {
        /* keep polling */
      } finally {
        inFlight = false;
      }
    };

    const interval = setInterval(() => void tick(), 120);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
     
  }, [browserId, executeInAppCommand, onSnapshot, ready, wcId]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      {isElectron
        ? createElement("webview", {
            ref: embeddedRef,
            src: url,
            style: { width: "100%", height: "100%" },
          })
        : (
          <iframe
            ref={embeddedRef as React.RefObject<HTMLIFrameElement>}
            src={url}
            title="In-app browser"
            className="h-full w-full border-0"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          />
        )}
      {!ready && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs"
          style={{ color: "var(--text-muted)", background: "var(--bg)" }}
        >
          正在连接 in-app browser…
        </div>
      )}
    </div>
  );
}

async function runScriptOnElement<T>(
  el: EmbeddedBrowserElement,
  script: string
): Promise<T> {
  if ("executeJavaScript" in el) {
    return el.executeJavaScript<T>(script, true);
  }
  const win = el.contentWindow;
  if (!win) throw new Error("in-app iframe is not ready");
  try {
    return (win as unknown as { eval: (code: string) => unknown }).eval(
      script
    ) as T;
  } catch (e) {
    throw new Error(
      `in-app iframe cannot inspect this page${
        e instanceof Error ? `: ${e.message}` : ""
      }`
    );
  }
}

function isNavigationAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_ABORTED" || message.includes("ERR_ABORTED") || message.includes("(-3)");
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function loadEmbeddedUrl(
  el: EmbeddedBrowserElement,
  url: string,
  webviewPoc?: WebviewPocApi,
  webContentsId?: number | null
): Promise<void> {
  if ("loadURL" in el) {
    const resolvedWebContentsId = webContentsId ?? el.getWebContentsId();
    const waitForReady = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("in-app webview navigation timed out"));
        }, 15_000);
        const cleanup = () => {
          clearTimeout(timer);
          el.removeEventListener("dom-ready", onReady);
          el.removeEventListener("did-navigate", onReady);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        el.addEventListener("dom-ready", onReady, { once: true });
        el.addEventListener("did-navigate", onReady, { once: true });
      });
    if (webviewPoc?.navigate && resolvedWebContentsId != null) {
      const ready = waitForReady();
      await webviewPoc.navigate(resolvedWebContentsId, url);
      await ready;
      return;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("in-app webview navigation timed out"));
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener("dom-ready", onReady);
        el.removeEventListener("did-navigate", onReady);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      el.addEventListener("dom-ready", onReady, { once: true });
      el.addEventListener("did-navigate", onReady, { once: true });
      if (el.src === url && el.reload) {
        el.reload();
      } else {
        el.src = url;
      }
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("in-app iframe navigation timed out"));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener("load", onLoad);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    el.addEventListener("load", onLoad);
    el.src = url;
  });
}
