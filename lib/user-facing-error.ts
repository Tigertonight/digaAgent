export type UserFacingErrorCode =
  | "pairing_required"
  | "remote_unreachable"
  | "public_unavailable"
  | "host_offline"
  | "model_auth_missing"
  | "not_found"
  | "rate_limited"
  | "server_busy"
  | "unknown";

export interface UserFacingError {
  code: UserFacingErrorCode;
  title: string;
  message: string;
  actionLabel?: string;
  recoverable: boolean;
}

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isPublicBase(base?: string): boolean {
  if (!base) return false;
  try {
    return new URL(base).hostname.endsWith(".trycloudflare.com");
  } catch {
    return base.includes("trycloudflare.com");
  }
}

export function toUserFacingError(
  error: unknown,
  opts: { baseUrl?: string; context?: "remote" | "pairing" | "settings" | "skills" } = {}
): UserFacingError {
  const raw = textOf(error).trim();
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("remote token") ||
    normalized.includes("配对") ||
    normalized.includes("pairing code expired") ||
    normalized.includes("pairing code expired or invalid")
  ) {
    return {
      code: "pairing_required",
      title: "需要重新扫码",
      message: "当前移动端授权已失效，请回到电脑端重新生成二维码并扫码连接。",
      actionLabel: "重新扫码",
      recoverable: true,
    };
  }

  if (
    normalized.includes("load failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("network") ||
    normalized.includes("timeout") ||
    normalized.includes("aborterror") ||
    normalized.includes("所有候选地址都不可达")
  ) {
    const publicOnly = isPublicBase(opts.baseUrl);
    return {
      code: publicOnly ? "public_unavailable" : "remote_unreachable",
      title: publicOnly ? "公网连接不可用" : "网络恢复中",
      message: publicOnly
        ? "公网通道暂时不可达，请刷新、重新扫码，或让手机和电脑切换到同一 Wi-Fi 后重试。"
        : "暂时无法连接电脑端，请确认电脑端 Diga Agent 已开启，并稍后重试。",
      actionLabel: "重试",
      recoverable: true,
    };
  }

  if (normalized.includes("not found") || normalized.includes("404")) {
    return {
      code: "not_found",
      title: "状态已变化",
      message: "当前会话或资源已变化，请刷新后重试。",
      actionLabel: "刷新",
      recoverable: true,
    };
  }

  if (normalized.includes("429") || normalized.includes("rate limit")) {
    return {
      code: "rate_limited",
      title: "请求过于频繁",
      message: "模型服务暂时限流，请稍后再试，或切换其他模型。",
      actionLabel: "稍后重试",
      recoverable: true,
    };
  }

  if (
    normalized.includes("provider") ||
    normalized.includes("api key") ||
    normalized.includes("auth failed") ||
    normalized.includes("没有可用 provider") ||
    normalized.includes("no available provider")
  ) {
    return {
      code: "model_auth_missing",
      title: "模型账号需要配置",
      message: "当前没有可用模型或凭证不可用，请到设置里的“模型与账号”完成配置。",
      actionLabel: "去设置",
      recoverable: true,
    };
  }

  if (
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504")
  ) {
    return {
      code: "server_busy",
      title: "服务暂时不可用",
      message: "电脑端服务正在恢复，请稍后刷新重试。",
      actionLabel: "刷新",
      recoverable: true,
    };
  }

  return {
    code: "unknown",
    title: "操作失败",
    message: raw || "操作没有完成，请稍后重试。",
    actionLabel: "重试",
    recoverable: true,
  };
}

export function userFacingMessage(
  error: unknown,
  opts?: Parameters<typeof toUserFacingError>[1]
): string {
  return toUserFacingError(error, opts).message;
}
