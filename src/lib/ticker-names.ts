// 從 data/trends/aliases.json 反向 build ticker → 中文公司名 map。
// alias.json 原本是「中文 → ticker」(供 LLM 寫錯時 normalize 用)，反過來可以
// 給 trends 頁顯示 ticker 旁邊的中文名稱。
//
// 規則：
//   - 只取 key 為純中文（CJK 統一漢字）的 entries，避免 「台積電 ／ 2330.TW」這種
//     混合 key 反推
//   - 同一 ticker 有多個純中文 key 時，取最短的（最 canonical）

import aliasesRaw from '../../data/trends/aliases.json';

const reverseMap: Record<string, string> = {};

for (const [k, v] of Object.entries(aliasesRaw as Record<string, string>)) {
  if (k.startsWith('_')) continue;
  if (typeof v !== 'string' || !v) continue;
  if (!/^[一-鿿]+$/.test(k)) continue;
  if (!reverseMap[v] || k.length < reverseMap[v].length) {
    reverseMap[v] = k;
  }
}

/**
 * 取得 ticker 對應的中文公司名，若無對照回空字串。
 * 例：getChineseName('2330.TW') → '台積電'
 */
export function getChineseName(ticker: string | undefined | null): string {
  if (!ticker) return '';
  return reverseMap[ticker] || '';
}
