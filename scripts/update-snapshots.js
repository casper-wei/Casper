const fs = require('node:fs/promises');
const path = require('node:path');

const TWSE_URL = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
const YAHOO_URL = 'https://query2.finance.yahoo.com/v8/finance/chart';
const DAILY_SCAN_LIMIT = Number(process.env.DAILY_SCAN_LIMIT || 160);
const CONCURRENCY = Number(process.env.SNAPSHOT_CONCURRENCY || 8);

function todayText() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function numberValue(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace(/,/g, '').replace(/[+ ]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function calcMA(values, days, end = values.length) {
  if (end < days) return null;
  return avg(values.slice(end - days, end));
}

function maxOf(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : 0;
}

function minOf(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? Math.min(...valid) : 0;
}

async function fetchText(url, timeoutMs = 30000, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'CasperSnapshotBot/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    }
  }
  throw lastError;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function normalizeTwsePayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const data = lines.slice(1).map(parseCsvLine)
    .filter(row => row.length >= 11)
    .map(row => [row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10]]);
  return { data };
}

function parseTwse(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(row => ({
    code: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    suffix: '.TW',
    market: '上市',
    open: numberValue(row[4]),
    high: numberValue(row[5]),
    low: numberValue(row[6]),
    close: numberValue(row[7]),
    volume: Math.round(numberValue(row[2]) / 1000),
  })).filter(stock => /^[1-9]\d{3}$/.test(stock.code) && stock.close > 0);
}

function parseTpex(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data || []);
  return rows.map(row => ({
    code: String(row.SecuritiesCompanyCode || row.Code || '').trim(),
    name: String(row.CompanyName || row.Name || '').trim(),
    suffix: '.TWO',
    market: '上櫃',
    open: numberValue(row.OpeningPrice || row.Open),
    high: numberValue(row.HighestPrice || row.High),
    low: numberValue(row.LowestPrice || row.Low),
    close: numberValue(row.ClosingPrice || row.Close),
    volume: Math.round(numberValue(row.TradingShares || row.TradeVolume) / 1000),
  })).filter(stock => /^[1-9]\d{3}$/.test(stock.code) && stock.close > 0);
}

function normalizeYahooBars(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((ts, index) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] ? quote.volume[index] / 1000 : 0,
  })).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
}

async function fetchHistory(stock, range = '6mo') {
  const ticker = `${stock.code}${stock.suffix}`;
  const url = `${YAHOO_URL}/${ticker}?interval=1d&range=${encodeURIComponent(range)}`;
  return normalizeYahooBars(JSON.parse(await fetchText(url, 30000, 2)));
}

function applyLiveBar(bars, stock) {
  if (!bars.length || !stock.close || !stock.open) return bars;
  const last = bars[bars.length - 1];
  if (Math.abs(last.close - stock.close) / last.close >= 0.05) return bars;
  return [
    ...bars.slice(0, -1),
    {
      ...last,
      open: stock.open,
      high: stock.high || last.high,
      low: stock.low || last.low,
      close: stock.close,
      volume: stock.volume || last.volume,
    },
  ];
}

function evaluateSwing(stock, bars) {
  if (bars.length < 65) return null;
  const last = bars.at(-1);
  const closes = bars.map(bar => bar.close);
  const lows = bars.map(bar => bar.low);
  const highs = bars.map(bar => bar.high);
  const vols = bars.map(bar => bar.volume);
  const ma20Now = calcMA(closes, 20);
  const ma20Prev = calcMA(closes, 20, closes.length - 3);
  const ma60Now = calcMA(closes, 60);
  if (![ma20Now, ma20Prev, ma60Now].every(Number.isFinite)) return null;

  const recent20High = maxOf(highs.slice(-21, -1));
  const prior60High = maxOf(highs.slice(-61, -21));
  const recent5Low = minOf(lows.slice(-5));
  const recent5High = maxOf(highs.slice(-6, -1));
  const pullbackPct = recent5High ? ((recent5High - recent5Low) / recent5High) * 100 : 0;
  const baseHigh5 = maxOf(highs.slice(-6, -1));
  const avgVol5 = avg(vols.slice(-6, -1));
  const volRatio = avgVol5 ? last.volume / avgVol5 : 0;

  const c1 = last.close > ma20Now && ma20Now > ma20Prev;
  const trendBonus = ma20Now > ma60Now;
  const c2 = recent20High >= prior60High * 0.98;
  const c3 = recent5Low >= ma20Now * 0.97 && pullbackPct <= 8;
  const c4 = last.close > baseHigh5 && last.close >= last.open;
  const c5 = volRatio >= 1.2 && last.volume >= 1000;
  const hitCount = [c1, c2, c3, c4, c5].filter(Boolean).length;
  if (hitCount < 4) return null;

  const stopBase = minOf([last.low, ma20Now, recent5Low]);
  const risk = Math.max(last.close - stopBase, last.close * 0.01);
  const score = Math.round((c1 ? 24 : 0) + (trendBonus ? 8 : 0) + (c2 ? 18 : 0) + (c3 ? 20 : 0) + (c4 ? 18 : 0) + (c5 ? 12 : 0));
  return {
    code: stock.code,
    name: stock.name,
    market: stock.market,
    suffix: stock.suffix,
    date: last.date,
    entry: round(last.close, 2),
    stopLoss: round(last.close - risk, 2),
    takeProfit1: round(last.close + risk * 1.5, 2),
    takeProfit2: round(last.close + risk * 2, 2),
    riskPct: round((risk / last.close) * 100, 2),
    score,
    note: `命中 ${hitCount}/5`,
  };
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try {
        const result = await worker(item);
        if (result) results.push(result);
      } catch (error) {
        console.warn(`skip ${item.code}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });

  console.log('Fetching market snapshots...');
  const [twseText, tpexText] = await Promise.all([
    fetchText(TWSE_URL),
    fetchText(TPEX_URL),
  ]);
  const twsePayload = normalizeTwsePayload(twseText);
  const tpexPayload = JSON.parse(tpexText);

  await fs.writeFile(path.join(dataDir, 'market-twse.json'), `${JSON.stringify(twsePayload)}\n`, 'utf8');
  await fs.writeFile(path.join(dataDir, 'market-tpex.json'), `${JSON.stringify(tpexPayload)}\n`, 'utf8');

  const universe = [...parseTwse(twsePayload), ...parseTpex(tpexPayload)]
    .filter(stock => stock.volume >= 800)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, DAILY_SCAN_LIMIT);

  console.log(`Scanning ${universe.length} stocks...`);
  const history = {};
  const candidates = await mapLimit(universe, CONCURRENCY, async stock => {
    const bars = applyLiveBar(await fetchHistory(stock, '6mo'), stock);
    const candidate = evaluateSwing(stock, bars);
    if (candidate) history[candidate.code] = bars;
    return candidate;
  });

  candidates.sort((a, b) => b.score - a.score || b.entry - a.entry);
  const shown = candidates.slice(0, 12);
  const payload = {
    date: todayText(),
    strategy: 'swing',
    scanned: universe.length,
    generatedAt: new Date().toISOString(),
    candidates: shown,
    history: Object.fromEntries(shown.map(candidate => [candidate.code, history[candidate.code] || []])),
  };

  await fs.writeFile(path.join(dataDir, 'daily-candidates-swing.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${shown.length} candidates: ${shown.map(item => `${item.code} ${item.name}`).join(', ') || 'none'}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
