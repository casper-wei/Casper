const fs = require('node:fs/promises');
const path = require('node:path');

const TWSE_URL = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
const VALUE_TWSE_URL = 'https://www.twse.com.tw/exchangeReport/BWIBBU_ALL?response=json';
const VALUE_TPEX_URL = 'https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json';
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

function calcEMA(values, days) {
  const k = 2 / (days + 1);
  const result = [];
  let ema = null;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      result.push(null);
      return;
    }
    if (ema === null) {
      ema = index >= days - 1 ? avg(values.slice(index - days + 1, index + 1)) : value;
    } else {
      ema = value * k + ema * (1 - k);
    }
    result.push(ema);
  });
  return result;
}

function calcMACD(values) {
  const ema12 = calcEMA(values, 12);
  const ema26 = calcEMA(values, 26);
  const dif = values.map((_, index) => (
    Number.isFinite(ema12[index]) && Number.isFinite(ema26[index]) ? ema12[index] - ema26[index] : null
  ));
  const dea = calcEMA(dif.map(value => Number.isFinite(value) ? value : 0), 9);
  return { dif, dea };
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

function parseValueTwse(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(row => ({
    code: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    pe: numberValue(row[2]),
    yieldPct: numberValue(row[3]),
    pb: numberValue(row[4]),
    market: '上市',
  })).filter(item => /^[1-9]\d{3}$/.test(item.code));
}

function parseValueTpex(payload) {
  const rows = Array.isArray(payload?.tables?.[0]?.data) ? payload.tables[0].data : [];
  return rows.map(row => ({
    code: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    pe: numberValue(row[2]),
    yieldPct: numberValue(row[5]),
    pb: numberValue(row[6]),
    market: '上櫃',
  })).filter(item => /^[1-9]\d{3}$/.test(item.code));
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

function evaluateMaStack(stock, bars) {
  if (bars.length < 80) return null;
  const last = bars.at(-1);
  const closes = bars.map(bar => bar.close);
  const lows = bars.map(bar => bar.low);
  const vols = bars.map(bar => bar.volume);
  const ma5 = calcMA(closes, 5);
  const ma10 = calcMA(closes, 10);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  const ma5Prev = calcMA(closes, 5, closes.length - 3);
  const ma10Prev = calcMA(closes, 10, closes.length - 3);
  const ma20Prev = calcMA(closes, 20, closes.length - 3);
  if (![ma5, ma10, ma20, ma60, ma5Prev, ma10Prev, ma20Prev].every(Number.isFinite)) return null;

  const { dif, dea } = calcMACD(closes);
  const difNow = dif.at(-1);
  const deaNow = dea.at(-1);
  const difPrev = dif.at(-4);
  if (![difNow, deaNow, difPrev].every(Number.isFinite)) return null;

  const compressionWindow = [];
  for (let end = closes.length - 26; end <= closes.length - 2; end += 1) {
    const values = [calcMA(closes, 5, end), calcMA(closes, 10, end), calcMA(closes, 20, end), calcMA(closes, 60, end)];
    if (!values.every(Number.isFinite)) continue;
    compressionWindow.push((Math.max(...values) - Math.min(...values)) / values[3] * 100);
  }
  const minCompression = minOf(compressionWindow);
  const c1 = minCompression > 0 && minCompression <= 6;
  const c2 = ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
  const c3 = difNow > 0 && deaNow > 0 && difNow >= difPrev;
  const c4 = last.close > ma5 && ma5 > ma5Prev && ma10 > ma10Prev && ma20 >= ma20Prev;
  const c5 = last.volume >= 800 && last.volume >= avg(vols.slice(-21, -1)) * 0.8;
  if (!(c1 && c2 && c3 && c4 && c5)) return null;

  const recent10Low = minOf(lows.slice(-10));
  const stopBase = minOf([recent10Low, ma20, ma60]);
  const risk = Math.max(last.close - stopBase, last.close * 0.01);
  const score = Math.round((c1 ? 25 : 0) + (c2 ? 30 : 0) + (c3 ? 25 : 0) + (c4 ? 10 : 0) + (c5 ? 10 : 0));
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
    note: `糾結 ${round(minCompression, 1)}% / MACD>0`,
  };
}

function scoreValueStock(item) {
  const roeEst = item.pe > 0 ? item.pb / item.pe * 100 : 0;
  const valuationScore = clampScore((item.pe <= 10 ? 50 : item.pe <= 15 ? 42 : item.pe <= 20 ? 30 : item.pe <= 30 ? 16 : 4) + (item.pb <= 1 ? 50 : item.pb <= 1.5 ? 40 : item.pb <= 2 ? 26 : item.pb <= 3 ? 12 : 2));
  const profitScore = clampScore((roeEst >= 15 ? 55 : roeEst >= 10 ? 44 : roeEst >= 7 ? 30 : roeEst >= 4 ? 16 : 4) + (item.yieldPct >= 5 ? 45 : item.yieldPct >= 3 ? 34 : item.yieldPct >= 1.5 ? 18 : item.yieldPct > 0 ? 8 : 0));
  const safetyScore = clampScore((item.pb <= 1.2 ? 36 : item.pb <= 2 ? 28 : item.pb <= 3 ? 16 : 4) + (item.pe <= 18 ? 32 : item.pe <= 30 ? 18 : 4) + (item.quote.volume >= 1000 ? 18 : 10) + (item.yieldPct >= 2 ? 14 : 4));
  return { roeEst, valuationScore, profitScore, safetyScore };
}

function evaluateValueStock(item, bars) {
  if (bars.length < 80) return null;
  const last = bars.at(-1);
  const closes = bars.map(bar => bar.close);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  const ma20Prev = calcMA(closes, 20, closes.length - 5);
  const high120 = maxOf(bars.map(bar => bar.high).slice(-120));
  const sixMonthReturn = bars[0].close ? (last.close - bars[0].close) / bars[0].close * 100 : 0;
  const drawdownFromHigh = high120 ? (last.close - high120) / high120 * 100 : 0;
  const { roeEst, valuationScore, profitScore, safetyScore } = scoreValueStock(item);
  const growthScore = clampScore((last.close > ma60 ? 34 : 12) + (ma20 > ma20Prev ? 34 : 12) + (sixMonthReturn > 0 ? 22 : 8) + (last.close > ma20 ? 10 : 0));
  const valueTrapReasons = [];
  if (roeEst < 6) valueTrapReasons.push('ROE估偏低');
  if (item.yieldPct < 2) valueTrapReasons.push('殖利率不足');
  if (last.close < ma60 && ma20 < ma60) valueTrapReasons.push('長線仍偏弱');
  if (drawdownFromHigh < -35) valueTrapReasons.push('疑似弱勢便宜股');

  const fairLow = Math.max(item.pb ? last.close * (1.05 / item.pb) : 0, item.pe ? last.close * (10 / item.pe) : 0);
  const fairHigh = Math.max(item.pb ? last.close * (1.45 / item.pb) : 0, item.pe ? last.close * (15 / item.pe) : 0);
  const technicalEntry = last.close > ma20 && ma20 > ma20Prev ? '站上20MA' : last.close > ma60 ? '等20MA轉強' : '等站回60MA';
  const backtestReturn = calcValueBacktestReturn(bars);
  const totalScore = Math.round(valuationScore * 0.34 + profitScore * 0.24 + safetyScore * 0.22 + growthScore * 0.2);

  return {
    code: item.code,
    name: item.name,
    market: item.market,
    close: round(last.close, 2),
    pe: item.pe,
    pb: item.pb,
    yieldPct: item.yieldPct,
    roeEst: round(roeEst, 2),
    valuationScore,
    profitScore,
    safetyScore,
    growthScore,
    totalScore,
    valueTrapReasons,
    fairLow: round(Math.min(fairLow, fairHigh), 2),
    fairHigh: round(Math.max(fairLow, fairHigh), 2),
    technicalEntry,
    backtestReturn: backtestReturn === null ? null : round(backtestReturn, 2),
  };
}

function calcValueBacktestReturn(bars) {
  if (bars.length < 80) return null;
  const startIndex = Math.max(60, bars.length - 60);
  const entry = bars[startIndex]?.close;
  const exit = bars.at(-1)?.close;
  return entry && exit ? (exit - entry) / entry * 100 : null;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, round(value, 1)));
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
  const [twseText, tpexText, valueTwseText, valueTpexText] = await Promise.all([
    fetchText(TWSE_URL),
    fetchText(TPEX_URL),
    fetchText(VALUE_TWSE_URL),
    fetchText(VALUE_TPEX_URL),
  ]);
  const twsePayload = normalizeTwsePayload(twseText);
  const tpexPayload = JSON.parse(tpexText);
  const valueTwsePayload = JSON.parse(valueTwseText);
  const valueTpexPayload = JSON.parse(valueTpexText);

  await fs.writeFile(path.join(dataDir, 'market-twse.json'), `${JSON.stringify(twsePayload)}\n`, 'utf8');
  await fs.writeFile(path.join(dataDir, 'market-tpex.json'), `${JSON.stringify(tpexPayload)}\n`, 'utf8');

  const fullUniverse = [...parseTwse(twsePayload), ...parseTpex(tpexPayload)];
  const quoteMap = new Map(fullUniverse.map(stock => [stock.code, stock]));
  const universe = fullUniverse
    .filter(stock => stock.volume >= 800)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, DAILY_SCAN_LIMIT);

  console.log(`Scanning ${universe.length} stocks...`);
  const swingHistory = {};
  const maStackHistory = {};
  const results = await mapLimit(universe, CONCURRENCY, async stock => {
    const bars = applyLiveBar(await fetchHistory(stock, '6mo'), stock);
    const swing = evaluateSwing(stock, bars);
    const maStack = evaluateMaStack(stock, bars);
    if (swing) swingHistory[swing.code] = bars;
    if (maStack) maStackHistory[maStack.code] = bars;
    return { swing, maStack };
  });

  await writeStrategySnapshot({
    dataDir,
    filename: 'daily-candidates-swing.json',
    strategy: 'swing',
    scanned: universe.length,
    candidates: results.map(item => item.swing).filter(Boolean),
    history: swingHistory,
  });

  await writeStrategySnapshot({
    dataDir,
    filename: 'daily-candidates-ma-stack.json',
    strategy: 'maStack',
    scanned: universe.length,
    candidates: results.map(item => item.maStack).filter(Boolean),
    history: maStackHistory,
  });

  const valueBase = [...parseValueTwse(valueTwsePayload), ...parseValueTpex(valueTpexPayload)]
    .map(item => ({ ...item, quote: quoteMap.get(item.code) }))
    .filter(item => item.quote && item.quote.close > 0 && item.pe > 0 && item.pb > 0)
    .sort((a, b) => b.quote.volume - a.quote.volume)
    .slice(0, 260);
  console.log(`Scoring ${valueBase.length} value candidates...`);
  const valueRows = await mapLimit(valueBase, CONCURRENCY, async item => {
    const bars = applyLiveBar(await fetchHistory(item.quote, '6mo'), item.quote);
    return evaluateValueStock(item, bars);
  });
  await writeValueSnapshot({
    dataDir,
    scanned: valueBase.length,
    rows: valueRows.filter(Boolean),
  });
}

async function writeStrategySnapshot({ dataDir, filename, strategy, scanned, candidates, history }) {
  candidates.sort((a, b) => b.score - a.score || b.entry - a.entry);
  const shown = candidates.slice(0, 12);
  const payload = {
    date: todayText(),
    strategy,
    scanned,
    generatedAt: new Date().toISOString(),
    candidates: shown,
    history: Object.fromEntries(shown.map(candidate => [candidate.code, history[candidate.code] || []])),
  };
  await fs.writeFile(path.join(dataDir, filename), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${filename}: ${shown.length} candidates: ${shown.map(item => `${item.code} ${item.name}`).join(', ') || 'none'}`);
}

async function writeValueSnapshot({ dataDir, scanned, rows }) {
  const qualified = rows
    .filter(item => item.totalScore >= 65 && item.valueTrapReasons.length <= 1)
    .sort((a, b) => b.totalScore - a.totalScore || b.yieldPct - a.yieldPct)
    .slice(0, 30);
  const payload = {
    date: todayText(),
    strategy: 'value',
    scanned,
    generatedAt: new Date().toISOString(),
    rows: qualified,
  };
  await fs.writeFile(path.join(dataDir, 'value-screener.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote value-screener.json: ${qualified.length} rows: ${qualified.slice(0, 5).map(item => `${item.code} ${item.name}`).join(', ') || 'none'}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
