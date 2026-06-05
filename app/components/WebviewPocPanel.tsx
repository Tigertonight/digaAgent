"use client";

/**
 * [PoC] Webview 容器方案验证面板
 *
 * 目的：验证「Electron 主进程通过 webContents.debugger（CDP）控制 <webview>」这条链路，
 * 作为 browser use 从「Playwright 独立 Chromium + 100ms 轮询截图流」迁移到
 * 「原生 webview 容器 + CDP 控制」的可行性证明。
 *
 * 验证点（逐个按钮）：
 *  1. webview 原生渲染页面（对比截图流，应是零延迟、可直接交互）
 *  2. attach：主进程能否 attach debugger 到 webview 的 webContents
 *  3. navigate：能否通过 CDP（而非 webview.src）主动驱动导航 —— 这是 agent 控制的关键
 *  4. inspect：能否读到页面 title/url（DOM/Runtime 读取链路）
 *  5. screenshot：能否 CDP 截图（画面采集链路）
 *  6. click：能否 CDP 坐标点击（agent 操控链路）
 *
 * 隔离性：仅在 Electron 环境（window.miniPi 存在）可用；不触碰现有 /api/browser 路径。
 * 这是实验代码，验证完成后应整理为正式方案或移除。
 */

import Image from "next/image";
import { createElement, useCallback, useEffect, useRef, useState } from "react";

// window.miniPi.webviewPoc 的最小类型（仅 PoC 用）
interface WebviewPocApi {
  attach: (
    webContentsId: number
  ) => Promise<{ ok: boolean; attached?: boolean }>;
  navigate: (
    webContentsId: number,
    url: string
  ) => Promise<{ ok: boolean; url?: string }>;
  inspect: (
    webContentsId: number
  ) => Promise<{ ok: boolean; title?: string | null; url?: string | null }>;
  screenshot: (
    webContentsId: number
  ) => Promise<{ ok: boolean; dataUrl?: string | null }>;
  click: (
    webContentsId: number,
    x: number,
    y: number
  ) => Promise<{ ok: boolean }>;
  detach: (webContentsId: number) => Promise<{ ok: boolean }>;
}

function getWebviewPocApi(): WebviewPocApi | null {
  if (typeof window === "undefined") return null;
  const mp = (window as unknown as { miniPi?: { webviewPoc?: WebviewPocApi } })
    .miniPi;
  return mp?.webviewPoc ?? null;
}

// Electron <webview> DOM 元素的最小类型（getWebContentsId / loadURL）
interface ElectronWebviewElement extends HTMLElement {
  src: string;
  getWebContentsId: () => number;
  loadURL: (url: string) => Promise<void>;
  addEventListener: HTMLElement["addEventListener"];
}

export function WebviewPocPanel() {
  const api = getWebviewPocApi();
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const [url, setUrl] = useState("https://www.baidu.com");
  const [wcId, setWcId] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [shot, setShot] = useState<string | null>(null);
  const [domReady, setDomReady] = useState(false);

  const append = useCallback((line: string) => {
    setLog((prev) => [
      `${new Date().toLocaleTimeString()} ${line}`,
      ...prev,
    ].slice(0, 30));
  }, []);

  // webview dom-ready 后拿 webContentsId（attach 的前提）
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    const onReady = () => {
      try {
        const id = el.getWebContentsId();
        setWcId(id);
        setDomReady(true);
        append(`webview dom-ready, webContentsId=${id}`);
      } catch (e) {
        append(`getWebContentsId failed: ${(e as Error).message}`);
      }
    };
    el.addEventListener("dom-ready", onReady as EventListener);
    return () => el.removeEventListener("dom-ready", onReady as EventListener);
  }, [append]);

  const doAttach = useCallback(async () => {
    if (!api || wcId == null) return;
    try {
      const r = await api.attach(wcId);
      append(`attach -> ${JSON.stringify(r)}`);
    } catch (e) {
      append(`attach ERROR: ${(e as Error).message}`);
    }
  }, [api, wcId, append]);

  const doNavigate = useCallback(async () => {
    if (!api || wcId == null) return;
    try {
      const r = await api.navigate(wcId, url);
      append(`navigate(CDP) -> ${JSON.stringify(r)}`);
    } catch (e) {
      append(`navigate ERROR: ${(e as Error).message}`);
    }
  }, [api, wcId, url, append]);

  const doInspect = useCallback(async () => {
    if (!api || wcId == null) return;
    try {
      const r = await api.inspect(wcId);
      append(`inspect -> title=${r.title} url=${r.url}`);
    } catch (e) {
      append(`inspect ERROR: ${(e as Error).message}`);
    }
  }, [api, wcId, append]);

  const doScreenshot = useCallback(async () => {
    if (!api || wcId == null) return;
    try {
      const r = await api.screenshot(wcId);
      setShot(r.dataUrl ?? null);
      append(`screenshot -> ${r.dataUrl ? "ok (" + r.dataUrl.length + " bytes)" : "null"}`);
    } catch (e) {
      append(`screenshot ERROR: ${(e as Error).message}`);
    }
  }, [api, wcId, append]);

  const doClick = useCallback(async () => {
    if (!api || wcId == null) return;
    try {
      // 点击视口中心做验证
      const r = await api.click(wcId, 640, 400);
      append(`click(640,400) -> ${JSON.stringify(r)}`);
    } catch (e) {
      append(`click ERROR: ${(e as Error).message}`);
    }
  }, [api, wcId, append]);

  if (!api) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-[color:var(--text-muted)]">
        Webview PoC 仅在 Electron 桌面环境可用（未检测到 window.miniPi.webviewPoc）。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--bg)" }}>
      {/* 控制条 */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2.5 py-2"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border px-2 text-xs outline-none"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border)",
            color: "var(--text)",
          }}
          placeholder="URL"
        />
        <PocBtn onClick={() => { const el = webviewRef.current; if (el) el.src = url; }}>
          src 加载
        </PocBtn>
        <PocBtn onClick={doAttach} disabled={!domReady}>attach</PocBtn>
        <PocBtn onClick={doNavigate} disabled={wcId == null}>CDP导航</PocBtn>
        <PocBtn onClick={doInspect} disabled={wcId == null}>取标题</PocBtn>
        <PocBtn onClick={doScreenshot} disabled={wcId == null}>截图</PocBtn>
        <PocBtn onClick={doClick} disabled={wcId == null}>CDP点击中心</PocBtn>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          wcId={wcId ?? "-"}
        </span>
      </div>

      {/* webview 原生容器：这就是「所见即所控」的核心 —— 真实页面，零延迟 */}
      <div className="relative min-h-0 flex-1" style={{ background: "#fff" }}>
        {/* Electron <webview> 是自定义元素，React 无内置类型，用 createElement 规避 JSX 类型检查 */}
        {createElement("webview", {
          ref: webviewRef,
          src: url,
          style: { width: "100%", height: "100%" },
        })}
      </div>

      {/* CDP 截图回显（验证采集链路；与上方 webview 是两套画面来源） */}
      {shot && (
        <div className="shrink-0 border-t p-2" style={{ borderColor: "var(--border-soft)" }}>
          <div className="mb-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
            CDP 截图结果（按需单帧）：
          </div>
          <Image
            src={shot}
            alt="cdp screenshot"
            width={320}
            height={180}
            unoptimized
            className="max-h-32 rounded border object-contain"
            style={{ borderColor: "var(--border-soft)" }}
          />
        </div>
      )}

      {/* 验证日志 */}
      <div
        className="max-h-40 shrink-0 overflow-auto border-t px-2.5 py-1.5 font-mono text-[10px]"
        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
      >
        {log.length === 0 ? (
          <div>等待操作… 先点「attach」验证 CDP 通道。</div>
        ) : (
          log.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </div>
  );
}

function PocBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-7 shrink-0 rounded border px-2 text-[11px] disabled:opacity-40"
      style={{ borderColor: "var(--border)", color: "var(--text)" }}
    >
      {children}
    </button>
  );
}
