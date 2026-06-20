"use client";

import React from "react";

interface UiFaultBoundaryProps {
  surface: string;
  fallbackTitle?: string;
  children: React.ReactNode;
}

interface UiFaultBoundaryState {
  error: Error | null;
  info: React.ErrorInfo | null;
  detailsOpen: boolean;
}

export class UiFaultBoundary extends React.Component<
  UiFaultBoundaryProps,
  UiFaultBoundaryState
> {
  state: UiFaultBoundaryState = {
    error: null,
    info: null,
    detailsOpen: false,
  };

  static getDerivedStateFromError(error: Error): Partial<UiFaultBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info });
    if (process.env.NODE_ENV !== "production") {
      console.warn("[ui-fault-boundary] isolated render failure", {
        surface: this.props.surface,
        message: error.message,
      });
    }
  }

  private diagnosticJson(): string {
    return JSON.stringify(
      {
        surface: this.props.surface,
        message: this.state.error?.message,
        stack: this.state.error?.stack,
        componentStack: this.state.info?.componentStack,
      },
      null,
      2
    );
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="rounded-md border px-3 py-2 text-sm"
        style={{
          borderColor: "var(--color-danger)",
          background: "var(--color-danger-bg)",
          color: "var(--text)",
        }}
      >
        <div className="font-semibold text-[color:var(--color-danger)]">
          {this.props.fallbackTitle ?? "数据结构异常，已隔离该模块"}
        </div>
        <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
          {this.props.surface} 暂时无法渲染，其它区域仍可继续使用。
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded border px-2 py-1 text-token-xs hover:bg-[color:var(--bg-hover)]"
            onClick={() =>
              this.setState((state) => ({ detailsOpen: !state.detailsOpen }))
            }
          >
            {this.state.detailsOpen ? "收起详情" : "展开详情"}
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1 text-token-xs hover:bg-[color:var(--bg-hover)]"
            onClick={() => void navigator.clipboard?.writeText(this.diagnosticJson())}
          >
            复制诊断 JSON
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1 text-token-xs hover:bg-[color:var(--bg-hover)]"
            onClick={() => window.location.reload()}
          >
            重新加载当前 session
          </button>
        </div>
        {this.state.detailsOpen ? (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-2 text-token-xs">
            {this.diagnosticJson()}
          </pre>
        ) : null}
      </div>
    );
  }
}
