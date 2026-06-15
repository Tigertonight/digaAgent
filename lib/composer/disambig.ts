/**
 * 文件同名 disambiguation helper（Composer F2）。
 *
 * 当 pendingFiles 里出现同 basename 的多条引用时，给每条计算"最少能区分它的
 * 父级路径片段"作为 chip 上的次要文本。例如：
 *
 *   /a/agent/[id]/route.ts
 *   /a/auth/login/route.ts
 *
 * 都叫 route.ts，会得到：
 *   route.ts · agent/[id]
 *   route.ts · auth/login
 *
 * 算法：
 *   - 把每条 path 拆成 segments（去掉 basename）
 *   - 对每个 basename group，从最末尾向前累加父目录直到与组里其他所有 path 区分开
 *
 * 输出：
 *   返回 Map<path, disambig>，仅给"有冲突"的 path 写值。无冲突 path 不在 map 里
 *   （UI 不显示次要文本）。
 */

export function computeDisambigByPath(
  paths: readonly string[]
): Map<string, string> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const basename = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx >= 0 ? p.slice(idx + 1) : p;
  };
  const parentSegs = (p: string): string[] => {
    const dir = p.slice(0, p.lastIndexOf("/"));
    return dir.split("/").filter(Boolean);
  };

  // 按 basename 分组
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const b = basename(p);
    const arr = byBase.get(b) ?? [];
    arr.push(p);
    byBase.set(b, arr);
  }

  for (const [, group] of byBase) {
    if (group.length < 2) continue; // 无冲突
    const segsByPath = new Map<string, string[]>();
    for (const p of group) segsByPath.set(p, parentSegs(p));

    // 对每条 path：从最末尾向前累加父级 segment，直到该 suffix 在组内唯一
    for (const p of group) {
      const segs = segsByPath.get(p) ?? [];
      // tail 计数 1 至 segs.length，逐步加长直到唯一
      let chosen = "";
      for (let take = 1; take <= segs.length; take += 1) {
        const tail = segs.slice(segs.length - take).join("/");
        let unique = true;
        for (const other of group) {
          if (other === p) continue;
          const oSegs = segsByPath.get(other) ?? [];
          const oTail = oSegs.slice(oSegs.length - take).join("/");
          if (oTail === tail) {
            unique = false;
            break;
          }
        }
        if (unique) {
          chosen = tail;
          break;
        }
      }
      if (!chosen && segs.length > 0) {
        // 极端：所有 segs 都相同，回退到完整父路径
        chosen = segs.join("/");
      }
      if (chosen) result.set(p, chosen);
    }
  }

  return result;
}
