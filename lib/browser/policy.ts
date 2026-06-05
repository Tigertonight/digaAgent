import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import type {
  BrowserSiteCheck,
  BrowserSiteDecision,
  BrowserSitePolicy,
} from "./types";

const POLICY_PATH = join(os.homedir(), ".pi", "agent", "browser-sites.json");

const DEFAULT_POLICY: BrowserSitePolicy = {
  allowedOrigins: [],
  blockedOrigins: [],
};

function normalizePolicy(raw: unknown): BrowserSitePolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  const obj = raw as Record<string, unknown>;
  const allowedOrigins = Array.isArray(obj.allowedOrigins)
    ? obj.allowedOrigins.filter((x): x is string => typeof x === "string")
    : [];
  const blockedOrigins = Array.isArray(obj.blockedOrigins)
    ? obj.blockedOrigins.filter((x): x is string => typeof x === "string")
    : [];
  return {
    allowedOrigins: [...new Set(allowedOrigins)].sort(),
    blockedOrigins: [...new Set(blockedOrigins)].sort(),
  };
}

export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("url required");
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function originForBrowserUrl(url: string): string {
  const normalized = normalizeBrowserUrl(url);
  const u = new URL(normalized);
  if (u.protocol === "file:") return "file://";
  return u.origin;
}

function isLocalOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export async function loadBrowserSitePolicy(): Promise<BrowserSitePolicy> {
  try {
    const raw = await readFile(POLICY_PATH, "utf8");
    return normalizePolicy(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

async function saveBrowserSitePolicy(
  policy: BrowserSitePolicy
): Promise<BrowserSitePolicy> {
  const normalized = normalizePolicy(policy);
  await mkdir(dirname(POLICY_PATH), { recursive: true });
  await writeFile(POLICY_PATH, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

export async function checkBrowserSite(url: string): Promise<BrowserSiteCheck> {
  const origin = originForBrowserUrl(url);
  const policy = await loadBrowserSitePolicy();
  let decision: BrowserSiteDecision = "unknown";
  if (isLocalOrigin(origin)) decision = "local";
  else if (policy.blockedOrigins.includes(origin)) decision = "blocked";
  else if (policy.allowedOrigins.includes(origin)) decision = "allowed";
  return { origin, decision, policy };
}

export async function allowBrowserSite(originOrUrl: string) {
  const origin = originForBrowserUrl(originOrUrl);
  const policy = await loadBrowserSitePolicy();
  const next = await saveBrowserSitePolicy({
    allowedOrigins: [...policy.allowedOrigins.filter((x) => x !== origin), origin],
    blockedOrigins: policy.blockedOrigins.filter((x) => x !== origin),
  });
  return { origin, policy: next };
}

export async function blockBrowserSite(originOrUrl: string) {
  const origin = originForBrowserUrl(originOrUrl);
  const policy = await loadBrowserSitePolicy();
  const next = await saveBrowserSitePolicy({
    allowedOrigins: policy.allowedOrigins.filter((x) => x !== origin),
    blockedOrigins: [...policy.blockedOrigins.filter((x) => x !== origin), origin],
  });
  return { origin, policy: next };
}

export async function removeBrowserSitePolicy(originOrUrl: string) {
  const origin = originForBrowserUrl(originOrUrl);
  const policy = await loadBrowserSitePolicy();
  const next = await saveBrowserSitePolicy({
    allowedOrigins: policy.allowedOrigins.filter((x) => x !== origin),
    blockedOrigins: policy.blockedOrigins.filter((x) => x !== origin),
  });
  return { origin, policy: next };
}

export async function assertBrowserSiteAllowed(url: string): Promise<string> {
  const normalized = normalizeBrowserUrl(url);
  const check = await checkBrowserSite(normalized);
  if (check.decision === "blocked") {
    throw new Error(`Browser site is blocked: ${check.origin}`);
  }
  if (check.decision === "unknown") {
    throw new Error(`Browser site is not allowed yet: ${check.origin}`);
  }
  return normalized;
}

// ===========================================================================
// 阶段 E：敏感动作检测
// 表单提交、上传、登录、付款等动作风险更高，即使站点已 allowed 也需额外确认。
// ===========================================================================

export type BrowserSensitiveAction =
  | "login"
  | "payment"
  | "upload"
  | "submit";

const SENSITIVE_PATTERNS: Array<{
  action: BrowserSensitiveAction;
  re: RegExp;
}> = [
  {
    action: "payment",
    re: /(支付|付款|结算|下单|购买|充值|绑卡|信用卡|银行卡|pay|checkout|purchase|billing|card\s*number|cvv)/i,
  },
  {
    action: "login",
    re: /(登录|登陆|注册|sign\s*in|sign\s*up|log\s*in|login|register|password|密码|验证码|otp|two[-\s]?factor|2fa)/i,
  },
  {
    action: "upload",
    re: /(上传|上传文件|upload|attach\s*file|choose\s*file|select\s*file)/i,
  },
  {
    action: "submit",
    re: /(提交|发送|确认提交|submit|确认订单|确认支付)/i,
  },
];

/**
 * 从一段文本（动作 label / 输入文本 / selector / 当前 URL）里识别敏感动作。
 * 返回命中的最高风险动作；没命中返回 null。
 * 风险序：payment > login > upload > submit（数组顺序即优先级）。
 */
export function detectSensitiveAction(
  ...texts: Array<string | null | undefined>
): BrowserSensitiveAction | null {
  const haystack = texts.filter(Boolean).join(" ");
  if (!haystack) return null;
  for (const { action, re } of SENSITIVE_PATTERNS) {
    if (re.test(haystack)) return action;
  }
  return null;
}

/** 敏感动作的中文说明（审批气泡展示用）。 */
export function describeSensitiveAction(
  action: BrowserSensitiveAction
): string {
  switch (action) {
    case "payment":
      return "付款 / 支付相关操作";
    case "login":
      return "登录 / 注册 / 凭据输入";
    case "upload":
      return "文件上传";
    case "submit":
      return "表单提交";
  }
}
