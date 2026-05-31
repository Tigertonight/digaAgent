/**
 * 右侧 FileBrowser viewer 的虚拟预览 store。
 *
 * - 让聊天里(Markdown / 消息渲染)能跨组件触发右侧打开 html 字符串 / url 链接 / 图片预览
 * - tab path 用 "html://<id>" / "url://<href>" / "image://<src>",FileBrowser
 *   订阅本 store 的 open 事件,把请求转成 tabs 操作
 * - 解耦:聊天侧不需要拿到 FileBrowser ref,FileBrowser 也不需要侵入 ChatApp props
 */
type PreviewKind = "html" | "url" | "image";

export interface PreviewRequest {
  kind: PreviewKind;
  /** 用作 tab 的稳定 key */
  id: string;
  /** html: 内容字符串;url/image: href */
  payload: string;
  /** 显示在 tab 上的标题 */
  title?: string;
}

type Listener = (req: PreviewRequest) => void;

/** 真正消费请求的订阅者(FileBrowser),消费 pending */
const listeners = new Set<Listener>();
/** 仅做副作用通知的旁路订阅者(ChatApp 用来切右侧面板),不消费 pending */
const sideEffects = new Set<Listener>();
/**
 * 待消费的请求:外部触发时若 FileBrowser 尚未 mount(订阅),
 * 把请求暂存,等订阅者出现立即消费。避免首次触发被丢。
 */
const pending: PreviewRequest[] = [];

let counter = 0;
function nextId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

function emit(req: PreviewRequest): void {
  // 旁路通知(切面板)
  sideEffects.forEach((fn) => fn(req));
  // 主消费者
  if (listeners.size === 0) {
    pending.push(req);
    return;
  }
  listeners.forEach((fn) => fn(req));
}

export const previewStore = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    // 消费积压(只交给最新订阅者)
    if (pending.length > 0) {
      const drain = pending.splice(0);
      drain.forEach((r) => fn(r));
    }
    return () => listeners.delete(fn);
  },
  /** 旁路通知:每次 open 都调用,不消费 pending(适合 ChatApp 切面板) */
  onOpen(fn: Listener): () => void {
    sideEffects.add(fn);
    return () => sideEffects.delete(fn);
  },
  openHtml(content: string, title?: string): void {
    const id = nextId();
    htmlContentStore.set(id, content);
    const req: PreviewRequest = {
      kind: "html",
      id: `html://${id}`,
      payload: content,
      title: title ?? `HTML 预览 ${id.slice(-4)}`,
    };
    emit(req);
  },
  openUrl(href: string, title?: string): void {
    const req: PreviewRequest = {
      kind: "url",
      id: `url://${href}`,
      payload: href,
      title: title ?? hostnameOf(href) ?? href,
    };
    emit(req);
  },
  /**
   * 图片打开走独立的全屏 lightbox（不再塞进右侧 FileBrowser tab）。
   * - 弹层支持下载、缩放、ESC/点击背景关闭
   * - 不触发 sideEffects（不切右侧面板）
   */
  openImage(src: string, title?: string): void {
    imageLightboxStore.open(src, title);
  },
};

/**
 * 全屏图片预览 store。
 * - 独立于 previewStore（图片不再算"文件预览"，单独走蒙层）
 * - 渲染由 <ImageLightbox /> 组件订阅
 */
type LightboxState = { src: string; title?: string } | null;
type LightboxListener = (state: LightboxState) => void;

export const imageLightboxStore = (() => {
  const subs = new Set<LightboxListener>();
  let current: LightboxState = null;
  return {
    open(src: string, title?: string) {
      current = { src, title };
      subs.forEach((fn) => fn(current));
    },
    close() {
      current = null;
      subs.forEach((fn) => fn(null));
    },
    subscribe(fn: LightboxListener): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSnapshot(): LightboxState {
      return current;
    },
    getServerSnapshot(): LightboxState {
      return null;
    },
  };
})();

/** html 内容按 id 存内存(避免在 tab path 里塞整段 HTML) */
const htmlContentStore = new Map<string, string>();

export function getHtmlContent(id: string): string | undefined {
  return htmlContentStore.get(id);
}

export function isVirtualPath(path: string): boolean {
  return (
    path.startsWith("html://") ||
    path.startsWith("url://") ||
    path.startsWith("image://")
  );
}

export function parseVirtualPath(
  path: string
): { kind: PreviewKind; payload: string } | null {
  if (path.startsWith("html://")) {
    const id = path.slice("html://".length);
    const content = htmlContentStore.get(id);
    if (content === undefined) return null;
    return { kind: "html", payload: content };
  }
  if (path.startsWith("url://")) {
    return { kind: "url", payload: path.slice("url://".length) };
  }
  if (path.startsWith("image://")) {
    return { kind: "image", payload: path.slice("image://".length) };
  }
  return null;
}

function hostnameOf(href: string): string | null {
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}
