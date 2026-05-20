// 從 data/trends/aliases.json 建立 ticker 對照 map。
// alias.json 原本是「中文 / raw 寫法 → canonical ticker」(供 LLM 寫錯時 normalize 用)。
//
// 這支檔案提供兩個方向的查詢：
//   - reverseMap：ticker → 中文公司名（給 trends 頁顯示 ticker 旁邊的中文名）
//     規則：只取 key 為純中文（CJK 統一漢字）的 entries，避免「台積電 ／ 2330.TW」
//     這種混合 key 反推；同一 ticker 有多個純中文 key 時取最短的（最 canonical）。
//   - forwardMap：中文 / 別名（trim 後）→ canonical ticker（給 resolveTicker 用，
//     讓 LLM 給的中文名 / 別名也能解析出代碼）。
//
// resolveTicker(raw) 統一把 LLM 給的原字串解析成 { code, name, display }，
// 規則比照 scripts/build-trends.mjs 的 normalizeTicker（代碼大寫化、4-6 數字補 .TW）。

import aliasesRaw from '../../data/trends/aliases.json';

const reverseMap: Record<string, string> = {};
const forwardMap: Record<string, string> = {};

for (const [k, v] of Object.entries(aliasesRaw as Record<string, string>)) {
  if (k.startsWith('_')) continue;
  if (typeof v !== 'string' || !v) continue;

  // forward：所有 alias key（trim 後）→ canonical ticker
  const key = k.trim();
  if (key) forwardMap[key] = v;

  // reverse：只取純中文 key，取最短者作 canonical 中文名
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

// 看起來像代碼的字串：開頭為英數，後接英數 / 點 / 連字號。
// 例：2330.TW、AAPL、6278.TWO、BRK-B。中文名不符此 pattern。
const CODE_RE = /^[0-9A-Za-z][0-9A-Za-z.\-]*$/;

/**
 * 比照 build-trends.mjs normalizeTicker 的代碼正規化（不含中文名分支）：
 *   - 已有 .TW / .HK / .TWO 等後綴 → 主體與後綴皆大寫
 *   - 純 4-6 位數字 → 補 .TW
 *   - 其餘英數（美股）→ 大寫
 */
function normalizeCode(raw: string): string {
  const s = raw.trim();
  // 後綴形式：1234.TW / 6278.TWO / 0700.HK / AAPL.US
  const suffixMatch = s.match(/^([0-9A-Za-z]+)\.([A-Za-z]+)$/);
  if (suffixMatch) {
    return `${suffixMatch[1].toUpperCase()}.${suffixMatch[2].toUpperCase()}`;
  }
  // 純 4-6 位數字 → 台股 → 補 .TW
  if (/^\d{4,6}$/.test(s)) {
    return `${s}.TW`;
  }
  // 其餘（美股代碼等）→ 大寫
  return s.toUpperCase();
}

export interface ResolvedTicker {
  /** canonical 代碼，解析不出時為 null（不加連結） */
  code: string | null;
  /** 中文公司名，無則空字串 */
  name: string;
  /** 顯示字串：「代碼（中文名）」或代碼或原 raw */
  display: string;
}

/**
 * 把 LLM 給的 ticker 原字串解析成 { code, name, display }。
 *
 * - raw 是代碼（符合 CODE_RE）→ code = normalizeCode(raw)、name = getChineseName(code)
 * - raw 是中文 / 別名 → 查 forwardMap 得 code、name = 該 code 的 canonical 中文名（無則用 raw）
 * - display：有 name 且 name ≠ code → `${code}（${name}）`；否則 code；都沒有則原 raw
 *
 * 例：
 *   resolveTicker('2330.TW') → { code: '2330.TW', name: '台積電', display: '2330.TW（台積電）' }
 *   resolveTicker('群聯')    → { code: '8299.TW', name: '群聯', display: '8299.TW（群聯）' }
 *   resolveTicker('某不明標的') → { code: null, name: '', display: '某不明標的' }
 */
export function resolveTicker(raw: string | undefined | null): ResolvedTicker {
  const original = (raw || '').trim();
  if (!original) return { code: null, name: '', display: '' };

  let code: string | null = null;
  let name = '';

  if (CODE_RE.test(original)) {
    // 像代碼：正規化後再查中文名
    code = normalizeCode(original);
    name = getChineseName(code);
  } else {
    // 像中文 / 別名：查 forward map 得代碼
    const mapped = forwardMap[original];
    if (mapped) {
      code = mapped;
      // canonical 中文名優先，否則沿用 raw
      name = getChineseName(code) || original;
    }
  }

  let display: string;
  if (code && name && name !== code) {
    display = `${code}（${name}）`;
  } else if (code) {
    display = code;
  } else {
    display = original;
  }

  return { code, name, display };
}
