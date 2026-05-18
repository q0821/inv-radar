// Build technicals: 對 data/trends/tickers.json 中近 30 天有提及的 ticker，
// 透過 Yahoo Finance unofficial chart API 撈日 K 線，計算技術指標並輸出
// data/trends/technicals.json，供 ticker 詳情頁 SSR 使用。
//
// 無外部 dependency（Node 18+ 內建 fetch）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TRENDS_DIR = join(process.cwd(), 'data', 'trends');
const TICKERS_IN = join(TRENDS_DIR, 'tickers.json');
const TECHNICALS_OUT = join(TRENDS_DIR, 'technicals.json');

const YAHOO_API = (symbol) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=4mo`;

const REQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; inv-radar/1.0)',
  Accept: 'application/json,text/plain,*/*',
};

const REQ_TIMEOUT_MS = 8000;
const RATE_LIMIT_MS = 350;
const TICKER_RE = /^[A-Z0-9.\-]+$/;

// ── utils ──────────────────────────────────────────────────────────────────

function hasCJK(s) {
  return /[　-〿㐀-䶿一-鿿豈-﫿]/.test(s);
}

function isLikelyTicker(s) {
  if (!s || typeof s !== 'string') return false;
  if (hasCJK(s)) return false;
  return TICKER_RE.test(s.trim());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0;
  let n = 0;
  for (const v of arr) {
    if (typeof v === 'number' && !isNaN(v)) {
      s += v;
      n++;
    }
  }
  return n === 0 ? null : s / n;
}

function round(n, digits = 2) {
  if (typeof n !== 'number' || isNaN(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// ── fetch with timeout + retry ────────────────────────────────────────────

async function fetchYahoo(symbol) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetch(YAHOO_API(symbol), {
        headers: REQ_HEADERS,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        // 4xx 不重試（symbol 不存在等）
        if (res.status >= 400 && res.status < 500) throw lastErr;
        continue;
      }
      const json = await res.json();
      return json;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e && e.name === 'AbortError') {
        lastErr = new Error('timeout');
      }
      // 重試一次
    }
  }
  throw lastErr || new Error('fetch failed');
}

// ── 指標計算 ───────────────────────────────────────────────────────────────

function maAt(closes, n, endIdx) {
  // 計算到 endIdx (inclusive) 為止的最近 n 日 MA
  if (endIdx < n - 1) return null;
  const slice = closes.slice(endIdx - n + 1, endIdx + 1);
  return avg(slice);
}

function lastValidClosesAndVolumes(timestamps, closes, volumes) {
  // 去掉 close 為 null 的 row（Yahoo 偶爾會留 null 在最新一筆未收盤）
  const tsOut = [];
  const closesOut = [];
  const volsOut = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (typeof c !== 'number' || isNaN(c)) continue;
    tsOut.push(timestamps[i]);
    closesOut.push(c);
    volsOut.push(typeof volumes[i] === 'number' ? volumes[i] : 0);
  }
  return { ts: tsOut, closes: closesOut, vols: volsOut };
}

function calcRSI14(closes) {
  // Wilder RSI 14：用最後 15 筆計算
  if (closes.length < 15) return null;
  const period = 14;
  // 第一段 SMA gain/loss
  let gainSum = 0;
  let lossSum = 0;
  const startIdx = closes.length - period - 1;
  for (let i = startIdx + 1; i <= startIdx + period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  // Wilder smoothing — 我們已經用最後 14 個 diff 算出 avgGain/avgLoss，
  // 已經是最後一筆 RSI 對應的值
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function detectCross5_20(closes) {
  // 對最後 10 個交易日逐日算 ma5 / ma20，找 ma5 vs ma20 的 cross
  if (closes.length < 20 + 1) return { type: 'none', daysAgo: null };
  const lookback = Math.min(10, closes.length - 20);
  // 算出每一天的 ma5 - ma20
  const diffs = [];
  for (let off = lookback; off >= 0; off--) {
    const endIdx = closes.length - 1 - off;
    const ma5 = maAt(closes, 5, endIdx);
    const ma20 = maAt(closes, 20, endIdx);
    if (ma5 == null || ma20 == null) {
      diffs.push(null);
      continue;
    }
    diffs.push(ma5 - ma20);
  }
  // diffs[i] 對應「offset = lookback - i 天前」
  // 找最近一次 sign change（從 i=0 → 最後）
  let crossAtIdx = -1;
  let crossType = 'none';
  for (let i = 1; i < diffs.length; i++) {
    const a = diffs[i - 1];
    const b = diffs[i];
    if (a == null || b == null) continue;
    if (a < 0 && b >= 0) {
      crossAtIdx = i;
      crossType = 'golden';
    } else if (a > 0 && b <= 0) {
      crossAtIdx = i;
      crossType = 'death';
    }
  }
  if (crossAtIdx === -1) return { type: 'none', daysAgo: null };
  // diffs[crossAtIdx] 對應的 daysAgo
  const daysAgo = lookback - crossAtIdx;
  return { type: crossType, daysAgo };
}

function detectPriceVolumeRelation(closes, vols) {
  // 比較最近 5 個交易日的 price change% vs volume change%（與前 5 日平均比）
  if (closes.length < 11 || vols.length < 11) return 'neutral';
  const last5Close = closes.slice(-5);
  const prev5Close = closes.slice(-10, -5);
  const last5Vol = vols.slice(-5);
  const prev5Vol = vols.slice(-10, -5);

  const lastPriceAvg = avg(last5Close);
  const prevPriceAvg = avg(prev5Close);
  const lastVolAvg = avg(last5Vol);
  const prevVolAvg = avg(prev5Vol);

  if (
    lastPriceAvg == null ||
    prevPriceAvg == null ||
    lastVolAvg == null ||
    prevVolAvg == null ||
    prevPriceAvg === 0 ||
    prevVolAvg === 0
  ) {
    return 'neutral';
  }

  const priceChangePct = ((lastPriceAvg - prevPriceAvg) / prevPriceAvg) * 100;
  const volChangePct = ((lastVolAvg - prevVolAvg) / prevVolAvg) * 100;

  // thresholds: 價格 ±1%、量 ±10%
  const priceUp = priceChangePct > 1;
  const priceDown = priceChangePct < -1;
  const volUp = volChangePct > 10;
  const volDown = volChangePct < -10;

  if ((priceUp && volUp) || (priceDown && volDown)) return 'sync';
  if (priceUp && volDown) return 'divergence_up_low_vol';
  if (priceDown && volUp) return 'divergence_down_high_vol';
  return 'neutral';
}

function calcVerdict(t) {
  const tags = [];
  if (
    typeof t.priceVsMa60Pct === 'number' &&
    typeof t.ma20Slope5dPct === 'number' &&
    t.priceVsMa60Pct > 0 &&
    t.ma20Slope5dPct > 0
  ) {
    tags.push('中長線偏多');
  }
  if (
    typeof t.priceVsMa60Pct === 'number' &&
    typeof t.ma20Slope5dPct === 'number' &&
    t.priceVsMa60Pct < 0 &&
    t.ma20Slope5dPct < 0
  ) {
    tags.push('中長線偏空');
  }
  if (
    t.cross5_20 &&
    t.cross5_20.type === 'golden' &&
    typeof t.cross5_20.daysAgo === 'number' &&
    t.cross5_20.daysAgo <= 10
  ) {
    tags.push('短線轉強');
  }
  if (
    t.cross5_20 &&
    t.cross5_20.type === 'death' &&
    typeof t.cross5_20.daysAgo === 'number' &&
    t.cross5_20.daysAgo <= 10
  ) {
    tags.push('短線轉弱');
  }
  if (typeof t.rsi14 === 'number' && t.rsi14 > 70) tags.push('過熱');
  if (typeof t.rsi14 === 'number' && t.rsi14 < 30) tags.push('超賣');
  if (
    t.priceVolumeRelation === 'divergence_up_low_vol' ||
    t.priceVolumeRelation === 'divergence_down_high_vol'
  ) {
    tags.push('量價背離警訊');
  }
  return tags;
}

function computeIndicators(json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error('no result');
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const ind = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const rawCloses = ind.close || [];
  const rawVols = ind.volume || [];
  if (!Array.isArray(rawCloses) || rawCloses.length === 0) throw new Error('no closes');

  const { closes, vols } = lastValidClosesAndVolumes(timestamps, rawCloses, rawVols);
  if (closes.length < 21) throw new Error('not enough data');

  const lastIdx = closes.length - 1;
  const currentPrice = closes[lastIdx];
  const prevClose = closes[lastIdx - 1];
  const changePct1d = prevClose ? ((currentPrice - prevClose) / prevClose) * 100 : null;

  const ma5 = maAt(closes, 5, lastIdx);
  const ma20 = maAt(closes, 20, lastIdx);
  const ma60 = closes.length >= 60 ? maAt(closes, 60, lastIdx) : null;

  const priceVsMa20Pct = ma20 ? ((currentPrice - ma20) / ma20) * 100 : null;
  const priceVsMa60Pct = ma60 ? ((currentPrice - ma60) / ma60) * 100 : null;

  // MA20 slope: 跟 5 日前的 MA20 比
  let ma20Slope5dPct = null;
  if (closes.length >= 25) {
    const ma20Past = maAt(closes, 20, lastIdx - 5);
    if (ma20 != null && ma20Past != null && ma20Past !== 0) {
      ma20Slope5dPct = ((ma20 - ma20Past) / ma20Past) * 100;
    }
  }

  const cross5_20 = detectCross5_20(closes);
  const rsi14 = calcRSI14(closes);

  const changePct5d =
    closes.length > 5 ? ((currentPrice - closes[lastIdx - 5]) / closes[lastIdx - 5]) * 100 : null;
  const changePct20d =
    closes.length > 20
      ? ((currentPrice - closes[lastIdx - 20]) / closes[lastIdx - 20]) * 100
      : null;

  // volumeRatio: lastVolume / avg(last 20 volumes, 不含最新)
  let volumeRatio = null;
  if (vols.length >= 21) {
    const lastVol = vols[lastIdx];
    const vol20 = avg(vols.slice(lastIdx - 20, lastIdx));
    if (vol20 && vol20 > 0) volumeRatio = lastVol / vol20;
  }

  const priceVolumeRelation = detectPriceVolumeRelation(closes, vols);

  const out = {
    currentPrice: round(currentPrice, 4),
    currency: meta.currency || null,
    prevClose: round(prevClose, 4),
    changePct1d: round(changePct1d, 2),
    ma5: round(ma5, 4),
    ma20: round(ma20, 4),
    ma60: round(ma60, 4),
    priceVsMa20Pct: round(priceVsMa20Pct, 2),
    priceVsMa60Pct: round(priceVsMa60Pct, 2),
    ma20Slope5dPct: round(ma20Slope5dPct, 2),
    cross5_20,
    rsi14: round(rsi14, 1),
    changePct5d: round(changePct5d, 2),
    changePct20d: round(changePct20d, 2),
    volumeRatio: round(volumeRatio, 1),
    priceVolumeRelation,
  };
  out.verdict = calcVerdict(out);
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const startTs = Date.now();
  const raw = await readFile(TICKERS_IN, 'utf8');
  const tickersData = JSON.parse(raw);
  const anchorDate = tickersData.anchorDate || '';
  const list = Array.isArray(tickersData.tickers) ? tickersData.tickers : [];

  // 過濾條件：近 30 天有提及 + 是 ticker shape
  const candidates = [];
  const skippedCNNames = [];
  for (const t of list) {
    const symbol = t && t.symbol;
    if (!symbol) continue;
    if (!t.mentions || (t.mentions['30d'] || 0) <= 0) continue;
    if (!isLikelyTicker(symbol)) {
      skippedCNNames.push(symbol);
      continue;
    }
    candidates.push(symbol);
  }

  console.log(`[technicals] ${candidates.length} candidates, ${skippedCNNames.length} skipped (CJK / non-ticker shape)`);

  const tickersOut = {};
  const errors = [];
  let successCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const symbol = candidates[i];
    try {
      const json = await fetchYahoo(symbol);
      const indicators = computeIndicators(json);
      tickersOut[symbol] = indicators;
      successCount++;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      errors.push(`${symbol}: ${msg}`);
    }
    // rate limit (除最後一筆)
    if (i < candidates.length - 1) await sleep(RATE_LIMIT_MS);
    // 進度
    if ((i + 1) % 10 === 0) {
      console.log(`[technicals] ${i + 1}/${candidates.length} processed, ${successCount} OK, ${errors.length} errors`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    anchorDate,
    count: successCount,
    skippedCount: skippedCNNames.length + (candidates.length - successCount),
    errors,
    tickers: tickersOut,
  };

  await mkdir(TRENDS_DIR, { recursive: true });
  await writeFile(TECHNICALS_OUT, JSON.stringify(out, null, 2), 'utf8');

  const took = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(
    `[technicals] done. ${successCount} tickers, ${errors.length} errors, took ${took}s. → ${TECHNICALS_OUT}`
  );
  if (errors.length > 0) {
    console.log(`[technicals] first errors: ${errors.slice(0, 5).join(' | ')}`);
  }
}

main().catch((e) => {
  console.error('[technicals] fatal:', e);
  process.exit(1);
});
