/**
 * 合并连续重复的工具叙事：连续 3 个“正在查看 a.ts、b.ts、c.ts” 合为
 * “正在查看 3 个项目”。只看动词前缀（“正在查看/查询/写入/...”）是否一致；
 * 一致且达到 3 条才压缩，避免路过交互。
 */
export function dedupeToolLabels(labels: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < labels.length) {
    const head = labels[i];
    const verb = leadingVerb(head);
    let j = i + 1;
    while (j < labels.length && leadingVerb(labels[j]) === verb && verb) j += 1;
    const span = j - i;
    if (verb && span >= 3) {
      out.push(`${verb} ${span} 个项目`);
      i = j;
    } else {
      out.push(head);
      i += 1;
    }
  }
  return out;
}

export function leadingVerb(label: string): string {
  const m = label.match(/^(正在[\u4e00-\u9fa5]{1,4})/);
  return m ? m[1] : "";
}
