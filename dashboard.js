const twseCount = document.getElementById('twseCount');
const tpexCount = document.getElementById('tpexCount');
const twseStatus = document.getElementById('twseStatus');
const tpexStatus = document.getElementById('tpexStatus');
const refreshButton = document.getElementById('refreshDashboard');
const strategySelect = document.getElementById('strategySelect');
const runDailyButton = document.getElementById('runDailyStrategy');
const runBacktestButton = document.getElementById('runQuickBacktest');
const clearRecordsButton = document.getElementById('clearDailyRecords');
const dailyRunStatus = document.getElementById('dailyRunStatus');
const backtestRunStatus = document.getElementById('backtestRunStatus');
const dailyCandidatesBody = document.getElementById('dailyCandidatesBody');
const dailyRecordsBody = document.getElementById('dailyRecordsBody');
const quickBacktestMetrics = document.getElementById('quickBacktestMetrics');
const chartTitle = document.getElementById('chartTitle');
const chartMeta = document.getElementById('chartMeta');
const priceChart = document.getElementById('priceChart');

const RECORD_KEY = 'casper.dailyStrategyRecords.v1';
const DAILY_SCAN_LIMIT = 160;
const BACKTEST_LIMIT = 80;
const BACKTEST_HOLD_DAYS = 5;
const LOCAL_API = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const TWSE_URL = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
const YAHOO_URL = 'https://query2.finance.yahoo.com/v8/finance/chart';
const SWING_FALLBACK_URL = 'data/daily-candidates-swing.json';
let latestCandidates = [];
let staticSwingPayload = null;

function todayText() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function setLoading() {
  twseCount.textContent = '檢查中';
  tpexCount.textContent = '檢查中';
  twseStatus.textContent = '連線中';
  tpexStatus.textContent = '連線中';
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

function corsProxyUrl(url) {
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
}

async function fetchTextWithTimeout(url, timeoutMs = 10000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  return JSON.parse(await fetchTextWithTimeout(url, timeoutMs));
}

async function fetchJsonCandidates(urls, timeoutMs = 10000, normalizer = text => JSON.parse(text)) {
  let lastError = null;
  for (const url of urls) {
    try {
      return normalizer(await fetchTextWithTimeout(url, timeoutMs));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('資料源失敗');
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

function marketUrls(localPath, officialUrl, options = {}) {
  const { corsFallback = false, staticFallback = null, preferStatic = false } = options;
  if (LOCAL_API) return [localPath, officialUrl];
  const urls = preferStatic && staticFallback ? [staticFallback, officialUrl] : [officialUrl];
  if (staticFallback && !preferStatic) urls.push(staticFallback);
  if (corsFallback) urls.push(corsProxyUrl(officialUrl));
  return urls;
}

function yahooUrls(ticker, range, interval) {
  const direct = `${YAHOO_URL}/${ticker}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const local = `/api/yahoo?ticker=${encodeURIComponent(ticker)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  return LOCAL_API ? [local, direct] : [direct, corsProxyUrl(direct)];
}

function parseTpexRows(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload?.data)) return payload.data.length;
  return 0;
}

async function loadStaticSwingCandidates() {
  if (LOCAL_API || strategySelect.value !== 'swing') return null;
  if (staticSwingPayload) return staticSwingPayload;
  try {
    const payload = await fetchWithTimeout(SWING_FALLBACK_URL, 10000);
    if (!Array.isArray(payload?.candidates) || !payload.candidates.length) return null;
    staticSwingPayload = payload;
    return payload;
  } catch {
    return null;
  }
}

async function loadStaticCandidateHistory(code) {
  if (LOCAL_API) return null;
  const payload = staticSwingPayload || await loadStaticSwingCandidates();
  const bars = payload?.history?.[code];
  return Array.isArray(bars) && bars.length ? bars : null;
}

async function refreshDashboard() {
  setLoading();
  const [twse, tpex] = await Promise.allSettled([
    fetchJsonCandidates(marketUrls('/api/twse', TWSE_URL, { staticFallback: 'data/market-twse.json' }), 15000, normalizeTwsePayload),
    fetchJsonCandidates(marketUrls('/api/tpex', TPEX_URL, { staticFallback: 'data/market-tpex.json', preferStatic: true }), 15000),
  ]);

  if (twse.status === 'fulfilled') {
    const rows = Array.isArray(twse.value?.data) ? twse.value.data.length : 0;
    twseCount.textContent = rows.toLocaleString('zh-TW');
    twseStatus.textContent = rows ? '資料正常' : '無資料';
  } else {
    twseCount.textContent = '失敗';
    twseStatus.textContent = '上市官方源暫時失敗';
  }

  if (tpex.status === 'fulfilled') {
    const rows = parseTpexRows(tpex.value);
    tpexCount.textContent = rows.toLocaleString('zh-TW');
    tpexStatus.textContent = rows ? '資料正常' : '無資料';
  } else {
    tpexCount.textContent = '失敗';
    tpexStatus.textContent = '上櫃官方源暫時失敗';
  }
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

async function loadUniverse() {
  const [twse, tpex] = await Promise.all([
    fetchJsonCandidates(marketUrls('/api/twse', TWSE_URL, { staticFallback: 'data/market-twse.json' }), 15000, normalizeTwsePayload),
    fetchJsonCandidates(marketUrls('/api/tpex', TPEX_URL, { staticFallback: 'data/market-tpex.json', preferStatic: true }), 15000),
  ]);
  return [...parseTwse(twse), ...parseTpex(tpex)]
    .filter(stock => stock.volume >= 800)
    .sort((a, b) => b.volume - a.volume);
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
  const payload = await fetchJsonCandidates(yahooUrls(ticker, range, '1d'), 15000);
  return normalizeYahooBars(payload);
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
  const breakoutPct = baseHigh5 ? ((last.close - baseHigh5) / baseHigh5) * 100 : 0;
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
  return makeCandidate(stock, last, risk, score, `命中 ${hitCount}/5`);
}

function evaluateBreakout(stock, bars) {
  if (bars.length < 22) return null;
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const closes = bars.map(bar => bar.close);
  const highs = bars.map(bar => bar.high);
  const vols = bars.map(bar => bar.volume);
  const bodyPct = last.open ? (last.close - last.open) / last.open : 0;
  const volRatio = avg(vols.slice(-21, -1)) ? last.volume / avg(vols.slice(-21, -1)) : 0;
  const recent10High = maxOf(highs.slice(-11, -1));
  const breakoutPct = recent10High ? ((last.close - recent10High) / recent10High) * 100 : 0;
  const ma5Now = calcMA(closes, 5);
  const ma5Prev = calcMA(closes, 5, closes.length - 1);
  const ma20Now = calcMA(closes, 20);
  const ma20Prev = calcMA(closes, 20, closes.length - 1);
  const c1 = last.close > last.open && bodyPct >= 0.03;
  const c2 = volRatio >= 2;
  const c3 = last.close > recent10High;
  const c4 = ma5Now > ma5Prev && ma20Now > ma20Prev && last.close > prev.close;
  const hitCount = [c1, c2, c3, c4].filter(Boolean).length;
  if (hitCount < 4) return null;
  const stopBase = Math.min(last.low, recent10High);
  const risk = Math.max(last.close - stopBase, last.close * 0.01);
  return makeCandidate(stock, last, risk, hitCount * 25, `突破 ${round(breakoutPct, 1)}%`);
}

function makeCandidate(stock, last, risk, score, note) {
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
    note,
  };
}

async function mapLimit(items, limit, worker, onProgress) {
  const results = [];
  let index = 0;
  let done = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try {
        const result = await worker(item);
        if (result) results.push(result);
      } catch {
        // Keep scans resilient when one upstream ticker fails.
      } finally {
        done += 1;
        onProgress?.(done, items.length);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function strategyLabel(mode) {
  return mode === 'breakout' ? '原本突破' : '短期波段';
}

async function runDailyStrategy() {
  const mode = strategySelect.value;
  runDailyButton.disabled = true;
  dailyRunStatus.textContent = '取得市場資料...';
  dailyCandidatesBody.innerHTML = '<tr><td colspan="6">策略執行中...</td></tr>';

  try {
    const universe = (await loadUniverse()).slice(0, DAILY_SCAN_LIMIT);
    const candidates = await mapLimit(universe, 8, async stock => {
      const bars = applyLiveBar(await fetchHistory(stock, '6mo'), stock);
      return mode === 'breakout' ? evaluateBreakout(stock, bars) : evaluateSwing(stock, bars);
    }, (done, total) => {
      dailyRunStatus.textContent = `分析 ${done} / ${total}`;
    });

    candidates.sort((a, b) => b.score - a.score || b.entry - a.entry);
    let shown = candidates.slice(0, 12);
    const fallback = shown.length ? null : await loadStaticSwingCandidates();
    if (fallback) {
      shown = fallback.candidates.slice(0, 12);
    }
    renderDailyCandidates(shown);
    saveDailyRecord({ date: todayText(), strategy: mode, candidates: shown, scanned: fallback?.scanned || universe.length });
    renderDailyRecords();
    dailyRunStatus.textContent = fallback
      ? `完成：${shown.length} 檔符合（GitHub 快照）`
      : `完成：${candidates.length} 檔符合`;
  } catch (error) {
    dailyRunStatus.textContent = '執行失敗';
    dailyCandidatesBody.innerHTML = `<tr><td colspan="6">策略失敗：${escapeHtml(error.message || String(error))}</td></tr>`;
  } finally {
    runDailyButton.disabled = false;
  }
}

function renderDailyCandidates(candidates) {
  latestCandidates = candidates;
  if (!candidates.length) {
    const label = strategyLabel(strategySelect.value);
    const hint = strategySelect.value === 'breakout'
      ? '強勢突破條件較嚴格，今天可能沒有訊號；可切回短期波段。'
      : '短期波段今天沒有符合條件的候選股。';
    dailyCandidatesBody.innerHTML = `<tr><td colspan="6">${label}：${hint}</td></tr>`;
    renderEmptyChart(hint);
    return;
  }
  dailyCandidatesBody.innerHTML = candidates.map(item => `
    <tr class="candidate-row" data-code="${item.code}" tabindex="0" title="查看 ${escapeHtml(item.name)} 走勢">
      <td>${item.code}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${item.entry.toFixed(2)}</td>
      <td>${item.stopLoss.toFixed(2)} <small class="negative">(${formatPercentFromEntry(item.stopLoss, item.entry)})</small></td>
      <td>${item.takeProfit1.toFixed(2)} <small class="positive">(${formatPercentFromEntry(item.takeProfit1, item.entry)})</small> / ${item.takeProfit2.toFixed(2)} <small class="positive">(${formatPercentFromEntry(item.takeProfit2, item.entry)})</small></td>
      <td>${item.score}</td>
    </tr>
  `).join('');
  renderEmptyChart('點選候選股列即可載入走勢。');
}

function renderEmptyChart(message) {
  if (!priceChart) return;
  chartTitle.textContent = '點選候選股查看走勢';
  chartMeta.textContent = '近 6 個月';
  priceChart.innerHTML = `<span>${escapeHtml(message)}</span>`;
}

function candidateSuffix(candidate) {
  if (candidate.suffix) return candidate.suffix;
  return candidate.market === '上櫃' ? '.TWO' : '.TW';
}

async function showCandidateChart(candidate) {
  if (!candidate || !priceChart) return;
  chartTitle.textContent = `${candidate.code} ${candidate.name}`;
  chartMeta.textContent = '載入走勢...';
  priceChart.innerHTML = '<span>讀取歷史價格中...</span>';
  try {
    const staticBars = await loadStaticCandidateHistory(candidate.code);
    if (staticBars) {
      renderPriceChart(candidate, staticBars, '快照');
      return;
    }
    const bars = await fetchHistory({ code: candidate.code, suffix: candidateSuffix(candidate) }, '6mo');
    renderPriceChart(candidate, bars);
  } catch (error) {
    const fallbackBars = await loadStaticCandidateHistory(candidate.code);
    if (fallbackBars) {
      renderPriceChart(candidate, fallbackBars, '快照');
      return;
    }
    chartMeta.textContent = '載入失敗';
    priceChart.innerHTML = `<span>走勢載入失敗：${escapeHtml(error.message || String(error))}</span>`;
  }
}

function renderPriceChart(candidate, bars, sourceLabel = '') {
  const validBars = bars.filter(bar => Number.isFinite(bar.close));
  if (validBars.length < 2) {
    chartMeta.textContent = '資料不足';
    priceChart.innerHTML = '<span>歷史價格不足，暫時無法畫圖。</span>';
    return;
  }

  const width = 760;
  const height = 260;
  const pad = { top: 18, right: 74, bottom: 32, left: 54 };
  const prices = validBars.flatMap(bar => [bar.high, bar.low, bar.close]).filter(Number.isFinite);
  prices.push(candidate.entry, candidate.stopLoss, candidate.takeProfit1, candidate.takeProfit2);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const spread = Math.max(maxPrice - minPrice, maxPrice * 0.04);
  const low = minPrice - spread * 0.12;
  const high = maxPrice + spread * 0.12;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xFor = index => pad.left + (validBars.length === 1 ? 0 : index / (validBars.length - 1) * plotW);
  const yFor = price => pad.top + (high - price) / (high - low) * plotH;
  const closePath = validBars.map((bar, index) => `${index ? 'L' : 'M'} ${round(xFor(index), 2)} ${round(yFor(bar.close), 2)}`).join(' ');
  const last = validBars.at(-1);
  const first = validBars[0];
  const changePct = first.close ? (last.close - first.close) / first.close * 100 : 0;
  const line = (value, label, color) => {
    const y = round(yFor(value), 2);
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 5" />
      <text x="${width - pad.right + 8}" y="${y + 4}" fill="${color}" font-size="12" font-weight="800">${label}</text>
    `;
  };
  const grid = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const y = pad.top + ratio * plotH;
    const value = high - ratio * (high - low);
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="rgba(151,166,184,.14)" />
      <text x="8" y="${y + 4}" fill="#97a6b8" font-size="11">${round(value, 1)}</text>
    `;
  }).join('');

  chartMeta.textContent = `${validBars.length} 根日 K｜${formatSigned(changePct)}%${sourceLabel ? `｜${sourceLabel}` : ''}`;
  priceChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${candidate.code} ${escapeHtml(candidate.name)} 近 6 個月走勢">
      <rect width="${width}" height="${height}" rx="8" fill="#0b1118" />
      ${grid}
      <path d="${closePath}" fill="none" stroke="#5aa7ff" stroke-width="2.5" />
      ${line(candidate.entry, '買進', '#43d184')}
      ${line(candidate.stopLoss, '停損', '#ff6473')}
      ${line(candidate.takeProfit1, 'T1', '#f0c84f')}
      ${line(candidate.takeProfit2, 'T2', '#f0c84f')}
      <circle cx="${round(xFor(validBars.length - 1), 2)}" cy="${round(yFor(last.close), 2)}" r="4" fill="#eef4f8" />
      <text x="${pad.left}" y="${height - 10}" fill="#97a6b8" font-size="12">${first.date}</text>
      <text x="${width - pad.right - 70}" y="${height - 10}" fill="#97a6b8" font-size="12">${last.date}</text>
    </svg>
    <div class="chart-stats">
      <span>收盤 ${round(last.close, 2)}</span>
      <span>買進 ${candidate.entry.toFixed(2)}</span>
      <span>停損 ${candidate.stopLoss.toFixed(2)} <b class="negative">${formatPercentFromEntry(candidate.stopLoss, candidate.entry)}</b></span>
      <span>停利 ${candidate.takeProfit1.toFixed(2)} <b class="positive">${formatPercentFromEntry(candidate.takeProfit1, candidate.entry)}</b> / ${candidate.takeProfit2.toFixed(2)} <b class="positive">${formatPercentFromEntry(candidate.takeProfit2, candidate.entry)}</b></span>
    </div>
  `;
}

function getRecords() {
  try {
    return JSON.parse(localStorage.getItem(RECORD_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveDailyRecord(record) {
  const records = getRecords();
  const key = `${record.date}:${record.strategy}`;
  const filtered = records.filter(item => `${item.date}:${item.strategy}` !== key);
  filtered.unshift({
    ...record,
    savedAt: new Date().toISOString(),
  });
  localStorage.setItem(RECORD_KEY, JSON.stringify(filtered.slice(0, 90)));
}

function renderDailyRecords() {
  const records = getRecords();
  if (!records.length) {
    dailyRecordsBody.innerHTML = '<tr><td colspan="5">尚無紀錄。</td></tr>';
    return;
  }
  dailyRecordsBody.innerHTML = records.slice(0, 20).map(record => {
    const top = (record.candidates || []).slice(0, 3).map(item => `${item.code} ${item.name}`).join('、') || '--';
    return `
      <tr>
        <td>${record.date}</td>
        <td>${strategyLabel(record.strategy)}</td>
        <td>${record.candidates?.length || 0}</td>
        <td>${escapeHtml(top)}</td>
        <td>掃描 ${record.scanned || '--'} 檔</td>
      </tr>
    `;
  }).join('');
}

async function runQuickBacktest() {
  const mode = strategySelect.value;
  runBacktestButton.disabled = true;
  backtestRunStatus.textContent = '回測中...';
  renderBacktestMetrics(null);

  try {
    const universe = (await loadUniverse()).slice(0, BACKTEST_LIMIT);
    const trades = await mapLimit(universe, 8, async stock => {
      const bars = await fetchHistory(stock, '6mo');
      return backtestStock(stock, bars, mode);
    }, (done, total) => {
      backtestRunStatus.textContent = `回測 ${done} / ${total}`;
    });
    const flattened = trades.flat();
    renderBacktestMetrics(calculateMetrics(flattened));
    backtestRunStatus.textContent = `完成：${flattened.length} 筆訊號`;
  } catch (error) {
    backtestRunStatus.textContent = '回測失敗';
    quickBacktestMetrics.innerHTML = `<div><small>錯誤</small><strong>${escapeHtml(error.message || String(error))}</strong></div>`;
  } finally {
    runBacktestButton.disabled = false;
  }
}

function backtestStock(stock, bars, mode) {
  const minBars = mode === 'breakout' ? 22 : 65;
  if (bars.length < minBars + BACKTEST_HOLD_DAYS) return [];
  const trades = [];
  for (let i = minBars; i < bars.length - BACKTEST_HOLD_DAYS; i += 1) {
    const windowBars = bars.slice(0, i + 1);
    const signal = mode === 'breakout' ? evaluateBreakout(stock, windowBars) : evaluateSwing(stock, windowBars);
    if (!signal) continue;
    const entry = bars[i];
    const exit = bars[i + BACKTEST_HOLD_DAYS];
    if (!entry.close || !exit.close) continue;
    trades.push({
      code: stock.code,
      date: entry.date,
      returnPct: ((exit.close - entry.close) / entry.close) * 100,
    });
  }
  return trades;
}

function calculateMetrics(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgReturn: null, maxDrawdown: null };
  const returns = trades.map(trade => trade.returnPct).filter(Number.isFinite);
  const wins = returns.filter(value => value > 0);
  const avgReturn = avg(returns);
  const returnsByDate = new Map();
  trades.forEach(trade => {
    if (!Number.isFinite(trade.returnPct)) return;
    const values = returnsByDate.get(trade.date) || [];
    values.push(trade.returnPct);
    returnsByDate.set(trade.date, values);
  });
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  [...returnsByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([, values]) => {
    equity *= 1 + avg(values) / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity - peak) / peak * 100);
  });
  return {
    count: returns.length,
    winRate: returns.length ? wins.length / returns.length * 100 : null,
    avgReturn,
    maxDrawdown,
  };
}

function renderBacktestMetrics(metrics) {
  const values = metrics ? [
    ['訊號數', String(metrics.count)],
    ['勝率', metrics.winRate === null ? '--' : `${round(metrics.winRate, 1)}%`],
    ['平均報酬', metrics.avgReturn === null ? '--' : `${formatSigned(metrics.avgReturn)}%`],
    ['最大回撤', metrics.maxDrawdown === null ? '--' : `${round(metrics.maxDrawdown, 1)}%`],
  ] : [
    ['訊號數', '--'],
    ['勝率', '--'],
    ['平均報酬', '--'],
    ['最大回撤', '--'],
  ];
  quickBacktestMetrics.innerHTML = values.map(([label, value]) => `
    <div><small>${label}</small><strong>${value}</strong></div>
  `).join('');
}

function formatSigned(value) {
  const rounded = round(value, 2);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function formatPercentFromEntry(price, entry) {
  if (!Number.isFinite(price) || !Number.isFinite(entry) || !entry) return '--';
  return `${formatSigned((price - entry) / entry * 100)}%`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[ch]));
}

refreshButton?.addEventListener('click', refreshDashboard);
runDailyButton?.addEventListener('click', runDailyStrategy);
runBacktestButton?.addEventListener('click', runQuickBacktest);
clearRecordsButton?.addEventListener('click', () => {
  localStorage.removeItem(RECORD_KEY);
  renderDailyRecords();
});
dailyCandidatesBody?.addEventListener('click', event => {
  const row = event.target.closest('.candidate-row');
  if (!row) return;
  dailyCandidatesBody.querySelectorAll('.candidate-row').forEach(item => item.classList.toggle('is-selected', item === row));
  showCandidateChart(latestCandidates.find(item => item.code === row.dataset.code));
});
dailyCandidatesBody?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.candidate-row');
  if (!row) return;
  event.preventDefault();
  row.click();
});

refreshDashboard();
renderDailyRecords();
