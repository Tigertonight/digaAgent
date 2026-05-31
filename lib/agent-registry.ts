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
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import os from "node:os";

interface AgentRecord {
  id: string;
  session: AgentSession;
  /**
   * 事件 ring buffer:固定容量环形数组,避免每次满了 splice(O(n))。
   * - 写:events[head++ % MAX],覆盖最旧
   * - 读:遍历 [head - count, head),根据 seq 过滤
   * - count = min(nextSeq, MAX),buffer 满之前 count == nextSeq
   */
  events: Array<{ seq: number; event: AgentSessionEvent } | undefined>;
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

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    thinkingLevel: opts.thinkingLevel ?? "medium",
    sessionManager,
    authStorage: getAuth(),
    modelRegistry: mr,
  });

  const id = randomUUID();
  const record: AgentRecord = {
    id,
    session,
    events: new Array(MAX_EVENTS_PER_AGENT),
    nextSeq: 0,
    listeners: new Set(),
    unsubscribe: () => {},
    isStreaming: false,
  };

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
}

/** 给 SSE 用：拿从某个 seq 之后的所有事件（按 seq 升序） */
export function getEventsSince(
  agentId: string,
  sinceSeq: number
): Array<{ seq: number; event: AgentSessionEvent }> {
  const rec = reg.agents.get(agentId);
  if (!rec) return [];
  // ring buffer 物理顺序≠seq 顺序（环到头会从下标 0 重新覆盖）。
  // 遍历整个 buffer，跳过 undefined 与 seq<=since 的项；最后按 seq 升序排。
  // 一次回放最多 MAX_EVENTS_PER_AGENT 条，sort 成本可接受。
  const out: Array<{ seq: number; event: AgentSessionEvent }> = [];
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
