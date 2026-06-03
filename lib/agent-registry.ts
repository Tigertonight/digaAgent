/**
 * AgentSession 进程内注册表。
 *
 * 负责：
 * 1. 创建/复用 AgentSession（用 createAgentSession 工厂）
 * 2. 把每个 AgentSession 的事件流缓存到内存 ring buffer，让 SSE 路由能"回放 + 续传"
 *
 * 注意：Next dev 模式下 module 会被 hot-reload，用 globalThis 持久化避免每次代码改动就丢 state。
 */
import "server-only";
import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  SettingsManager,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createCollabExtension } from "./collab/extension";
import { createClarificationExtension } from "./clarification/extension";
import { createBrowserExtension } from "./browser/extension";
import { disposeBrowser } from "./browser/runtime";
import { DEFAULT_RULES } from "./collab/rules";
import {
  clearSessionRemember,
  hasSessionRemember,
  registerPendingApproval,
} from "./collab/server-store";
import {
  clearAgentClarifications,
  registerPendingClarification,
} from "./clarification/server-store";
import type {
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "./collab/types";
import type {
  ClarificationRequestEvent,
  ClarificationResolvedEvent,
} from "./clarification/types";
import type { BrowserStateEvent } from "./browser/types";

/**
 * Ring buffer 里允许的事件类型。
 *
 * 除了 SDK 的 AgentSessionEvent，还包含 collab 自己的两个事件——它们走相同的 SSE 通道
 * 被推到前端，前端 useAgentEvents 按 type 字段分发。
 *
 * 注：把 union 包给 events 字段使用，对 SSE encode 路径透明（JSON.stringify 即可），
 * 对 SDK subscribe 路径也不影响（subscribe handler 仍然只塞 AgentSessionEvent）。
 */
export type RingBufferEvent =
  | AgentSessionEvent
  | ApprovalRequestEvent
  | ApprovalResolvedEvent
  | ClarificationRequestEvent
  | ClarificationResolvedEvent
  | BrowserStateEvent;

interface AgentRecord {
  id: string;
  session: AgentSession;
  /**
   * 事件 ring buffer:固定容量环形数组,避免每次满了 splice(O(n))。
   * - 写:events[head++ % MAX],覆盖最旧
   * - 读:遍历 [head - count, head),根据 seq 过滤
   * - count = min(nextSeq, MAX),buffer 满之前 count == nextSeq
   */
  events: Array<{ seq: number; event: RingBufferEvent } | undefined>;
  nextSeq: number;
  /** notify all SSE listeners */
  listeners: Set<() => void>;
  /** 用来在 dispose 时取消订阅 */
  unsubscribe: () => void;
  /** 当前是否在跑(agent_start/end 之间为 true);给 sidebar 标"运行中"用 */
  isStreaming: boolean;
}

const MAX_EVENTS_PER_AGENT = 5000;

interface GlobalRegistry {
  agents: Map<string, AgentRecord>;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  /** SettingsManager 以 cwd 缓存，全局/项目 settings 不同 */
  settingsManagers?: Map<string, SettingsManager>;
  packageManagers?: Map<string, DefaultPackageManager>;
}

const g = globalThis as unknown as { __miniPi?: GlobalRegistry };
if (!g.__miniPi) {
  g.__miniPi = { agents: new Map() };
}
const reg = g.__miniPi!;

export function getAuth(): AuthStorage {
  if (!reg.authStorage) {
    reg.authStorage = AuthStorage.create();
  }
  return reg.authStorage;
}

export function getModelRegistry(): ModelRegistry {
  if (!reg.modelRegistry) {
    reg.modelRegistry = ModelRegistry.create(getAuth());
  }
  return reg.modelRegistry;
}

/** 拿（或创建）对应 cwd 的 SettingsManager */
export function getSettingsManager(cwd?: string): SettingsManager {
  const useCwd = cwd && cwd.length > 0 ? cwd : os.homedir();
  if (!reg.settingsManagers) reg.settingsManagers = new Map();
  let sm = reg.settingsManagers.get(useCwd);
  if (!sm) {
    sm = SettingsManager.create(useCwd);
    reg.settingsManagers.set(useCwd, sm);
  }
  return sm;
}

/** 拿（或创建）对应 cwd 的 PackageManager */
export function getPackageManager(cwd?: string): DefaultPackageManager {
  const useCwd = cwd && cwd.length > 0 ? cwd : os.homedir();
  if (!reg.packageManagers) reg.packageManagers = new Map();
  let pm = reg.packageManagers.get(useCwd);
  if (!pm) {
    pm = new DefaultPackageManager({
      cwd: useCwd,
      agentDir: getAgentDir(),
      settingsManager: getSettingsManager(useCwd),
    });
    reg.packageManagers.set(useCwd, pm);
  }
  return pm;
}

/**
 * 把一条「非 SDK 来源」的事件塞进 ring buffer 并通知 SSE listeners。
 *
 * 用途：collab 自定义事件（approval_request / approval_resolved）走相同 SSE 通道
 * 推到前端，前端按 type 字段分发。
 *
 * 设计要点：
 *   - 与 session.subscribe 内的写入路径**完全对称**（同步 seq++、同 ring buffer 写法、
 *     同 listeners 通知）；这样 SSE 路由按 seq 顺序读出后 since 重连语义保持一致
 *   - 不更新 isStreaming flag（approval 事件不算 agent_start/end）
 */
export function pushExternalEvent(
  rec: AgentRecord,
  event:
    | ApprovalRequestEvent
    | ApprovalResolvedEvent
    | ClarificationRequestEvent
    | ClarificationResolvedEvent
    | BrowserStateEvent
): void {
  const seq = rec.nextSeq++;
  rec.events[seq % MAX_EVENTS_PER_AGENT] = { seq, event };
  for (const l of rec.listeners) l();
}

export interface CreateOptions {
  provider: string;
  modelId: string;
  cwd: string;
  /** 复用已有 session 文件（resume） */
  sessionPath?: string;
  /** thinking level，默认 medium */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export async function createAgent(opts: CreateOptions): Promise<{
  id: string;
  sessionId: string;
  sessionFile: string | undefined;
}> {
  const mr = getModelRegistry();
  const model = mr.find(opts.provider, opts.modelId);
  if (!model) {
    throw new Error(
      `model not found: ${opts.provider}/${opts.modelId}. Hint: 确认 provider 名 + env API key 已设置。`
    );
  }

  // 准备 SessionManager（要么 resume 已有文件，要么基于 cwd 新建）
  let sessionManager: SessionManager;
  if (opts.sessionPath) {
    sessionManager = SessionManager.open(opts.sessionPath);
  } else {
    sessionManager = SessionManager.create(opts.cwd);
  }

  // 提前生成 agentId —— B2 的 CollabExtension 需要 id 闭包来标记审批归属。
  // 这里提前到 createAgentSession 之前不影响 B1 行为（id 仍然唯一）。
  const id = randomUUID();

  // record 在 createAgentSession 之后才能建（要拿 session 实例）。
  // 但 CollabExtension 的 onApprovalNeeded 闭包需要访问 record 来 push 自定义事件——
  // 用 mutable holder 解决前向引用：handler 触发时 holder.current 一定已被赋值
  // （tool_call 发生时 createAgentSession 已完成，record 已建好）。
  const recordHolder: { current: AgentRecord | null } = { current: null };

  // 构造 ResourceLoader 并注入真 CollabExtension（Phase B3 接真通道）。
  // - getRules: 内置 1 条 dangerous-bash-destructive；未来 Settings 可注入用户规则
  // - getAgentId: 闭包到当前 id，approval id 用 `${agentId}:${toolCallId}` 复合 key
  // - onApprovalNeeded:
  //     1. push approval_request 进 ring buffer → SSE 通知前端弹气泡
  //     2. registerPendingApproval await 用户决策（或 5min 超时按 defaultDecision）
  //     3. push approval_resolved 进 ring buffer → SSE 通知前端更新气泡状态
  //     4. return 给 CollabExtension，由它决定 allow/block tool
  const collabExtension = createCollabExtension({
    getRules: () => DEFAULT_RULES,
    getAgentId: () => id,
    // B4：让 extension 在命中 ask 规则前先查"本 session 不再问"集合，
    // 命中即静默放行——比 onApprovalNeeded 后再返回 allow 更彻底（不弹气泡也不推事件）。
    hasRemember: (ruleId: string) => hasSessionRemember(id, ruleId),
    onApprovalNeeded: async (req) => {
      const rec = recordHolder.current;
      // 安全网：理论上 rec 一定有；若没有则降级 auto-allow（避免卡死 agent）。
      if (!rec) {
        console.error(
          "[collab] onApprovalNeeded called but record not ready; defaulting allow",
          req.id
        );
        return { decision: "allow" };
      }
      pushExternalEvent(rec, { type: "approval_request", request: req });
      const resp = await registerPendingApproval(req);
      // resolvedBy：本函数 await 时无法区分是 user 主动还是 timeout 触发了 resolver。
      // 由 server-store 内 setTimeout 触发的 resolve 不带 denyReason → 我们近似认为
      // 没 denyReason 且 decision === defaultDecision 时是超时；其余视为 user。
      // （Phase C 可在 ApprovalResponse 加 source 字段消除歧义，B3 先够用。）
      const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
        resp.denyReason === undefined && resp.decision === req.defaultDecision
          ? "timeout"
          : "user";
      pushExternalEvent(rec, {
        type: "approval_resolved",
        id: req.id,
        toolCallId: req.toolCallId,
        decision: resp.decision,
        resolvedBy,
        denyReason: resp.denyReason,
      });
      return resp;
    },
  });

  const clarificationExtension = createClarificationExtension({
    getAgentId: () => id,
    onClarificationNeeded: async (req) => {
      const rec = recordHolder.current;
      if (!rec) {
        console.error(
          "[clarification] ask_user called but record not ready; returning empty response",
          req.id
        );
        return { customText: "No UI channel was available." };
      }
      pushExternalEvent(rec, {
        type: "clarification_request",
        request: req,
      });
      const resp = await registerPendingClarification(req);
      pushExternalEvent(rec, {
        type: "clarification_resolved",
        id: req.id,
        requestId: req.requestId,
        selectedOptionId: resp.selectedOptionId,
        customText: resp.customText,
        resolvedBy: "user",
      });
      return resp;
    },
  });

  const browserExtension = createBrowserExtension({
    getAgentId: () => id,
    onBrowserState: (snapshot) => {
      const rec = recordHolder.current;
      if (!rec) return;
      pushExternalEvent(rec, { type: "browser_state", snapshot });
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    settingsManager: getSettingsManager(opts.cwd),
    extensionFactories: [collabExtension, clarificationExtension, browserExtension],
  });

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    thinkingLevel: opts.thinkingLevel ?? "medium",
    sessionManager,
    authStorage: getAuth(),
    modelRegistry: mr,
    resourceLoader,
  });
  const record: AgentRecord = {
    id,
    session,
    events: new Array(MAX_EVENTS_PER_AGENT),
    nextSeq: 0,
    listeners: new Set(),
    unsubscribe: () => {},
    isStreaming: false,
  };
  // 让 CollabExtension 的闭包能 push 自定义事件（approval_request/resolved）
  recordHolder.current = record;

  // 把 AgentSession 的事件流接到 ring buffer + 通知 listeners
  record.unsubscribe = session.subscribe((event) => {
    // 维护"是否正在跑"flag —— sidebar 状态点直接读它
    if (event.type === "agent_start") record.isStreaming = true;
    else if (event.type === "agent_end") record.isStreaming = false;
    const seq = record.nextSeq++;
    record.events[seq % MAX_EVENTS_PER_AGENT] = { seq, event };
    for (const l of record.listeners) l();
  });

  reg.agents.set(id, record);

  return {
    id,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
  };
}

export function getAgent(id: string): AgentRecord | undefined {
  return reg.agents.get(id);
}

/**
 * 返回当前所有 active AgentSession 的 sessionFile 路径集合。
 * 给前端 sidebar 标"运行中"用 —— sessionFile 与 SessionInfo.path 一致。
 */
export function getRunningSessionFiles(): Set<string> {
  const out = new Set<string>();
  for (const rec of reg.agents.values()) {
    if (!rec.isStreaming) continue;
    const f = rec.session.sessionFile;
    if (f) out.add(f);
  }
  return out;
}

export function disposeAgent(id: string) {
  const rec = reg.agents.get(id);
  if (!rec) return;
  rec.unsubscribe();
  rec.session.dispose();
  reg.agents.delete(id);
  // B4：清理"本 session 不再问"记忆，避免悬挂（其他 agentId 复用同 globalThis store 不受影响）
  clearSessionRemember(id);
  clearAgentClarifications(id);
  void disposeBrowser(id);
}

/** 给 SSE 用：拿从某个 seq 之后的所有事件（按 seq 升序） */
export function getEventsSince(
  agentId: string,
  sinceSeq: number
): Array<{ seq: number; event: RingBufferEvent }> {
  const rec = reg.agents.get(agentId);
  if (!rec) return [];
  // ring buffer 物理顺序≠seq 顺序（环到头会从下标 0 重新覆盖）。
  // 遍历整个 buffer，跳过 undefined 与 seq<=since 的项；最后按 seq 升序排。
  // 一次回放最多 MAX_EVENTS_PER_AGENT 条，sort 成本可接受。
  const out: Array<{ seq: number; event: RingBufferEvent }> = [];
  for (const e of rec.events) {
    if (e && e.seq > sinceSeq) out.push(e);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** 注册一个事件监听器（用于 SSE 长连接），返回取消函数 */
export function onNewEvent(agentId: string, cb: () => void): () => void {
  const rec = reg.agents.get(agentId);
  if (!rec) return () => {};
  rec.listeners.add(cb);
  return () => {
    rec.listeners.delete(cb);
  };
}

export { getAgentDir };
