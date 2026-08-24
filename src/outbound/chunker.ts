/**
 * 长文本分块（M2：8000 字符，代码块/表格不切断）
 *
 * 长文本分块策略（块间 2s 延迟由发送层控制）。
 */

export const MAX_CHUNK_LEN = 8000;

/** 将长文本切成 ≤8000 字符的块；优先在换行/代码块边界切，不切断代码块/表格 */
export function chunkText(text: string, maxLen: number = MAX_CHUNK_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const cut = findCutPoint(rest, maxLen);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** 在 maxLen 内找安全切点（优先 ```代码块边界 > 换行 > 表格行 > 空格 > 硬切） */
function findCutPoint(text: string, maxLen: number): number {
  const window = text.slice(0, maxLen);
  // 1) 未闭合代码块：切到语言标记后的换行（```ts\n）或 ``` 后
  const fenceMatches = [...window.matchAll(/```/g)];
  if (fenceMatches.length % 2 === 1) {
    const lastFence = fenceMatches[fenceMatches.length - 1];
    const after = lastFence.index! + 3;
    const langNl = window.indexOf("\n", after);
    if (langNl > 0 && langNl < maxLen) return langNl + 1; // ```ts\n 结束处
    if (after < maxLen) return after;
  }
  // 2) 表格行：切在最后一个完整行（| 开头行结束处）
  const tableLineEnd = window.lastIndexOf("\n|");
  if (tableLineEnd > maxLen * 0.5) {
    const lineBreak = window.indexOf("\n", tableLineEnd);
    if (lineBreak > 0) return lineBreak;
  }
  // 3) 最后一个换行
  const nl = window.lastIndexOf("\n");
  if (nl > maxLen * 0.5) return nl + 1;
  // 4) 最后一个空格
  const sp = window.lastIndexOf(" ");
  if (sp > maxLen * 0.5) return sp + 1;
  // 5) 硬切
  return maxLen;
}
