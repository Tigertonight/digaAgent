export type BrowserRuntimeStatus =
  | "idle"
  | "launching"
  | "ready"
  | "busy"
  | "error"
  | "closed";

export interface BrowserActionLog {
  id: string;
  taskId?: string;
  action: string;
  label: string;
  status: "running" | "done" | "error";
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface BrowserPointerState {
  x: number;
  y: number;
  action: string;
  label: string;
  updatedAt: number;
}

export interface BrowserStepSnapshot {
  id: string;
  taskId?: string;
  action: string;
  label: string;
  status: "done" | "error";
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  pointer: BrowserPointerState | null;
  createdAt: number;
  error?: string;
  /**
   * 阶段 C：验收结论。来自 browser_verify / browser_wait_for 的 evidence.passed。
   * - true  -> 该步是一次通过的验收
   * - false -> 该步是一次失败的验收
   * - undefined -> 该步不是验收类动作（如 open/click），无判定
   */
  passed?: boolean;
  /** 阶段 C：browser_extract 提取到的可见文本摘要，作为该步的证据正文。 */
  extractedText?: string;
}

/**
 * 阶段 D：页面批注。用户在 BrowserPanel 里框选页面区域 + 留言，
 * 产出一条结构化批注，持久化在 runtime（进 snapshot.annotations），
 * 通过 SSE 同步给前端，并可作为视觉任务喂给 agent。
 *
 * rect 用归一化坐标 [0,1]，与截图/画面分辨率无关，便于前后端一致叠加。
 */
export interface BrowserAnnotation {
  id: string;
  /** 归属的 browserId（agent:/standalone:/task:），便于多浏览器隔离。 */
  browserId: string;
  url: string | null;
  title: string | null;
  /** 框选区域，归一化坐标 [0,1]。 */
  rect: { x: number; y: number; w: number; h: number };
  comment: string;
  /** 批注时刻的视口截图（data URL），作为该批注的视觉证据快照。 */
  screenshotDataUrl: string | null;
  createdAt: number;
  updatedAt?: number;
  resolvedAt?: number;
  /**
   * 状态：open=待处理；resolved=已处理（agent 修复或用户标记完成）。
   * 默认 open。
   */
  status?: "open" | "resolved";
}

export interface BrowserTaskState {
  id: string;
  status: "running" | "passed" | "failed" | "blocked";
  intent: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface BrowserSnapshot {
  status: BrowserRuntimeStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  updatedAt: number | null;
  error: string | null;
  pointer: BrowserPointerState | null;
  task: BrowserTaskState | null;
  logs: BrowserActionLog[];
  steps: BrowserStepSnapshot[];
  /** 阶段 D：当前浏览器上的页面批注（持久化，随 SSE 同步）。 */
  annotations: BrowserAnnotation[];
}

export interface BrowserStateEvent {
  type: "browser_state";
  snapshot: BrowserSnapshot;
}

export interface BrowserExtractResult {
  url: string | null;
  title: string | null;
  text: string;
  links: Array<{ text: string; href: string }>;
  inputs: Array<{ label: string; type: string; name: string; placeholder: string }>;
  actions: Array<{
    kind: "link" | "button" | "input";
    text: string;
    selectorHint: string;
  }>;
}

export interface BrowserVerifyResult {
  passed: boolean;
  expectation: string;
  evidence: string;
  url: string | null;
  title: string | null;
}

/**
 * 结构化 browser tool 的统一证据载荷。
 *
 * 阶段 B：每个 browser_* 工具执行后，除了给模型的自然语言 observation，
 * 还统一产出这份机器可读的 evidence，供前端「验收证据面板」与审计消费。
 * 所有字段都是可选的——不同 action 只填它能提供的那部分。
 */
export interface BrowserToolEvidence {
  /** 触发该证据的工具名，如 "browser_open"。 */
  tool: string;
  /** 动作完成后的当前 URL。 */
  url: string | null;
  /** 动作完成后的页面标题。 */
  title: string | null;
  /** 动作完成后的视口截图（data URL）。 */
  screenshotDataUrl?: string | null;
  /** browser_extract 提取到的可见文本摘要。 */
  extractedText?: string;
  /** browser_verify 的判定结果。 */
  passed?: boolean;
}

/**
 * 结构化 browser tool 的统一返回结构（阶段 B 理想形态）。
 * 注意：SDK 的 defineTool 要求 execute 返回 { content, details } 形态，
 * 因此 runtime/extension 内部用本结构组织数据，再映射到 SDK 的返回值：
 *   - observation -> content[].text（给模型读）
 *   - snapshot/evidence -> details（给前端/审计读）
 */
export interface BrowserToolResult {
  observation: string;
  snapshot: BrowserSnapshot;
  evidence: BrowserToolEvidence;
}

export type BrowserSiteDecision = "local" | "allowed" | "blocked" | "unknown";

export interface BrowserSitePolicy {
  allowedOrigins: string[];
  blockedOrigins: string[];
}

export interface BrowserSiteCheck {
  origin: string;
  decision: BrowserSiteDecision;
  policy: BrowserSitePolicy;
}

export const EMPTY_BROWSER_SNAPSHOT: BrowserSnapshot = {
  status: "idle",
  url: null,
  title: null,
  screenshotDataUrl: null,
  updatedAt: null,
  error: null,
  pointer: null,
  task: null,
  logs: [],
  steps: [],
  annotations: [],
};
