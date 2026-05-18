// Build trends aggregation: per-ticker / per-sector mention statistics across all reports.
// Reads data/reports/*.json, writes data/trends/tickers.json and data/trends/sectors.json.
// Pure build-time script — defensive against missing fields and old (string) keyInsights format.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const REPORTS_DIR = join(process.cwd(), 'data', 'reports');
const TRENDS_DIR = join(process.cwd(), 'data', 'trends');
const TICKERS_OUT = join(TRENDS_DIR, 'tickers.json');
const SECTORS_OUT = join(TRENDS_DIR, 'sectors.json');
const ALIASES_PATH = join(TRENDS_DIR, 'aliases.json');

// ── helpers ────────────────────────────────────────────────────────────────

// Alias map (raw / normalized ticker string → canonical ticker).
// Loaded once at startup; keys prefixed with `_` are ignored (used for comments).
let TICKER_ALIASES = {};
async function loadAliases() {
  try {
    const raw = await readFile(ALIASES_PATH, 'utf8');
    const obj = JSON.parse(raw);
    const cleaned = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      if (typeof v !== 'string' || !v) continue;
      cleaned[k] = v;
    }
    TICKER_ALIASES = cleaned;
  } catch {
    TICKER_ALIASES = {};
  }
}

function applyAlias(key) {
  if (key && Object.prototype.hasOwnProperty.call(TICKER_ALIASES, key)) {
    return TICKER_ALIASES[key];
  }
  return null;
}

/**
 * Normalize ticker symbol.
 * - Pure 4-digit numeric → append `.TW` (台股)
 * - `2330.tw` / `2330.TW` → `2330.TW`
 * - `0700.hk` / `0700.HK` → `0700.HK`
 * - US tickers (letters) → uppercase
 * - Chinese names (中文) → keep as-is (no transformation)
 * - Strip parenthetical notes like `SNDK（短線）` → `SNDK`
 */
function normalizeTicker(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // Alias lookup #1: raw trimmed string (covers LLM outputs like
  // `台積電`、`聯發科 ／ 2454.TW`、`鴻海 ／ 2301.TW` 寫錯 ticker 等)
  const aliasFromRaw = applyAlias(s);
  if (aliasFromRaw) return aliasFromRaw;

  // Strip Chinese parenthetical hints: `SNDK（短線）` → `SNDK`, `3363.TW (上銓)` → `3363.TW`
  s = s.replace(/[（(].*?[)）]/g, '').trim();
  if (!s) return null;

  // Already has .TW / .HK suffix
  const suffixMatch = s.match(/^([0-9A-Za-z]+)\.(tw|hk)$/i);
  if (suffixMatch) {
    const out = `${suffixMatch[1].toUpperCase()}.${suffixMatch[2].toUpperCase()}`;
    return applyAlias(out) || out;
  }

  // Pure 4-digit numeric → 台股 → append .TW
  if (/^\d{4}$/.test(s)) {
    const out = `${s}.TW`;
    return applyAlias(out) || out;
  }

  // Pure alphabetic / alphanumeric (likely US ticker) → uppercase
  if (/^[A-Za-z][A-Za-z0-9.\-]*$/.test(s)) {
    const out = s.toUpperCase();
    return applyAlias(out) || out;
  }

  // Otherwise (likely Chinese name) → return trimmed original
  // 把 `/` 與 `\` 換成全形版本，避免 URL segment 中斷
  s = s.replace(/\//g, '／').replace(/\\/g, '＼');
  return applyAlias(s) || s;
}

/**
 * Normalize sector string. Trim, collapse whitespace, and replace path-breaking
 * characters (forward slash) with the full-width variant so the value is safe
 * to use in a URL segment.
 */
function normalizeSector(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // 把 `/` 換成全形 `／`，避免 URL segment 中斷
  s = s.replace(/\//g, '／');
  // 同樣處理反斜線
  s = s.replace(/\\/g, '＼');
  return s;
}

/**
 * Compute weighted sentiment delta for a single mention.
 *   bullish: +1, bearish: -1, monitor: 0
 *   confidence multiplier: high ×1.5, medium ×1.0, low ×0.5
 *   consensus multiplier: 共識 ×2, 分歧 ×0.5, default ×1
 */
function computeWeight(signalType, confidence, consensus) {
  let base = 0;
  if (signalType === 'bullish') base = 1;
  else if (signalType === 'bearish') base = -1;
  else base = 0;

  let cMul = 1.0;
  if (confidence === 'high') cMul = 1.5;
  else if (confidence === 'low') cMul = 0.5;

  let conMul = 1.0;
  if (typeof consensus === 'string') {
    if (consensus.includes('共識')) conMul = 2.0;
    else if (consensus.includes('分歧')) conMul = 0.5;
  }

  return base * cMul * conMul;
}

/**
 * Returns days between date string YYYY-MM-DD and `today` (also YYYY-MM-DD).
 * Negative or NaN → treat as Infinity (out of all windows except all).
 */
function daysAgo(dateStr, todayStr) {
  if (!dateStr || !todayStr) return Infinity;
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  const t = new Date(`${todayStr}T00:00:00+08:00`);
  if (isNaN(d.getTime()) || isNaN(t.getTime())) return Infinity;
  const diff = (t.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  return diff;
}

/**
 * Increment mention counters across windows.
 */
function incMentions(obj, age) {
  obj.all = (obj.all || 0) + 1;
  if (age <= 7) obj['7d'] = (obj['7d'] || 0) + 1;
  if (age <= 30) obj['30d'] = (obj['30d'] || 0) + 1;
  if (age <= 90) obj['90d'] = (obj['90d'] || 0) + 1;
}

/**
 * Increment sentiment score across windows.
 */
function incScore(obj, age, w) {
  obj.all = (obj.all || 0) + w;
  if (age <= 7) obj['7d'] = (obj['7d'] || 0) + w;
  if (age <= 30) obj['30d'] = (obj['30d'] || 0) + w;
  if (age <= 90) obj['90d'] = (obj['90d'] || 0) + w;
}

// ── main ───────────────────────────────────────────────────────────────────

async function buildTrends() {
  await loadAliases();
  let files;
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    console.log('No reports directory found, writing empty trends.');
    await mkdir(TRENDS_DIR, { recursive: true });
    await writeFile(TICKERS_OUT, '[]', 'utf-8');
    await writeFile(SECTORS_OUT, '[]', 'utf-8');
    return;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

  // Build list of reports with date — use the latest report's date as "today" so
  // the 7d / 30d / 90d windows are stable in the static build and don't depend on
  // when the build runs.
  const reports = [];
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(REPORTS_DIR, file), 'utf-8');
      const data = JSON.parse(raw);
      reports.push({
        file,
        date: data.date || file.replace('.json', ''),
        data,
      });
    } catch (e) {
      console.warn(`Skipping ${file}: ${e.message}`);
    }
  }

  if (reports.length === 0) {
    console.log('No valid reports found.');
    await mkdir(TRENDS_DIR, { recursive: true });
    await writeFile(TICKERS_OUT, '[]', 'utf-8');
    await writeFile(SECTORS_OUT, '[]', 'utf-8');
    return;
  }

  // "Today" anchored to the newest report date
  const todayStr = reports.map(r => r.date).sort().slice(-1)[0];

  // ticker symbol → aggregate
  const tickerMap = new Map();
  // sector → aggregate
  const sectorMap = new Map();

  function getTickerAgg(symbol) {
    if (!tickerMap.has(symbol)) {
      tickerMap.set(symbol, {
        symbol,
        mentions: { '7d': 0, '30d': 0, '90d': 0, all: 0 },
        sentimentScore: { '7d': 0, '30d': 0, '90d': 0, all: 0 },
        mentionedBy: new Set(),
        sectors: new Set(),
        timeline: [],
      });
    }
    return tickerMap.get(symbol);
  }

  function getSectorAgg(name) {
    if (!sectorMap.has(name)) {
      sectorMap.set(name, {
        sector: name,
        mentions: { '7d': 0, '30d': 0, '90d': 0, all: 0 },
        sentimentScore: { '7d': 0, '30d': 0, '90d': 0, all: 0 },
        mentionedBy: new Set(),
        tickers: new Set(),
        timeline: [],
      });
    }
    return sectorMap.get(name);
  }

  // Walk every report
  for (const { data, date } of reports) {
    const age = daysAgo(date, todayStr);

    // ── bullish / bearish signals (object array with sources) ──
    for (const [type, signals] of [
      ['bullish', data.bullishSignals || []],
      ['bearish', data.bearishSignals || []],
    ]) {
      for (const sig of signals) {
        if (!sig || typeof sig !== 'object') continue;
        const symbol = normalizeTicker(sig.ticker);
        if (!symbol) continue;

        const agg = getTickerAgg(symbol);
        const sources = Array.isArray(sig.sources) ? sig.sources : [];

        // each source counts as one mention (one KOL voicing the view)
        for (const src of sources) {
          if (!src || typeof src !== 'object') continue;
          const kol = src.kol || '(unknown)';
          const confidence = src.confidence || sig.overallConfidence || 'medium';
          const w = computeWeight(type, confidence, sig.consensus);

          incMentions(agg.mentions, age);
          incScore(agg.sentimentScore, age, w);
          agg.mentionedBy.add(kol);

          agg.timeline.push({
            date,
            signal_type: type,
            confidence,
            kol,
            reason: src.reason || '',
            consensus: sig.consensus || '',
            timeHorizon: sig.timeHorizon || '',
            weight: w,
          });
        }

        // if no sources, still count the signal as 1 mention (defensive)
        if (sources.length === 0) {
          const w = computeWeight(type, sig.overallConfidence || 'medium', sig.consensus);
          incMentions(agg.mentions, age);
          incScore(agg.sentimentScore, age, w);
          agg.timeline.push({
            date,
            signal_type: type,
            confidence: sig.overallConfidence || 'medium',
            kol: '',
            reason: '',
            consensus: sig.consensus || '',
            timeHorizon: sig.timeHorizon || '',
            weight: w,
          });
        }
      }
    }

    // ── monitor signals (topic-based, treated as sector-like + zero sentiment) ──
    for (const sig of (data.monitorSignals || [])) {
      if (!sig || typeof sig !== 'object') continue;
      const topic = normalizeSector(sig.topic);
      if (!topic) continue;
      const agg = getSectorAgg(topic);
      const mentionedBy = Array.isArray(sig.mentionedBy) ? sig.mentionedBy : [];
      // one mention per report (group-level), but each KOL voice counts toward mentions
      const voiceCount = Math.max(mentionedBy.length, 1);
      for (let i = 0; i < voiceCount; i++) {
        incMentions(agg.mentions, age);
        // monitor is neutral → 0
        incScore(agg.sentimentScore, age, 0);
      }
      mentionedBy.forEach(k => agg.mentionedBy.add(k));
      agg.timeline.push({
        date,
        signal_type: 'monitor',
        confidence: '',
        kol: mentionedBy.join('、'),
        reason: sig.reason || '',
        consensus: '',
        timeHorizon: sig.timeHorizon || '',
        weight: 0,
      });
    }

    // ── keyInsights: sector aggregation (兼容 string 與 object 兩種格式) ──
    for (const ins of (data.keyInsights || [])) {
      if (!ins) continue;
      if (typeof ins === 'string') {
        // 舊格式：無 sector / source，無法歸類 → 跳過
        continue;
      }
      if (typeof ins !== 'object') continue;
      const sector = normalizeSector(ins.sector);
      if (!sector) continue;

      const agg = getSectorAgg(sector);
      const sources = Array.isArray(ins.source) ? ins.source : (ins.source ? [ins.source] : []);

      const voiceCount = Math.max(sources.length, 1);
      for (let i = 0; i < voiceCount; i++) {
        incMentions(agg.mentions, age);
        // keyInsights 視為中性觀察 → 0 分（情緒由 ticker bullish/bearish 統計）
        incScore(agg.sentimentScore, age, 0);
      }
      sources.forEach(s => { if (s) agg.mentionedBy.add(s); });
      agg.timeline.push({
        date,
        signal_type: 'monitor',
        confidence: '',
        kol: sources.join('、'),
        reason: ins.insight || '',
        consensus: '',
        timeHorizon: ins.timeHorizon || '',
        weight: 0,
      });
    }
  }

  // ── cross-link tickers ↔ sectors (從 keyInsights 找到 ticker—sector 關聯) ──
  for (const { data } of reports) {
    for (const ins of (data.keyInsights || [])) {
      if (!ins || typeof ins !== 'object') continue;
      const sector = normalizeSector(ins.sector);
      if (!sector) continue;
      // keyInsights 沒有直接帶 ticker，無法 cross-link，跳過
    }
    // bullishSignals / bearishSignals 沒有 sector 欄位（依目前 schema），無法直接 link
    // 留作未來擴充。
  }

  // ── serialize ──
  const tickerArr = Array.from(tickerMap.values())
    .map(t => ({
      symbol: t.symbol,
      mentions: t.mentions,
      sentimentScore: {
        '7d': round2(t.sentimentScore['7d']),
        '30d': round2(t.sentimentScore['30d']),
        '90d': round2(t.sentimentScore['90d']),
        all: round2(t.sentimentScore.all),
      },
      mentionedBy: Array.from(t.mentionedBy).sort(),
      timeline: t.timeline.sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => b.mentions.all - a.mentions.all);

  const sectorArr = Array.from(sectorMap.values())
    .map(s => ({
      sector: s.sector,
      mentions: s.mentions,
      sentimentScore: {
        '7d': round2(s.sentimentScore['7d']),
        '30d': round2(s.sentimentScore['30d']),
        '90d': round2(s.sentimentScore['90d']),
        all: round2(s.sentimentScore.all),
      },
      mentionedBy: Array.from(s.mentionedBy).sort(),
      timeline: s.timeline.sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => b.mentions.all - a.mentions.all);

  await mkdir(TRENDS_DIR, { recursive: true });
  await writeFile(TICKERS_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    anchorDate: todayStr,
    count: tickerArr.length,
    tickers: tickerArr,
  }, null, 2), 'utf-8');
  await writeFile(SECTORS_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    anchorDate: todayStr,
    count: sectorArr.length,
    sectors: sectorArr,
  }, null, 2), 'utf-8');

  console.log(`Trends built: ${tickerArr.length} tickers, ${sectorArr.length} sectors (anchor: ${todayStr}).`);
}

function round2(n) {
  if (typeof n !== 'number' || isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

buildTrends().catch(err => {
  console.error('build-trends failed:', err);
  process.exit(1);
});
