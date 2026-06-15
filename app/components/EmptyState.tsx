"use client";

import type { ProviderInfo } from "@/lib/types";
import { Cpu, FolderOpen, Send } from "lucide-react";
import { Typewriter, TYPEWRITER_PHRASES } from "./Typewriter";
import { BrandLogo } from "./BrandLogo";
import { shouldShowOnboarding } from "./EmptyState.helpers";

export { shouldShowOnboarding } from "./EmptyState.helpers";

export interface EmptyStateProps {
  /** 当前可见的 providers（有 hasAuth=true 才算"接好了"）。null/undefined 视为还没加载好。 */
  visibleProviders?: ProviderInfo[] | null;
  /** 用户点 "配置模型" 时打开 provider setup 弹窗。 */
  onOpenProviderSetup?: () => void;
  /**
   * Ux-1：是否处于"首次启动 / 无 provider"分支。父级可以传 false 来强制走旧装饰态
   * （比如 e2e 模式 / 移动端复用）。默认 = visibleProviders 长度 0 时为真。
   */
  forceOnboarding?: boolean;
}

/**
 * 空白态。两种渲染：
 *  - 普通：品牌 logo + Typewriter（沿用历史装饰态）。
 *  - 引导：无 provider 时显示三步引导卡，避免用户首次开门看到空白不知所措。
 */
export function EmptyState({
  visibleProviders,
  onOpenProviderSetup,
  forceOnboarding,
}: EmptyStateProps = {}) {
  const isOnboarding = shouldShowOnboarding({
    visibleProviders,
    forceOnboarding,
  });

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-[820px]">
        {/* 顶部品牌区 —— 两种状态都保留 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginLeft: 16,
            marginRight: 52,
            fontFamily: "var(--font-mono)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
              flex: 1,
              lineHeight: 1.4,
            }}
          >
            <div style={{ flexShrink: 0 }}>
              <BrandLogo size={56} />
            </div>
            <span
              style={{
                fontSize: 22,
                color: "var(--text)",
                fontWeight: 700,
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Diga Agent
            </span>
            <span
              style={{
                fontSize: 14,
                minWidth: 0,
                flex: 1,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              <Typewriter phrases={TYPEWRITER_PHRASES} />
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 2,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              web{" "}
              <span style={{ color: "var(--text)" }}>
                v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}
              </span>
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              pi{" "}
              <span style={{ color: "var(--text)" }}>
                v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}
              </span>
            </span>
          </div>
        </div>

        {/* Ux-1：引导卡 —— 只在 isOnboarding 时显示 */}
        {isOnboarding && (
          <div
            data-testid="empty-state-onboarding"
            className="mt-8 ml-4 mr-4 rounded-token border p-5"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-panel-2)",
            }}
          >
            <div
              className="text-token-body font-semibold"
              style={{ color: "var(--text)" }}
            >
              开始使用 Diga Agent
            </div>
            <div
              className="mt-1 text-token-sm"
              style={{ color: "var(--text-muted)" }}
            >
              三步就可以发出第一条消息：
            </div>
            <ol className="mt-4 flex flex-col gap-3">
              <OnboardingStep
                index={1}
                icon={<Cpu size={14} />}
                title="接入一个模型"
                hint="复用本机已有账号 / 填写 API Key / 添加本地或自定义端点。"
                actionLabel="配置模型"
                onAction={onOpenProviderSetup}
              />
              <OnboardingStep
                index={2}
                icon={<FolderOpen size={14} />}
                title="选择一个工作目录"
                hint="左上角 Explorer 选 cwd；agent 的读写都被限制在这个目录及其子目录。"
              />
              <OnboardingStep
                index={3}
                icon={<Send size={14} />}
                title="发出第一条消息"
                hint="底部输入框输入需求并回车。可以用 @ 引用文件、用 / 触发命令。"
              />
            </ol>
            <div
              className="mt-4 text-token-xs"
              style={{ color: "var(--text-dim)" }}
            >
              出问题了？菜单 Help → 「导出诊断信息…」 把 JSON 发给我们。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface OnboardingStepProps {
  index: number;
  icon: React.ReactNode;
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
}

function OnboardingStep({
  index,
  icon,
  title,
  hint,
  actionLabel,
  onAction,
}: OnboardingStepProps) {
  return (
    <li className="flex items-start gap-3">
      <div
        className="flex shrink-0 items-center justify-center rounded-full border"
        style={{
          width: 24,
          height: 24,
          borderColor: "var(--border)",
          color: "var(--text-muted)",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
        }}
        aria-hidden
      >
        {index}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-2 text-token-body"
          style={{ color: "var(--text)" }}
        >
          <span className="opacity-70">{icon}</span>
          <span>{title}</span>
        </div>
        <div
          className="mt-0.5 text-token-sm"
          style={{ color: "var(--text-muted)" }}
        >
          {hint}
        </div>
      </div>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded border px-2.5 py-1 text-token-xs hover:bg-[color:var(--bg-hover)]"
          style={{ borderColor: "var(--border)", color: "var(--text)" }}
        >
          {actionLabel}
        </button>
      ) : null}
    </li>
  );
}
