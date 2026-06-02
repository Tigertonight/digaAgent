"use client";

import type { MouseEventHandler, Dispatch, SetStateAction } from "react";
import FileBrowser from "./FileBrowser";

export interface FilesLayout {
  treeCollapsed: boolean;
  viewerHidden: boolean;
}

interface RightPanelContainerProps {
  show: boolean;
  cwd: string;
  filesContainerWidth: number;
  filesLayout: FilesLayout;
  onSplitterMouseDown: MouseEventHandler<HTMLDivElement>;
  onClose: () => void;
  onPickPath: (absPath: string) => void;
  onLayoutChange: Dispatch<SetStateAction<FilesLayout>>;
}

export function RightPanelContainer({
  show,
  cwd,
  filesContainerWidth,
  filesLayout,
  onSplitterMouseDown,
  onClose,
  onPickPath,
  onLayoutChange,
}: RightPanelContainerProps) {
  if (!show) return null;
  return (
    <>
      <div
        onMouseDown={onSplitterMouseDown}
        title="拖动调整宽度"
        style={{
          width: 4,
          cursor: "ew-resize",
          background: "var(--border-soft)",
          flexShrink: 0,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--border-soft)";
        }}
      />
      <div
        style={{
          // 用 flex-basis 表达"想要的宽度",允许 shrink:窗口窄时压到 minWidth
          flex: `0 1 ${filesContainerWidth}px`,
          minWidth: filesLayout.viewerHidden && filesLayout.treeCollapsed ? 56 : 200,
          maxWidth: "80vw",
          transition: "flex-basis 0.16s ease",
        }}
      >
        <FileBrowser
          initialPath={cwd || "/"}
          onClose={onClose}
          onPickPath={onPickPath}
          onLayoutChange={onLayoutChange}
        />
      </div>
    </>
  );
}
