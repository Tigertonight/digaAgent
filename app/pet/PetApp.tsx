"use client";

import { useEffect, useRef, useState } from "react";
import { usePetState } from "./use-pet-state";
import { usePetDrag } from "./use-pet-drag";
import { usePetToasts } from "./use-pet-toasts";
import PetSprite from "./PetSprite";
import PetBubble from "./PetBubble";
import PetCard from "./PetCard";
import PetToastStack from "./PetToastStack";

export default function PetApp() {
  const {
    animState,
    displaySession,
    allSessions,
    localFocusId,
    setLocalFocusId,
    focusMain,
    bubbleText,
    petState,
  } = usePetState();

  const { onMouseDown, dragging, wasJustDragged } = usePetDrag();

  // 临时事件 toast 队列（基于 petState 边沿变化派生）
  const toasts = usePetToasts(petState);

  // hover 状态拆分：sprite 上 / 气泡上 / 关闭延迟计时器
  // 任意一个 hover=true 时气泡显示；都 false 时延迟 300ms 关闭
  // 这样鼠标从 sprite 移动到气泡的"空隙"瞬间不会闪烁，且鼠标在气泡上时气泡不消失
  const [spriteHover, setSpriteHover] = useState(false);
  const [bubbleHover, setBubbleHover] = useState(false);
  const [bubbleVisible, setBubbleVisible] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [cardOpen, setCardOpen] = useState(false);
  const spriteRef = useRef<HTMLDivElement>(null);

  // 单击 / 双击区分：原生 dblclick 会先触发两次 click，导致"开卡片 → 跳主窗"夹叙。
  // 用计数 + 200ms 延迟：第一次 click 起定时器，200ms 内第二次 click 视为双击。
  // 200ms 是 macOS 默认的 NSEvent 双击阈值上限，体感正常。
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SINGLE_CLICK_DELAY = 200;

  // 任一区域 hover → 立即取消关闭计时 + 显示气泡
  useEffect(() => {
    const anyHover = spriteHover || bubbleHover;
    if (anyHover) {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setBubbleVisible(true);
    } else if (bubbleVisible) {
      // 离开后 300ms 才关闭，给鼠标"sprite ↔ 气泡"切换的缓冲
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setBubbleVisible(false);
      }, 300);
    }
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [spriteHover, bubbleHover, bubbleVisible]);

  // 拖拽中或卡片打开时强制隐藏气泡
  const showBubble = bubbleVisible && !cardOpen && !dragging;
  // 窗口需"独占鼠标事件"的条件：sprite/气泡正在被 hover、或卡片已打开
  // 关闭延迟（bubbleVisible 还为 true）期间仍设 forward 模式：透明区域穿透，
  // 但鼠标重新进入 sprite/气泡时 mouseenter 仍能触发（preload setIgnoreMouseEvents
  // 已带 forward:true）
  const hasUI = spriteHover || bubbleHover || cardOpen;

  // 根据是否有 UI 交互动态控制鼠标穿透
  // hasUI=true → 关闭穿透（窗口接收所有事件）
  // hasUI=false → 开启穿透（透明区域鼠标穿透到下方窗口）
  useEffect(() => {
    window.miniPi?.pet?.setIgnoreMouse?.(!hasUI);
  }, [hasUI]);

  // 组件挂载时开启穿透（默认 idle 状态）
  useEffect(() => {
    window.miniPi?.pet?.setIgnoreMouse?.(true);
    return () => {
      window.miniPi?.pet?.setIgnoreMouse?.(false);
      // 卸载时清理单击延迟定时器
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
    };
  }, []);

  // 宠物窗口失焦（用户点击其他窗口/桌面/App）→ 关卡片 + 关气泡
  // 双保险：BrowserWindow blur（来自 main 进程）+ window.blur（renderer 原生）
  // window.blur 在 setIgnoreMouse=false 期间可触发（窗口处于 key 状态时点击外部）
  useEffect(() => {
    const closeFloaters = () => {
      setCardOpen(false);
      setSpriteHover(false);
      setBubbleHover(false);
      setBubbleVisible(false);
    };
    const unsub = window.miniPi?.pet?.onWindowBlur?.(closeFloaters);
    window.addEventListener("blur", closeFloaters);
    return () => {
      unsub?.();
      window.removeEventListener("blur", closeFloaters);
    };
  }, []);

  // 订阅来自右键菜单的"切换 session"指令
  useEffect(() => {
    const unsub = window.miniPi?.pet?.onSwitchLocalSession?.((id) => {
      setLocalFocusId(id);
    });
    return unsub;
  }, [setLocalFocusId]);

  // 订阅来自右键菜单的"请求中止"指令 → 调 abort API
  useEffect(() => {
    const unsub = window.miniPi?.pet?.onRequestAbort?.(() => {
      const aid = displaySession?.agentId;
      if (!aid) return;
      void fetch(`/api/agent/${aid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
      }).catch((e) => console.warn("[pet] abort failed", e));
    });
    return unsub;
  }, [displaySession?.agentId]);

  // 触发 native 右键菜单
  // payload 含全部 agent session 名 + 当前 focused id，供"切换会话"子菜单展示
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const focusedId = localFocusId ?? petState?.focusedSessionId ?? null;
    const sessions = allSessions
      .filter((s) => s.agentId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        focused: s.id === focusedId,
      }));
    window.miniPi?.pet?.showContextMenu?.({
      hasSession: !!displaySession,
      streaming: !!displaySession?.streaming,
      sessions,
    });
  };

  return (
    // 整个窗口大小 320×400，透明，宠物 sprite 在右下角
    <div
      style={{
        position: "fixed",
        inset: 0,
        width: 320,
        height: 400,
        background: "transparent",
        overflow: "visible",
        pointerEvents: "none", // 默认不捕获事件，由子元素按需启用
      }}
    >
      {/* 事件 toast 堆叠 —— 在常态气泡上方，被动通告，不可交互
          拖拽时隐藏避免抖动；卡片打开时仍显示（错误信息不该被覆盖） */}
      {!dragging && <PetToastStack toasts={toasts} />}

      {/* hover 气泡 —— 在 sprite 上方，sprite 右侧对齐（拖拽时隐藏）
          鼠标在气泡上时也保持显示（粘性气泡） */}
      {showBubble && (
        <div
          onMouseEnter={() => setBubbleHover(true)}
          onMouseLeave={() => setBubbleHover(false)}
          style={{
            position: "absolute",
            right: 0,
            bottom: 120 + 8, // sprite 高度 + 间距
            pointerEvents: "auto",
          }}
        >
          <PetBubble animState={animState} bubbleText={bubbleText} />
        </div>
      )}

      {/* 操作卡片 —— 在 sprite 上方 */}
      {cardOpen && (
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 120 + 8,
            pointerEvents: "auto",
          }}
        >
          <PetCard
            session={displaySession}
            animState={animState}
            bubbleText={bubbleText}
            allSessions={allSessions}
            localFocusId={localFocusId}
            onClose={() => setCardOpen(false)}
            onFocusMain={() => {
              focusMain(displaySession?.id);
              setCardOpen(false);
            }}
            onSwitchLocalSession={(id) => setLocalFocusId(id)}
          />
        </div>
      )}

      {/* 宠物主体：固定在右下角，可拖拽 + hover + 点击 + 右键 */}
      <div
        ref={spriteRef}
        onMouseDown={onMouseDown}
        onMouseEnter={() => setSpriteHover(true)}
        onMouseLeave={() => setSpriteHover(false)}
        onContextMenu={handleContextMenu}
        onClick={() => {
          // 刚拖完一次的 click 应忽略（避免松手即弹卡片）
          if (wasJustDragged()) return;
          // 已有 pending 单击 → 当作双击处理
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
            // 双击：跳回主窗口，顺便关闭可能开着的卡片
            setCardOpen(false);
            focusMain(displaySession?.id);
            return;
          }
          // 起单击定时器，200ms 内若再次 click 视为双击
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            // 卡片已开 → 再次点击 sprite 关掉卡片（toggle）
            if (cardOpen) {
              setCardOpen(false);
              return;
            }
            setCardOpen(true);
            // 卡片打开后立即清空 hover 状态 + 让气泡关闭
            setSpriteHover(false);
            setBubbleHover(false);
            setBubbleVisible(false);
          }, SINGLE_CLICK_DELAY);
        }}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 100,
          height: 120,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "auto", // sprite 区域接收鼠标事件
        }}
        title="Diga Agent"
      >
        <PetSprite animState={animState} size={80} />
      </div>
    </div>
  );
}
