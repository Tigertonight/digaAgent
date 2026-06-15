"use client";

import { Loader2 } from "lucide-react";

interface SessionLoadingStateProps {
  title?: string | null;
}

export function SessionLoadingState({ title }: SessionLoadingStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-8">
      <div className="flex items-center gap-3 text-token-sm text-[color:var(--text-muted)]">
        <Loader2 size={16} className="animate-spin" />
        <span className="min-w-0 truncate">
          {title ? `Loading ${title}` : "Loading session"}
        </span>
      </div>
    </div>
  );
}
