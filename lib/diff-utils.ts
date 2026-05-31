/**
 * 轻量 unified diff —— 不依赖外部库（Myers 简化版 LCS）。
 *
 * 仅用于在 chat 消息里展示 Edit/Write 工具的 old/new 对比，
 * 行级 diff 即可，性能足够；对大文件兜底截断。
 */

export type DiffLine =
  | { kind: "ctx"; text: string; oldNo: number; newNo: number }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number };

/** 计算 a→b 的行级 LCS，返回 unified diff（带 3 行 context）。 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  contextLines = 3
): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // 大文件截断保护
  const MAX = 4000;
  if (a.length > MAX || b.length > MAX) {
    return [
      { kind: "del", text: `(${a.length} lines — too large to diff)`, oldNo: 0 },
      { kind: "add", text: `(${b.length} lines — too large to diff)`, newNo: 0 },
    ];
  }

  // LCS DP（O(m*n) 空间也 OK，<4000 行）
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ kind: "ctx", text: a[i], oldNo, newNo });
      i++;
      j++;
      oldNo++;
      newNo++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: "del", text: a[i], oldNo });
      i++;
      oldNo++;
    } else {
      raw.push({ kind: "add", text: b[j], newNo });
      j++;
      newNo++;
    }
  }
  while (i < m) {
    raw.push({ kind: "del", text: a[i], oldNo });
    i++;
    oldNo++;
  }
  while (j < n) {
    raw.push({ kind: "add", text: b[j], newNo });
    j++;
    newNo++;
  }

  // 折叠：留 contextLines 行 context，远处 ctx 折叠
  return collapseContext(raw, contextLines);
}

function collapseContext(lines: DiffLine[], n: number): DiffLine[] {
  // 找到所有 add/del 的 index
  const changedIdx = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind !== "ctx") changedIdx.add(idx);
  });
  if (changedIdx.size === 0) return lines;

  const keep = new Set<number>();
  for (const idx of changedIdx) {
    for (let k = Math.max(0, idx - n); k <= Math.min(lines.length - 1, idx + n); k++) {
      keep.add(k);
    }
  }

  const out: DiffLine[] = [];
  let lastKept = -2;
  for (let idx = 0; idx < lines.length; idx++) {
    if (!keep.has(idx)) continue;
    if (idx !== lastKept + 1 && out.length > 0) {
      // 折叠 gap 用一个空 hunk 分隔（用 ctx 占位）
      out.push({ kind: "ctx", text: "  …", oldNo: 0, newNo: 0 });
    }
    out.push(lines[idx]);
    lastKept = idx;
  }
  return out;
}

/** 判断两文本是否相同（trim 后） */
export function isNoChange(oldText: string, newText: string): boolean {
  return oldText === newText;
}
