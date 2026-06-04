// ===== Yahoo Finance API =====
// 使用 query2（有較好的 CORS 支援）
const YAHOO_API = 'https://query2.finance.yahoo.com/v8/finance/chart';
// CORS proxy — 當 file:// 直接開啟遇到 CORS 封鎖時自動使用
const CORS_PROXY = 'https://corsproxy.io/?url=';
const CORS_PROXIES = [
    url => `${CORS_PROXY}${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
];
const LOOPBACK_API_BASE = 'http://127.0.0.1:8787';
const LOCAL_MARKET_API = location.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/i.test(location.hostname);
const LOCAL_PROXY_FIRST = !LOCAL_MARKET_API;

function localApiUrl(path) {
    return LOCAL_MARKET_API ? path : LOOPBACK_API_BASE + path;
}

// 股票代號 → [中文名稱, 類型]
const STOCK_DB = {
    // 半導體 / 科技
    '2330': ['台積電','上市'], '2303': ['聯電','上市'], '2308': ['台達電','上市'],
    '2317': ['鴻海','上市'], '2324': ['仁寶','上市'], '2327': ['國巨','上市'],
    '2344': ['華邦電','上市'], '2347': ['聯強','上市'], '2353': ['宏碁','上市'],
    '2354': ['鴻準','上市'], '2356': ['英業達','上市'], '2357': ['華碩','上市'],
    '2360': ['致茂','上市'], '2371': ['大同','上市'], '2376': ['技嘉','上市'],
    '2377': ['微星','上市'], '2379': ['瑞昱','上市'], '2382': ['廣達','上市'],
    '2383': ['台光電','上市'], '2385': ['群光','上市'], '2392': ['正崴','上市'],
    '2395': ['研華','上市'], '2408': ['南亞科','上市'], '2409': ['友達','上市'],
    '2412': ['中華電','上市'], '2454': ['聯發科','上市'], '2474': ['可成','上市'],
    '2498': ['宏達電','上市'], '3008': ['大立光','上市'], '3034': ['聯詠','上市'],
    '3037': ['欣興','上市'], '3711': ['日月光投控','上市'], '4938': ['和碩','上市'],
    '2049': ['上銀','上市'], '6669': ['緯穎','上市'], '3231': ['緯創','上市'],
    '2301': ['光寶科','上市'], '2337': ['旺宏','上市'], '6770': ['力積電','上市'],
    // 金融
    '2880': ['華南金','上市'], '2881': ['富邦金','上市'], '2882': ['國泰金','上市'],
    '2883': ['開發金','上市'], '2884': ['玉山金','上市'], '2885': ['元大金','上市'],
    '2886': ['兆豐金','上市'], '2887': ['台新金','上市'], '2888': ['新光金','上市'],
    '2890': ['永豐金','上市'], '2891': ['中信金','上市'], '2892': ['第一金','上市'],
    '5880': ['合庫金','上市'], '2823': ['中壽','上市'],
    // 傳產 / 材料
    '1101': ['台泥','上市'], '1102': ['亞泥','上市'], '1216': ['統一','上市'],
    '1301': ['台塑','上市'], '1303': ['南亞','上市'], '1326': ['台化','上市'],
    '1402': ['遠東新','上市'], '2002': ['中鋼','上市'], '2105': ['正新','上市'],
    '2207': ['和泰車','上市'], '1904': ['正隆','上市'], '1605': ['華新','上市'],
    // 電信
    '3045': ['台灣大','上市'], '4904': ['遠傳','上市'],
    // ETF
    '0050': ['台灣50','ETF'], '0051': ['中型100','ETF'], '0052': ['富邦科技','ETF'],
    '0056': ['高股息','ETF'], '006208': ['富邦台50','ETF'],
    '00878': ['國泰永續高股息','ETF'], '00919': ['群益台灣精選高息','ETF'],
    '00929': ['復華台灣科技優息','ETF'], '00940': ['元大台灣價值高息','ETF'],
    '00934': ['中信成長高股息','ETF'], '00713': ['元大台灣高息低波','ETF'],
};

const CN_NAMES = Object.fromEntries(Object.entries(STOCK_DB).map(([k, v]) => [k, v[0]]));
const STOCK_ENTRIES = Object.entries(STOCK_DB); // pre-built for searchLocal hot path

// ===== State =====
let state = {
    stockNo: '',
    ticker: '',         // e.g. "2330.TW"
    currentTab: 'realtime',
    meta: null,
    historyData: [],
    chartMonths: 3,
    refreshTimer: null,
    chart: null,
};

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('stockInput');
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { closeAutocomplete(); handleSearch(); }
        else if (e.key === 'Escape') closeAutocomplete();
        else if (e.key === 'ArrowDown') navigateAutocomplete(1);
        else if (e.key === 'ArrowUp') navigateAutocomplete(-1);
    });
    input.addEventListener('input', onInputChange);
    document.addEventListener('click', e => {
        if (!e.target.closest('.input-wrapper')) closeAutocomplete();
    });
    updateMarketStatus();
    setInterval(updateMarketStatus, 60000);
});

// ===== Autocomplete =====
let acActiveIndex = -1;
let acDebounceTimer = null;

function onInputChange() {
    const val = document.getElementById('stockInput').value.trim();
    if (!val) { closeAutocomplete(); return; }

    // 先顯示本地快速結果
    const local = searchLocal(val);
    if (local.length) renderAutocomplete(local, val);

    // 再用 TWSE API 補全（debounce 300ms）
    clearTimeout(acDebounceTimer);
    acDebounceTimer = setTimeout(() => fetchTWSESuggestions(val), 300);
}

// 本地資料庫即時搜尋（無延遲）
function searchLocal(query) {
    const q = query.toLowerCase();
    const results = [];
    for (const [code, [name, type]] of STOCK_ENTRIES) {
        if (code.startsWith(q) || name.includes(query)) {
            results.push({ code, name, type });
        }
    }
    results.sort((a, b) => {
        if (a.code === query) return -1;
        if (b.code === query) return 1;
        if (a.code.startsWith(query) && !b.code.startsWith(query)) return -1;
        if (!a.code.startsWith(query) && b.code.startsWith(query)) return 1;
        return a.code.localeCompare(b.code);
    });
    return results.slice(0, 8);
}

// TWSE 代號查詢 API（支援代號+中文名稱，涵蓋全部上市/上櫃）
async function fetchTWSESuggestions(query) {
    try {
        const url = `https://www.twse.com.tw/zh/api/codeQuery?query=${encodeURIComponent(query)}`;
        let json;
        try {
            const res = await fetch(url);
            json = await res.json();
        } catch (_) {
            const res = await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`);
            json = await res.json();
        }
        const suggestions = json?.suggestions ?? [];
        if (!suggestions.length || suggestions[0] === 'no result') return;

        const items = suggestions
            .filter(s => s.includes('\t'))
            .map(s => {
                const [code, name] = s.split('\t');
                return { code: code.trim(), name: name.trim(), type: guessType(code.trim()) };
            });

        // 確認輸入值仍符合當初查詢的 query，避免舊請求覆蓋新結果
        const current = document.getElementById('stockInput').value.trim();
        if (!items.length || !current.includes(query.slice(0, 1))) return;
        if (current !== query && !current.startsWith(query) && !query.startsWith(current)) return;

        renderAutocomplete(items.slice(0, 10), current);
    } catch (_) { /* 靜默失敗，本地結果已顯示 */ }
}

function guessType(code) {
    if (STOCK_DB[code]) return STOCK_DB[code][1];
    if (/^00/.test(code) || /^\d{6}$/.test(code)) return 'ETF';
    return '股票';
}

function renderAutocomplete(items, query) {
    const list = document.getElementById('autocompleteList');
    if (!items.length) { closeAutocomplete(); return; }
    acActiveIndex = -1;
    const re = new RegExp(`(${escapeRe(query)})`, 'gi');
    list.innerHTML = items.map(item => {
        re.lastIndex = 0;
        const codeHl = item.code.replace(re, '<span class="ac-highlight">$1</span>');
        re.lastIndex = 0;
        const nameHl = item.name.replace(re, '<span class="ac-highlight">$1</span>');
        return `<div class="autocomplete-item" data-code="${item.code}" onclick="selectSuggestion('${item.code}')">
            <span class="ac-code">${codeHl}</span>
            <span class="ac-name">${nameHl}</span>
            <span class="ac-type">${item.type}</span>
        </div>`;
    }).join('');
    list.classList.remove('hidden');
}

function selectSuggestion(code) {
    document.getElementById('stockInput').value = code;
    closeAutocomplete();
    searchStock(code);
}

function navigateAutocomplete(dir) {
    const items = document.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    items[acActiveIndex]?.classList.remove('active');
    acActiveIndex = Math.max(-1, Math.min(items.length - 1, acActiveIndex + dir));
    if (acActiveIndex >= 0) {
        items[acActiveIndex].classList.add('active');
        document.getElementById('stockInput').value = items[acActiveIndex].dataset.code;
    }
}

function closeAutocomplete() {
    hide('autocompleteList');
    acActiveIndex = -1;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===== Market Status =====
function isMarketOpen() {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    return now.getDay() >= 1 && now.getDay() <= 5 && m >= 9 * 60 && m < 13 * 60 + 30;
}

function updateMarketStatus() {
    const isOpen = isMarketOpen();
    const el = document.getElementById('marketStatus');
    el.textContent = isOpen ? '● 盤中' : '盤後';
    el.className = 'market-status ' + (isOpen ? 'open' : 'closed');
}

// ===== Search =====
function handleSearch() {
    const val = document.getElementById('stockInput').value.trim();
    if (!val) return;
    searchStock(val);
}

function quickSearch(code) {
    document.getElementById('stockInput').value = code;
    searchStock(code);
}

async function searchStock(input) {
    clearRefreshTimer();
    closeAutocomplete();

    // 去除 .TW/.TWO 後綴（使用者可能貼上完整 ticker）
    let stockNo = input.trim().replace(/\.(TWO|TW)$/i, '').trim();

    // 支援中文名稱查詢：找出對應代號
    if (/[\u4e00-\u9fff]/.test(stockNo)) {
        const match = Object.entries(STOCK_DB).find(([, [name]]) => name === stockNo);
        if (match) {
            stockNo = match[0];
            document.getElementById('stockInput').value = stockNo;
        } else {
            showError(`找不到「${stockNo}」，請輸入正確的中文名稱或股票代號`);
            return;
        }
    }

    state.stockNo = stockNo;

    showLoading(true);
    hideError();
    hide('result');

    try {
        // Try TSE (.TW) first, then OTC (.TWO)
        let result = null;
        let ticker = '';

        try {
            ticker = `${state.stockNo}.TW`;
            result = await fetchYahoo(ticker, { interval: '1d', range: '5d' });
        } catch (_) {
            ticker = `${state.stockNo}.TWO`;
            result = await fetchYahoo(ticker, { interval: '1d', range: '5d' });
        }

        state.ticker = ticker;
        state.meta = result.meta;

        renderQuoteFromMeta(result.meta);
        show('result');

        const dot = document.getElementById('realtimeDot');
        dot.className = 'tab-dot' + (isMarketOpen() ? ' active' : '');

        if (isMarketOpen()) {
            state.refreshTimer = setInterval(refreshRealtime, 20000);
        }

        loadChartHistory(state.chartMonths);

    } catch (err) {
        showError(`找不到股票代號「${state.stockNo}」，請確認是否正確（例：2330、0050）`);
        console.error(err);
    } finally {
        showLoading(false);
    }
}

async function refreshRealtime() {
    if (!isMarketOpen() || state.currentTab !== 'realtime') {
        clearRefreshTimer();
        return;
    }
    try {
        const result = await fetchYahoo(state.ticker, { interval: '1d', range: '5d' });
        state.meta = result.meta;
        renderQuoteFromMeta(result.meta);
    } catch (_) { /* silent */ }
}

// ===== Yahoo Finance Fetch =====
async function fetchYahoo(ticker, params) {
    const qs = new URLSearchParams(params).toString();
    const directUrl = `${YAHOO_API}/${ticker}?${qs}`;
    const localUrl = `${localApiUrl('/api/yahoo')}?ticker=${encodeURIComponent(ticker)}&${qs}`;
    const candidates = LOCAL_PROXY_FIRST ? [localUrl, directUrl] : [localUrl];

    let json = null;
    let lastError = null;
    for (const candidate of candidates) {
        try {
            json = await fetchJsonOnce(candidate, candidate === localUrl && LOCAL_PROXY_FIRST ? 2500 : 12000);
            break;
        } catch (err) {
            lastError = err;
        }
    }

    if (!json && !LOCAL_MARKET_API) {
        const proxyUrl = `${CORS_PROXY}${encodeURIComponent(directUrl)}`;
        json = await fetchJsonOnce(proxyUrl, 12000).catch(err => {
            throw lastError || err;
        });
    }

    if (json.chart?.error) throw new Error(json.chart.error.description || 'API error');
    const result = json.chart?.result?.[0];
    if (!result) throw new Error('No data returned');
    return result;
}

async function fetchYahooHistory(ticker, months) {
    const range = months <= 3 ? '3mo' : months <= 6 ? '6mo' : '1y';
    const result = await fetchYahoo(ticker, { interval: '1d', range });

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};

    return timestamps.map((ts, i) => ({
        date: tsToDate(ts),
        open:   roundPrice(q.open?.[i]),
        high:   roundPrice(q.high?.[i]),
        low:    roundPrice(q.low?.[i]),
        close:  roundPrice(q.close?.[i]),
        volume: Math.round((q.volume?.[i] || 0) / 1000), // 張
    })).filter(d => d.close !== null && !isNaN(d.close));
}

// ===== Shared stock header (code, name, badge) =====
function renderStockHeader(nameOverride) {
    const code = state.stockNo;
    const isTWO = state.ticker.endsWith('.TWO');
    const name = nameOverride || CN_NAMES[code] || code;
    document.getElementById('stockCode').textContent = code;
    document.getElementById('stockName').textContent = name;
    const badge = document.getElementById('marketBadge');
    badge.textContent = isTWO ? '上櫃' : '上市';
    badge.className = 'market-badge ' + (isTWO ? 'otc' : 'tse');
}

// ===== Render Quote from Yahoo meta =====
function renderQuoteFromMeta(meta) {
    renderStockHeader(meta.shortName || meta.longName);

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
    const change = price - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
    const prefix = change > 0 ? '+' : '';

    const priceEl = document.getElementById('currentPrice');
    priceEl.textContent = price?.toFixed(2) ?? '--';
    priceEl.className = 'current-price ' + dir;

    setChangeEl('changeVal', isNaN(change) ? '--' : `${prefix}${change.toFixed(2)}`, dir);
    setChangeEl('changePct', isNaN(changePct) ? '--' : `${prefix}${changePct.toFixed(2)}%`, dir);

    setText('openPrice',  meta.regularMarketOpen?.toFixed(2) ?? '--');
    setText('highPrice',  meta.regularMarketDayHigh?.toFixed(2) ?? '--');
    setText('lowPrice',   meta.regularMarketDayLow?.toFixed(2) ?? '--');
    setText('prevClose',  prevClose?.toFixed(2) ?? '--');
    setText('volume',     fmtVolume(meta.regularMarketVolume));

    // 漲停/跌停 台股 ±10%（以昨收計算）
    if (prevClose) {
        setText('upperLimit', calcLimit(prevClose, 1.10));
        setText('lowerLimit', calcLimit(prevClose, 0.90));
    }

    // 更新時間
    const lastTime = meta.regularMarketTime
        ? new Date(meta.regularMarketTime * 1000).toLocaleString('zh-TW', {
            timeZone: 'Asia/Taipei',
            month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
          })
        : '';
    const dateOnly = meta.regularMarketTime
        ? new Date(meta.regularMarketTime * 1000).toLocaleDateString('zh-TW', {
            timeZone: 'Asia/Taipei',
            year: 'numeric', month: '2-digit', day: '2-digit'
          })
        : '--';

    setText('tradeDate', dateOnly);
    document.getElementById('updateTime').textContent = lastTime ? `更新：${lastTime}` : '';
}

// ===== Render Quote from History (After-hours tab) =====
function renderQuoteFromHistory(data) {
    if (!data?.length) return;
    const last = data[data.length - 1];
    renderStockHeader(state.meta?.shortName);

    // Use meta.chartPreviousClose as authoritative reference (matches Yahoo's official % calc)
    const prevClose = state.meta?.chartPreviousClose ?? (data.length >= 2 ? data[data.length - 2].close : null);
    const change = prevClose != null ? last.close - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const prev = prevClose;
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
    const prefix = change > 0 ? '+' : '';

    const priceEl = document.getElementById('currentPrice');
    priceEl.textContent = last.close.toFixed(2);
    priceEl.className = 'current-price ' + dir;

    setChangeEl('changeVal', `${prefix}${change.toFixed(2)}`, dir);
    setChangeEl('changePct', `${prefix}${changePct.toFixed(2)}%`, dir);

    setText('openPrice',  last.open.toFixed(2));
    setText('highPrice',  last.high.toFixed(2));
    setText('lowPrice',   last.low.toFixed(2));
    setText('prevClose',  prev !== null ? prev.toFixed(2) : '--');
    setText('volume',     last.volume.toLocaleString() + ' 張');
    setText('upperLimit', prev ? calcLimit(prev, 1.10) : '--');
    setText('lowerLimit', prev ? calcLimit(prev, 0.90) : '--');
    setText('tradeDate',  last.date);
    document.getElementById('updateTime').textContent = `盤後資料：${last.date}`;
}

// ===== Tab Switch =====
function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(tab === 'realtime' ? 'tabRealtime' : 'tabAfterHours').classList.add('active');

    if (tab === 'realtime' && state.meta) {
        renderQuoteFromMeta(state.meta);
    } else if (tab === 'afterhours' && state.historyData.length > 0) {
        renderQuoteFromHistory(state.historyData);
    }
}

// ===== Load Chart History =====
async function loadChartHistory(months) {
    showChartLoading(true);
    hide('srSection');
    try {
        const data = await fetchYahooHistory(state.ticker, months);
        state.historyData = data;
        if (data.length > 0) {
            const currentPrice = state.meta?.regularMarketPrice ?? data[data.length - 1].close;
            const srLevels = analyzeSupportResistance(data, currentPrice);
            
            renderChart(data, srLevels);
            renderSRPanel(srLevels, currentPrice);
            
            show('srSection');
        } else {
            document.getElementById('klineChart').innerHTML =
                '<p style="color:var(--text-muted);text-align:center;padding:60px 0">暫無歷史資料</p>';
        }
    } catch (err) {
        console.error('Chart history error:', err);
    } finally {
        showChartLoading(false);
    }
}

// ===== Support / Resistance Analysis =====
function analyzeSupportResistance(data, currentPrice) {
    if (data.length < 15) return { supports: [], resistances: [] };

    const SWING_PERIOD = 4;  // 每側需要的確認K棒數

    // Step 1: 找擺動高低點
    const swingHighs = [];
    const swingLows  = [];
    for (let i = SWING_PERIOD; i < data.length - SWING_PERIOD; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= SWING_PERIOD; j++) {
            if (data[i].high  <= data[i - j].high || data[i].high  <= data[i + j].high) isHigh = false;
            if (data[i].low   >= data[i - j].low  || data[i].low   >= data[i + j].low)  isLow  = false;
        }
        if (isHigh) swingHighs.push({ price: data[i].high, date: data[i].date, index: i });
        if (isLow)  swingLows.push({ price: data[i].low,  date: data[i].date, index: i });
    }

    // Step 2: 聚類（距離在 1.5% 以內的點視為同一區域）
    const CLUSTER_THRESH = 0.015;
    function cluster(points) {
        if (!points.length) return [];
        const sorted = [...points].sort((a, b) => a.price - b.price);
        const groups = [[sorted[0]]];
        for (let i = 1; i < sorted.length; i++) {
            const last = groups[groups.length - 1];
            const avg  = last.reduce((s, p) => s + p.price, 0) / last.length;
            if (Math.abs(sorted[i].price - avg) / avg <= CLUSTER_THRESH) {
                last.push(sorted[i]);
            } else {
                groups.push([sorted[i]]);
            }
        }
        return groups.map(g => {
            const avgPrice = g.reduce((s, p) => s + p.price, 0) / g.length;
            const lastIdx  = Math.max(...g.map(p => p.index));
            return {
                price:    Math.round(avgPrice * 100) / 100,
                strength: g.length,
                lastDate: g.find(p => p.index === lastIdx)?.date ?? '',
                isRecent: lastIdx >= data.length - 20,  // 最近20根K棒內曾觸碰
            };
        });
    }

    const allResistance = cluster(swingHighs)
        .filter(l => l.price > currentPrice * 0.995)
        .sort((a, b) => a.price - b.price)
        .slice(0, 4);

    const allSupport = cluster(swingLows)
        .filter(l => l.price < currentPrice * 1.005)
        .sort((a, b) => b.price - a.price)
        .slice(0, 4);

    return { supports: allSupport, resistances: allResistance };
}

// ===== Render SR Panel =====
function renderSRPanel(levels, currentPrice) {
    const body = document.getElementById('srBody');

    function itemHtml(level, type) {
        const dist    = ((level.price - currentPrice) / currentPrice * 100);
        const distStr = (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%';
        const strength = Math.min(level.strength, 5);
        const dots = Array.from({ length: 5 }, (_, i) =>
            `<span class="sr-dot ${i < strength ? 'filled ' + type : ''}"></span>`
        ).join('');
        const tags = [
            level.strength >= 3 ? '<span class="sr-tag strong">強力</span>' : '',
            level.isRecent     ? '<span class="sr-tag recent">近期</span>'  : '',
        ].join(' ');
        return `
            <div class="sr-item ${type}">
                <div class="sr-price">${level.price.toFixed(2)}</div>
                <div class="sr-info">
                    <div class="sr-dist">${distStr} | 觸碰 ${level.strength} 次</div>
                    <div class="sr-strength">${dots}</div>
                </div>
                ${tags}
            </div>`;
    }

    body.innerHTML = `
        <div>
            <div class="sr-col-title resistance">▲ 壓力位</div>
            ${levels.resistances.length
                ? levels.resistances.map(l => itemHtml(l, 'resistance')).join('')
                : '<div style="color:var(--text-muted);font-size:.85rem;padding:8px 0">無明顯壓力位</div>'}
        </div>
        <div>
            <div class="sr-col-title support">▼ 支撐位</div>
            ${levels.supports.length
                ? levels.supports.map(l => itemHtml(l, 'support')).join('')
                : '<div style="color:var(--text-muted);font-size:.85rem;padding:8px 0">無明顯支撐位</div>'}
        </div>`;
}


// ===== Stock Screener =====
let screenerRunning = false;
let activeScreenerMode = 'swing';

const SCREENER_MODES = {
    swing: {
        title: '⚡ 短期波段選股器',
        subtitle: '掃描上市櫃個股，找出強勢回檔後再轉強的短波段標的',
        buttonLabel: '短期波段',
        rerunLabel: '重新掃描波段',
        headers: ['代號', '名稱', '進場', '止損', '止盈', '風險', '分數/條件', ''],
        badges: ['📈 20MA 向上且站上', '📊 量能 ≥ 5日均量 1.2x', '🚀 突破 5 日整理高點', '🛡 近 5 日回檔 < 8%'],
    },
    breakout: {
        title: '⚡ 原本突破選股器',
        subtitle: '保留原本策略：長紅K棒、成交量翻倍、突破近期阻力、均線上揚',
        buttonLabel: '原本突破',
        rerunLabel: '重新掃描突破',
        headers: ['代號', '名稱', '進場', '止損', '止盈', '風險', '條件', ''],
        badges: ['🕯 長紅K棒 ≥3%', '📊 成交量翻倍', '🚀 突破近期阻力', '📈 均線上揚'],
    },
};

async function runScreener(mode = 'swing') {
    if (screenerRunning) return;
    activeScreenerMode = mode;
    setScreenerModeUI(mode);
    screenerRunning = true;

    setScreenerButtonsDisabled(true, mode, '<span class="screener-btn-icon">⏳</span> 掃描中...');

    document.getElementById('screenerProgress').classList.remove('hidden');
    document.getElementById('screenerResults').classList.add('hidden');
    updateProgress(0, '📡 Phase 1：連線取得全市場資料...');

    // ── Phase 1：從 TWSE / TPEx Open API 拉取今日全市場行情 ──
    let allStocks = [];
    let universeLabel = '全市場';
    const [twseRes, tpexRes] = await Promise.allSettled([
        fetchMarketSnapshot(LOCAL_MARKET_API ? '/api/twse' : 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json', '.TW'),
        fetchMarketSnapshot(LOCAL_MARKET_API ? '/api/tpex' : 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', '.TWO'),
    ]);
    const twseStocks = twseRes.status === 'fulfilled' ? twseRes.value : [];
    const tpexStocks = tpexRes.status === 'fulfilled' ? tpexRes.value : [];
    allStocks.push(...twseStocks, ...tpexStocks);
    if (twseStocks.length && !tpexStocks.length) universeLabel = '上市';
    if (!twseStocks.length && tpexStocks.length) universeLabel = '上櫃';

    // 若 API 完全取不到，降級為 STOCK_DB
    if (!allStocks.length) {
        universeLabel = '自選清單';
        allStocks = Object.entries(STOCK_DB)
            .filter(([, [, t]]) => t !== 'ETF')
            .map(([code, [name, t]]) => ({
                code, name, suffix: t === '上市' ? '.TW' : '.TWO',
                open: null, close: null, high: null, low: null, volume: null,
            }));
    }

    const totalScanned = allStocks.length;
    updateProgress(10, `✅ 取得 ${universeLabel} ${totalScanned} 支個股（上市＋上櫃）`);
    await sleep(200);

    let candidates = mode === 'breakout'
        ? allStocks.filter(s => s.open > 0 && s.close > s.open && (s.close - s.open) / s.open >= 0.03)
        : allStocks.filter(s => s.code && s.volume >= 1000 && (!s.open || s.close >= s.open * 0.98));

    // 若市場 API 資料有缺失（非交易時段），候選清單可能為空 → 用全部
    if (!candidates.length) candidates = allStocks.filter(s => s.code);

    const label = mode === 'breakout' ? '長紅K棒初篩' : '流動性初篩';
    const deepLabel = mode === 'breakout' ? '原本突破深度分析' : '短波段深度分析';
    updateProgress(15, `🔍 ${label}後剩 ${candidates.length} 支，開始${deepLabel}...`);
    await sleep(150);

    const results = [];
    const deepTotal = candidates.length;
    const BATCH = 5;

    for (let i = 0; i < deepTotal; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        const batchRes = await Promise.all(batch.map(s => screenerDeepCheck(s, mode)));
        for (const r of batchRes) { if (r) results.push(r); }

        const done = Math.min(i + BATCH, deepTotal);
        const pct = 15 + Math.round((done / deepTotal) * 85);
        updateProgress(pct, `🔬 深度分析 ${done} / ${deepTotal}，符合 ${results.length} 支...`);

        if (i + BATCH < deepTotal) await sleep(280);
    }

    updateProgress(100, `🎯 掃描完成！${universeLabel} ${totalScanned} 支 → 初篩 ${deepTotal} 支 → 符合 ${results.length} 支`);

    results.sort((a, b) => {
        if (mode === 'breakout') return b.hitCount - a.hitCount || b.changePct - a.changePct;
        return b.swingScore - a.swingScore || b.changePct - a.changePct;
    });
    renderScreenerResults(results, totalScanned, deepTotal, mode, universeLabel);

    setScreenerButtonsDisabled(false);
    screenerRunning = false;
}

function setScreenerModeUI(mode) {
    const config = SCREENER_MODES[mode];
    document.querySelector('.screener-title').textContent = config.title;
    document.querySelector('.screener-subtitle').textContent = config.subtitle;

    const badges = document.querySelectorAll('.screener-conditions .cond-badge');
    config.badges.forEach((text, i) => { if (badges[i]) badges[i].textContent = text; });

    const headers = document.querySelectorAll('#screenerTable thead th');
    config.headers.forEach((text, i) => { if (headers[i]) headers[i].textContent = text; });

    document.getElementById('swingScreenerBtn')?.classList.toggle('active', mode === 'swing');
    document.getElementById('breakoutScreenerBtn')?.classList.toggle('active', mode === 'breakout');
}

function setScreenerButtonsDisabled(disabled, activeMode = activeScreenerMode, activeHtml = null) {
    for (const [mode, config] of Object.entries(SCREENER_MODES)) {
        const btn = document.getElementById(mode === 'swing' ? 'swingScreenerBtn' : 'breakoutScreenerBtn');
        if (!btn) continue;
        btn.disabled = disabled;
        if (disabled && mode === activeMode && activeHtml) {
            btn.innerHTML = activeHtml;
        } else {
            btn.innerHTML = `<span class="screener-btn-icon">${disabled ? '•' : '▶'}</span> ${disabled ? config.buttonLabel : config.rerunLabel}`;
        }
    }
}

function updateProgress(pct, text) {
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressText').textContent = text;
}

async function fetchJsonOnce(url, timeoutMs = 12000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}
async function fetchJsonWithFallback(url, timeoutMs = 12000) {
    const urls = [url, ...CORS_PROXIES.map(proxy => proxy(url))];
    let lastError = null;
    for (const candidate of urls) {
        try {
            return await fetchJsonOnce(candidate, timeoutMs);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('fetch failed');
}
// 取得單一市場快照（TWSE 或 TPEx）
async function fetchMarketSnapshot(url, suffix) {
    const localPath = suffix === '.TWO' ? '/api/tpex' : '/api/twse';
    const candidates = LOCAL_PROXY_FIRST ? [localApiUrl(localPath), url] : [localApiUrl(localPath)];
    let raw = null;
    for (const candidate of candidates) {
        const timeout = candidate.startsWith(LOOPBACK_API_BASE) ? 2500 : 12000;
        raw = await fetchJsonWithFallback(candidate, timeout).catch(() => null);
        if (raw) break;
    }
    if (!raw) return [];

    const rows = Array.isArray(raw) ? raw : (raw.data || raw.aaData || []);
    const stocks = [];
    for (const row of rows) {
        const s = parseMarketRow(row, suffix);
        if (s) stocks.push(s);
    }
    return stocks;
}

// 解析單列行情，相容 TWSE / TPEx 兩種欄位命名
function parseMarketRow(row, suffix) {
    if (Array.isArray(row)) return parseMarketArrayRow(row, suffix);

    const code = (
        row.Code || row['代號'] || row.SecuritiesCompanyCode || ''
    ).toString().trim();

    // 只保留 4 位數字個股，排除 ETF（代碼起頭 0）
    if (!code || !/^\d{4}$/.test(code) || code.startsWith('0')) return null;

    const name = (
        row.Name || row['名稱'] || row.CompanyName || row['公司名稱'] || code
    ).toString().trim();

    const toNum = v => parseFloat((v || '0').toString().replace(/,/g, ''));
    const open   = toNum(row.OpeningPrice  || row.Open  || row['開盤'] || row['開盤價']);
    const close  = toNum(row.ClosingPrice  || row.Close || row['收盤'] || row['收盤價']);
    const high   = toNum(row.HighestPrice  || row.High  || row['最高'] || row['最高價']);
    const low    = toNum(row.LowestPrice   || row.Low   || row['最低'] || row['最低價']);
    const volRaw = (row.TradeVolume || row.TradingShares || row['成交量'] || row['成交股數(千股)'] || '0')
                    .toString().replace(/,/g, '');

    if (isNaN(close) || close <= 0) return null;

    // 上市 TradeVolume/上櫃 TradingShares 多為股，轉為張；若欄位為「成交股數(千股)」則已是張
    const isKiloshares = !!(row['成交股數(千股)']);
    const volume = isKiloshares
        ? Math.round(parseFloat(volRaw))
        : Math.round(parseFloat(volRaw) / 1000);

    return { code, name, suffix, open, close, high, low, volume };
}

function parseMarketArrayRow(row, suffix) {
    // TWSE STOCK_DAY_ALL response=json rows:
    // [code, name, tradeVolume, tradeValue, open, high, low, close, change, transaction]
    const code = (row[0] || '').toString().trim();
    if (!code || !/^\d{4}$/.test(code) || code.startsWith('0')) return null;

    const toNum = v => parseFloat((v || '0').toString().replace(/,/g, ''));
    const name = (row[1] || code).toString().trim();
    const open = toNum(row[4]);
    const high = toNum(row[5]);
    const low = toNum(row[6]);
    const close = toNum(row[7]);
    const volume = Math.round(toNum(row[2]) / 1000);

    if (isNaN(close) || close <= 0) return null;
    return { code, name, suffix, open, close, high, low, volume };
}
async function screenerDeepCheck(stockInfo, mode = 'swing') {
    const { code, name, suffix } = stockInfo;
    try {
        const data = await fetchYahooHistory(code + suffix, mode === 'breakout' ? 2 : 3);
        if (data.length < (mode === 'breakout' ? 22 : 65)) return null;

        // 用市場 API 資料覆蓋最後一根（更即時），若價格落差 < 5% 才採用
        if (stockInfo.close > 0 && stockInfo.open > 0) {
            const last = data[data.length - 1];
            if (Math.abs(last.close - stockInfo.close) / last.close < 0.05) {
                data[data.length - 1] = {
                    ...last,
                    open:   stockInfo.open,
                    close:  stockInfo.close,
                    high:   stockInfo.high  || last.high,
                    low:    stockInfo.low   || last.low,
                    volume: stockInfo.volume > 0 ? stockInfo.volume : last.volume,
                };
            }
        }

        const conds = mode === 'breakout'
            ? checkBreakoutScreenerConditions(data)
            : checkSwingScreenerConditions(data);
        if (conds.hitCount < (mode === 'breakout' ? 4 : 4)) return null;

        const last = data[data.length - 1];
        const prev = data[data.length - 2];
        const changePct = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;

        const plan = buildTradePlan(data, mode, conds);
        return { code, name, last, changePct, plan, ...conds };
    } catch { return null; }
}

function buildTradePlan(data, mode, conds) {
    const last = data[data.length - 1];
    const entry = last.close;
    let stopLoss = conds.stopLoss;

    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
        if (mode === 'breakout') {
            const recent10High = Math.max(...data.slice(-11, -1).map(d => d.high));
            stopLoss = Math.min(last.low, recent10High);
        } else {
            stopLoss = last.low;
        }
    }

    if (stopLoss >= entry) stopLoss = last.low;
    const risk = Math.max(entry - stopLoss, entry * 0.01);
    const takeProfit1 = entry + risk * 1.5;
    const takeProfit2 = entry + risk * 2;
    const riskPct = entry > 0 ? (risk / entry) * 100 : 0;
    return { entry, stopLoss, takeProfit1, takeProfit2, riskPct };
}

function renderPlanCell(plan) {
    if (!plan) return '--';
    return `${plan.takeProfit1.toFixed(2)} <span class="risk-pct">T2 ${plan.takeProfit2.toFixed(2)}</span>`;
}

function renderRiskCell(plan) {
    if (!plan) return '--';
    return `<span class="risk-pct risk-main">-${plan.riskPct.toFixed(1)}%</span><span class="risk-pct">1.5R / 2R</span>`;
}

function checkBreakoutScreenerConditions(data) {
    const last = data[data.length - 1];

    // 1. 長紅K棒：收 > 開，且實體 ≥ 3%
    const bodyPct = (last.close - last.open) / last.open;
    const c1 = last.close > last.open && bodyPct >= 0.03;

    // 2. 成交量翻倍：今日量 > 近20日均量 × 2
    const recentVols = data.slice(-21, -1).map(d => d.volume);
    const avgVol20 = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    const volRatio = avgVol20 > 0 ? last.volume / avgVol20 : 0;
    const c2 = volRatio >= 2;

    // 3. 突破近10日最高點（不含本日）
    const recent10High = Math.max(...data.slice(-11, -1).map(d => d.high));
    const breakoutPct = recent10High > 0 ? ((last.close - recent10High) / recent10High) * 100 : 0;
    const c3 = last.close > recent10High;

    // 4. 均線轉為上揚：MA5 今 > 昨，MA20 今 > 昨
    const closes = data.map(d => d.close);
    const ma5 = calcMA(5, closes);
    const ma20 = calcMA(20, closes);
    const n = closes.length - 1;
    const c4 = parseFloat(ma5[n]) > parseFloat(ma5[n - 1]) &&
               parseFloat(ma20[n]) > parseFloat(ma20[n - 1]);

    const hitCount = [c1, c2, c3, c4].filter(Boolean).length;
    const stopLoss = Math.min(last.low, recent10High);
    const riskPct = last.close > 0 ? ((last.close - stopLoss) / last.close) * 100 : 0;
    return { c1, c2, c3, c4, hitCount, volRatio, breakoutPct, bodyPct, stopLoss, riskPct };
}

function checkSwingScreenerConditions(data) {
    const last = data[data.length - 1];
    const closes = data.map(d => d.close);
    const lows = data.map(d => d.low);
    const highs = data.map(d => d.high);
    const vols = data.map(d => d.volume);
    const ma20 = calcMA(20, closes);
    const ma60 = calcMA(60, closes);
    const n = closes.length - 1;

    const ma20Now = parseFloat(ma20[n]);
    const ma20Prev = parseFloat(ma20[n - 3]);
    const ma60Now = parseFloat(ma60[n]);

    // 1. 趨勢：站上 20MA，且 20MA 上彎；若 20MA > 60MA 額外加分
    const c1 = last.close > ma20Now && ma20Now > ma20Prev;
    const trendBonus = ma20Now > ma60Now;

    // 2. 強勢股：近 20 日曾接近波段新高，避免挑到弱勢反彈
    const recent20High = Math.max(...highs.slice(-21, -1));
    const prior60High = Math.max(...highs.slice(-61, -21));
    const c2 = recent20High >= prior60High * 0.98;

    // 3. 回檔守線：近 5 日低點沒有離 20MA 太遠，回檔幅度小於 8%
    const recent5Low = Math.min(...lows.slice(-5));
    const recent5High = Math.max(...highs.slice(-6, -1));
    const pullbackPct = recent5High > 0 ? ((recent5High - recent5Low) / recent5High) * 100 : 0;
    const holdMa20 = recent5Low >= ma20Now * 0.97;
    const c3 = holdMa20 && pullbackPct <= 8;

    // 4. 轉強：收盤突破近 5 日整理高點（不含本日），且收紅
    const baseHigh5 = Math.max(...highs.slice(-6, -1));
    const breakoutPct = baseHigh5 > 0 ? ((last.close - baseHigh5) / baseHigh5) * 100 : 0;
    const c4 = last.close > baseHigh5 && last.close >= last.open;

    // 5. 量能：今日量至少大於 5 日均量 1.2 倍，20 日均量作為參考
    const avgVol5 = avg(vols.slice(-6, -1));
    const avgVol20 = avg(vols.slice(-21, -1));
    const volRatio = avgVol5 > 0 ? last.volume / avgVol5 : 0;
    const c5 = volRatio >= 1.2 && last.volume >= 1000;

    const hitCount = [c1, c2, c3, c4, c5].filter(Boolean).length;
    const swingScore = Math.round(
        (c1 ? 24 : 0) + (trendBonus ? 8 : 0) + (c2 ? 18 : 0) +
        (c3 ? 20 : 0) + (c4 ? 18 : 0) + (c5 ? 12 : 0)
    );
    const stopLoss = Math.min(last.low, ma20Now, recent5Low);
    const riskPct = last.close > 0 ? ((last.close - stopLoss) / last.close) * 100 : 0;

    return {
        c1, c2, c3, c4, c5, hitCount, trendBonus,
        volRatio, breakoutPct, pullbackPct, avgVol20,
        swingScore, stopLoss, riskPct,
    };
}

function avg(values) {
    const valid = values.filter(v => Number.isFinite(v) && v > 0);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

function getUniverseNote(universeLabel, fullMarketText = '') {
    if (universeLabel === '全市場') return fullMarketText;
    if (universeLabel === '自選清單') return '官方行情源未連上，目前不是完整全市場。';
    return `僅取得${universeLabel}資料，目前不是完整全市場。`;
}
function renderScreenerResults(results, totalScanned, deepChecked, mode = activeScreenerMode, universeLabel = '全市場') {
    document.getElementById('screenerResults').classList.remove('hidden');

    if (mode === 'breakout') {
        renderBreakoutScreenerResults(results, totalScanned, deepChecked, universeLabel);
        return;
    }
    renderSwingScreenerResults(results, totalScanned, deepChecked, universeLabel);
}

function renderSwingScreenerResults(results, totalScanned, deepChecked, universeLabel = '全市場') {
    const summary = document.getElementById('screenerSummary');
    if (results.length === 0) {
        summary.innerHTML =
            `<span class="no-result">${universeLabel}掃描 <strong>${totalScanned}</strong> 支，` +
            `初篩後深度分析 <strong>${deepChecked}</strong> 支，` +
            `未找到同時符合短波段 5 個條件的標的。</span>`;
        document.getElementById('screenerBody').innerHTML =
            '<tr><td colspan="8" class="screener-empty">暫無符合標的，等回檔守線後再轉強</td></tr>';
        return;
    }

    summary.innerHTML =
        `${universeLabel} <strong>${totalScanned}</strong> 支個股，` +
        `初篩後深度分析 <strong>${deepChecked}</strong> 支，` +
        `短波段候選 <strong>${results.length}</strong> 支。` +
        `<span class="risk-note">${getUniverseNote(universeLabel, '停損為技術參考，請自行控管單筆風險。')}</span>`;

    const tbody = document.getElementById('screenerBody');
    tbody.innerHTML = results.map(r => {
        const { code, name, last, changePct, c1, c2, c3, c4, c5, volRatio, breakoutPct, pullbackPct, swingScore, plan } = r;
        const dir = changePct >= 0 ? 'up' : 'down';
        const pSign = changePct >= 0 ? '+' : '';
        const conds = [
            c1 ? '<span class="cond-hit c1">趨勢</span>' : '',
            c2 ? '<span class="cond-hit c2">強勢</span>' : '',
            c3 ? `<span class="cond-hit c3">回檔 ${pullbackPct.toFixed(1)}%</span>` : '',
            c4 ? `<span class="cond-hit c4">突破 +${breakoutPct.toFixed(1)}%</span>` : '',
            c5 ? `<span class="cond-hit c5">量 ${volRatio.toFixed(1)}x</span>` : '',
        ].join('');
        return `
        <tr onclick="quickSearch('${code}')">
            <td class="st-code">${code}</td>
            <td class="st-name">${name}</td>
            <td class="st-price">${plan.entry.toFixed(2)}</td>
            <td class="st-stop">${plan.stopLoss.toFixed(2)}</td>
            <td class="st-target">${renderPlanCell(plan)}</td>
            <td class="st-break">${renderRiskCell(plan)}</td>
            <td class="st-conds"><span class="score-pill">${swingScore}</span>${conds}</td>
            <td><button class="st-goto" onclick="event.stopPropagation();quickSearch('${code}')">查詢</button></td>
        </tr>`;
    }).join('');
}

function renderBreakoutScreenerResults(results, totalScanned, deepChecked, universeLabel = '全市場') {
    const summary = document.getElementById('screenerSummary');
    if (results.length === 0) {
        summary.innerHTML =
            `<span class="no-result">${universeLabel}掃描 <strong>${totalScanned}</strong> 支，` +
            `初篩後深度分析 <strong>${deepChecked}</strong> 支，` +
            `未找到同時符合全部 4 個原本突破條件的標的。</span>`;
        document.getElementById('screenerBody').innerHTML =
            '<tr><td colspan="8" class="screener-empty">暫無符合標的，市場整理期</td></tr>';
        return;
    }

    summary.innerHTML =
        `${universeLabel} <strong>${totalScanned}</strong> 支個股，` +
        `初篩後深度分析 <strong>${deepChecked}</strong> 支，` +
        `符合原本突破條件 <strong>${results.length}</strong> 支。` +
        `<span class="risk-note">${getUniverseNote(universeLabel)}</span>`;

    const tbody = document.getElementById('screenerBody');
    tbody.innerHTML = results.map(r => {
        const { code, name, last, changePct, c1, c2, c3, c4, volRatio, breakoutPct, bodyPct, plan } = r;
        const dir = changePct >= 0 ? 'up' : 'down';
        const pSign = changePct >= 0 ? '+' : '';
        const conds = [
            c1 ? `<span class="cond-hit c1">長紅 +${(bodyPct * 100).toFixed(1)}%</span>` : '',
            c2 ? `<span class="cond-hit c2">量 ${volRatio.toFixed(1)}x</span>` : '',
            c3 ? `<span class="cond-hit c3">突破 +${breakoutPct.toFixed(1)}%</span>` : '',
            c4 ? '<span class="cond-hit c4">均線↑</span>' : '',
        ].join('');
        return `
        <tr onclick="quickSearch('${code}')">
            <td class="st-code">${code}</td>
            <td class="st-name">${name}</td>
            <td class="st-price">${plan.entry.toFixed(2)}</td>
            <td class="st-stop">${plan.stopLoss.toFixed(2)}</td>
            <td class="st-target">${renderPlanCell(plan)}</td>
            <td class="st-break">${renderRiskCell(plan)}</td>
            <td class="st-conds">${conds}</td>
            <td><button class="st-goto" onclick="event.stopPropagation();quickSearch('${code}')">查詢</button></td>
        </tr>`;
    }).join('');
}
// ===== Strategy Backtest =====
let backtestRunning = false;

async function loadMarketUniverse() {
    let allStocks = [];
    let universeLabel = '全市場';
    const [twseRes, tpexRes] = await Promise.allSettled([
        fetchMarketSnapshot(LOCAL_MARKET_API ? '/api/twse' : 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json', '.TW'),
        fetchMarketSnapshot(LOCAL_MARKET_API ? '/api/tpex' : 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', '.TWO'),
    ]);
    const twseStocks = twseRes.status === 'fulfilled' ? twseRes.value : [];
    const tpexStocks = tpexRes.status === 'fulfilled' ? tpexRes.value : [];
    allStocks.push(...twseStocks, ...tpexStocks);
    if (twseStocks.length && !tpexStocks.length) universeLabel = '上市';
    if (!twseStocks.length && tpexStocks.length) universeLabel = '上櫃';

    if (!allStocks.length) {
        universeLabel = '自選清單';
        allStocks = Object.entries(STOCK_DB)
            .filter(([, [, t]]) => t !== 'ETF')
            .map(([code, [name, t]]) => ({
                code, name, suffix: t === '上市' ? '.TW' : '.TWO',
                open: null, close: null, high: null, low: null, volume: 0,
            }));
    }
    return { stocks: allStocks, universeLabel };
}

async function runBacktest() {
    if (backtestRunning) return;
    backtestRunning = true;

    const mode = document.getElementById('backtestMode').value;
    const months = parseInt(document.getElementById('backtestMonths').value, 10);
    const holdDays = parseInt(document.getElementById('backtestHoldDays').value, 10);
    const limitValue = document.getElementById('backtestLimit').value;
    const btn = document.getElementById('backtestBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="screener-btn-icon">⏳</span> 回測中...';
    document.getElementById('backtestProgress').classList.remove('hidden');
    document.getElementById('backtestResults').classList.add('hidden');
    updateBacktestProgress(0, '📡 取得上市櫃清單...');

    try {
        const { stocks, universeLabel } = await loadMarketUniverse();
        const sorted = [...stocks].sort((a, b) => (b.volume || 0) - (a.volume || 0));
        const limit = limitValue === 'all' ? sorted.length : parseInt(limitValue, 10);
        const universe = sorted.slice(0, limit);
        const trades = [];
        const failed = [];
        const batchSize = 8;

        updateBacktestProgress(8, `✅ ${universeLabel} ${stocks.length} 支，回測 ${universe.length} 支...`);

        for (let i = 0; i < universe.length; i += batchSize) {
            const batch = universe.slice(i, i + batchSize);
            const batchTrades = await Promise.all(batch.map(stock => backtestStock(stock, mode, months, holdDays).catch(err => {
                failed.push(stock.code);
                return [];
            })));
            batchTrades.flat().forEach(t => trades.push(t));

            const done = Math.min(i + batchSize, universe.length);
            const pct = 8 + Math.round((done / universe.length) * 92);
            updateBacktestProgress(pct, `🔬 回測 ${done} / ${universe.length}，找到 ${trades.length} 筆訊號...`);
            if (i + batchSize < universe.length) await sleep(80);
        }

        trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
        renderBacktestResults(trades, { mode, months, holdDays, universeLabel, stockCount: universe.length, failedCount: failed.length });
        updateBacktestProgress(100, `🎯 回測完成：${trades.length} 筆訊號`);
    } catch (err) {
        document.getElementById('backtestResults').classList.remove('hidden');
        document.getElementById('backtestMetrics').innerHTML = '';
        document.getElementById('backtestSummary').innerHTML = `<span class="no-result">回測失敗：${escapeHtml(err.message || String(err))}</span>`;
        document.getElementById('backtestBody').innerHTML = '';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="screener-btn-icon">▶</span> 重新回測';
        backtestRunning = false;
    }
}

async function backtestStock(stock, mode, months, holdDays) {
    const data = await fetchYahooHistory(stock.code + stock.suffix, months);
    const minBars = mode === 'swing' ? 65 : 22;
    if (data.length < minBars + holdDays) return [];

    const trades = [];
    for (let i = minBars; i < data.length - holdDays; i++) {
        const windowData = data.slice(0, i + 1);
        const conds = mode === 'breakout'
            ? checkBreakoutScreenerConditions(windowData)
            : checkSwingScreenerConditions(windowData);
        if (conds.hitCount < 4) continue;

        const entry = data[i];
        const exit = data[i + holdDays];
        if (!entry.close || !exit.close) continue;
        const returnPct = ((exit.close - entry.close) / entry.close) * 100;
        trades.push({
            code: stock.code,
            name: stock.name,
            suffix: stock.suffix,
            entryDate: entry.date,
            exitDate: exit.date,
            entryPrice: entry.close,
            exitPrice: exit.close,
            returnPct,
            labels: formatBacktestLabels(conds, mode),
        });
    }
    return trades;
}

function formatBacktestLabels(conds, mode) {
    if (mode === 'breakout') {
        return [
            conds.c1 ? `長紅 +${(conds.bodyPct * 100).toFixed(1)}%` : '',
            conds.c2 ? `量 ${conds.volRatio.toFixed(1)}x` : '',
            conds.c3 ? `突破 +${conds.breakoutPct.toFixed(1)}%` : '',
            conds.c4 ? '均線↑' : '',
        ].filter(Boolean);
    }
    return [
        conds.c1 ? '趨勢' : '',
        conds.c2 ? '強勢' : '',
        conds.c3 ? `回檔 ${conds.pullbackPct.toFixed(1)}%` : '',
        conds.c4 ? `突破 +${conds.breakoutPct.toFixed(1)}%` : '',
        conds.c5 ? `量 ${conds.volRatio.toFixed(1)}x` : '',
    ].filter(Boolean);
}

function updateBacktestProgress(pct, text) {
    document.getElementById('backtestProgressFill').style.width = pct + '%';
    document.getElementById('backtestProgressText').textContent = text;
}

function renderBacktestResults(trades, meta) {
    document.getElementById('backtestResults').classList.remove('hidden');
    const metrics = calculateBacktestMetrics(trades);
    const modeLabel = meta.mode === 'breakout' ? '原本突破' : '短期波段';

    document.getElementById('backtestMetrics').innerHTML = [
        metricCard('訊號數', trades.length.toString()),
        metricCard('勝率', metrics.winRate === null ? '--' : `${metrics.winRate.toFixed(1)}%`),
        metricCard('平均報酬', metrics.avgReturn === null ? '--' : `${formatSigned(metrics.avgReturn)}%`, metrics.avgReturn),
        metricCard('賺賠比', metrics.profitFactor === null ? '--' : metrics.profitFactor.toFixed(2)),
        metricCard('最大回撤', metrics.maxDrawdown === null ? '--' : formatDrawdown(metrics.maxDrawdown), -metrics.maxDrawdown),
    ].join('');

    document.getElementById('backtestSummary').innerHTML =
        `${meta.universeLabel} <strong>${meta.stockCount}</strong> 支，策略 <strong>${modeLabel}</strong>，` +
        `區間 <strong>${meta.months}</strong> 個月，固定持有 <strong>${meta.holdDays}</strong> 日。` +
        `<span class="risk-note">${getUniverseNote(meta.universeLabel, '回測為歷史模擬，未含滑價與交易稅費；投組回撤以同日訊號等權平均估算。')}</span>`;

    const shown = [...trades].sort((a, b) => b.entryDate.localeCompare(a.entryDate)).slice(0, 40);
    document.getElementById('backtestBody').innerHTML = shown.length ? shown.map(t => {
        const dir = t.returnPct >= 0 ? 'up' : 'down';
        return `<tr onclick="quickSearch('${t.code}')">
            <td>${t.entryDate}</td>
            <td class="st-code">${t.code}</td>
            <td class="st-name">${t.name}</td>
            <td class="st-price">${t.entryPrice.toFixed(2)}</td>
            <td class="st-price">${t.exitPrice.toFixed(2)}</td>
            <td class="st-change-${dir}">${formatSigned(t.returnPct)}%</td>
            <td class="st-conds">${t.labels.map(label => `<span class="cond-hit c4">${label}</span>`).join('')}</td>
            <td><button class="st-goto" onclick="event.stopPropagation();quickSearch('${t.code}')">查詢</button></td>
        </tr>`;
    }).join('') : '<tr><td colspan="8" class="screener-empty">沒有找到符合條件的歷史訊號</td></tr>';
}

function calculateBacktestMetrics(trades) {
    if (!trades.length) return { winRate: null, avgReturn: null, profitFactor: null, maxDrawdown: null };
    const returns = trades.map(t => t.returnPct).filter(Number.isFinite);
    const wins = returns.filter(r => r > 0);
    const losses = returns.filter(r => r < 0);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const winRate = (wins.length / returns.length) * 100;
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

    // 將同一天所有訊號視為等權投組，避免把大量重疊訊號誤當成連續全倉複利交易。
    const dailyReturns = Object.values(groupBy(trades, t => t.entryDate))
        .map(dayTrades => avg(dayTrades.map(t => t.returnPct)))
        .filter(Number.isFinite);
    const maxDrawdown = calculateMaxDrawdown(dailyReturns);
    return { winRate, avgReturn, profitFactor, maxDrawdown };
}

function calculateMaxDrawdown(periodReturns) {
    if (!periodReturns.length) return null;
    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    for (const r of periodReturns) {
        equity *= Math.max(0, 1 + r / 100);
        peak = Math.max(peak, equity);
        if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    }
    return maxDrawdown;
}

function groupBy(items, keyFn) {
    return items.reduce((groups, item) => {
        const key = keyFn(item);
        (groups[key] ||= []).push(item);
        return groups;
    }, {});
}

function metricCard(label, value, signedValue = null) {
    const tone = signedValue === null ? '' : signedValue >= 0 ? ' positive' : ' negative';
    return `<div class="metric-card"><span>${label}</span><strong class="${tone}">${value}</strong></div>`;
}

function formatDrawdown(value) {
    if (!Number.isFinite(value) || Math.abs(value) < 0.05) return '0.0%';
    return `-${value.toFixed(1)}%`;
}
function formatSigned(value) {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ===== K-line Chart =====

// ===== Render K-line Chart =====
function renderChart(data, srLevels = { supports: [], resistances: [] }) {
    const chartEl = document.getElementById('klineChart');
    if (!state.chart) {
        state.chart = echarts.init(chartEl, 'dark');
        window.addEventListener('resize', () => state.chart?.resize());
    }

    const dates  = data.map(d => d.date);
    const kline  = data.map(d => [d.open, d.close, d.low, d.high]);
    const vols   = data.map(d => d.volume);
    const closes = data.map(d => d.close);
    
    const ma5    = calcMA(5, closes);
    const ma10   = calcMA(10, closes);
    const ma20   = calcMA(20, closes);
    const ma60   = calcMA(60, closes);

    state.chart.setOption({
        backgroundColor: '#1e293b',
        animation: true,
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
            backgroundColor: '#0f172a',
            borderColor: '#334155',
            textStyle: { color: '#f1f5f9', fontSize: 12 },
        },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        grid: [
            { left: 60, right: 20, top: 16, bottom: 180 },
            { left: 60, right: 20, top: '72%', bottom: 80 },
        ],
        xAxis: [
            { type: 'category', data: dates, gridIndex: 0, scale: true, boundaryGap: false },
            { type: 'category', data: dates, gridIndex: 1, scale: true, boundaryGap: false },
        ],
        yAxis: [
            { scale: true, gridIndex: 0 },
            { scale: true, gridIndex: 1, splitNumber: 2 },
        ],
        dataZoom: [
            { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
            { type: 'slider', xAxisIndex: [0, 1], bottom: 16, height: 24, start: 0, end: 100 },
        ],
        series: [
            {
                name: 'K線', type: 'candlestick',
                xAxisIndex: 0, yAxisIndex: 0, data: kline,
                itemStyle: { color: '#ef4444', color0: '#22c55e', borderColor: '#ef4444', borderColor0: '#22c55e' },
                markLine: {
                    symbol: 'none', silent: true, animation: false,
                    data: [
                        ...srToMarkLine(srLevels.resistances, '#ef4444', '壓', 'insideEndTop'),
                        ...srToMarkLine(srLevels.supports,    '#22c55e', '撐', 'insideEndBottom'),
                    ],
                },
            },
            { name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma5, smooth: false, symbol: 'none', lineStyle: { color: '#f59e0b', width: 1 } },
            { name: 'MA10', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma10, smooth: false, symbol: 'none', lineStyle: { color: '#22d3ee', width: 1 } },
            { name: 'MA20', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma20, smooth: false, symbol: 'none', lineStyle: { color: '#a78bfa', width: 1.2 } },
            { name: 'MA60', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma60, smooth: false, symbol: 'none', lineStyle: { color: '#6366f1', width: 1.5, type: 'dashed' } },
            {
                name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols,
                itemStyle: { color: p => data[p.dataIndex].close >= data[p.dataIndex].open ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)' },
            },
        ],
    }, true);
}

function srToMarkLine(levels, color, prefix, position) {
    return levels.map(l => ({
        yAxis: l.price,
        lineStyle: { color, type: 'dashed', width: 1, opacity: 0.65 },
        label: { formatter: `${prefix} ${l.price}`, color, fontSize: 11, position, backgroundColor: `${color}1f`, padding: [2, 5], borderRadius: 3 },
    }));
}

// ===== Period Change =====
function changePeriod(months, btn) {
    state.chartMonths = months;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (state.ticker) loadChartHistory(months);
}

// ===== Helpers =====
function calcMA(period, data) {
    const result = new Array(data.length);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += data[i];
        if (i >= period) sum -= data[i - period];
        result[i] = i < period - 1 ? '-' : (sum / period).toFixed(2);
    }
    return result;
}

function tsToDate(ts) {
    // Convert Unix timestamp to Taiwan date string (UTC+8)
    const d = new Date((ts + 8 * 3600) * 1000);
    return d.toISOString().slice(0, 10);
}

function roundPrice(n) {
    if (n == null || isNaN(n)) return NaN;
    return Math.round(n * 100) / 100;
}

function calcLimit(prevClose, ratio) {
    return roundPrice(prevClose * ratio).toFixed(2);
}

function fmtVolume(volShares) {
    if (!volShares) return '--';
    const zhang = Math.round(volShares / 1000);
    return zhang.toLocaleString() + ' 張';
}

function setChangeEl(id, text, dir) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = (id === 'changeVal' ? 'change-val ' : 'change-pct ') + dir;
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text ?? '--';
}

function showLoading(on) { toggle('loading', on); }
function showChartLoading(on) { document.getElementById('chartLoading').classList.toggle('active', on); }
function showError(msg) { const e = document.getElementById('errorMsg'); e.textContent = msg; show('errorMsg'); }
function hideError() { hide('errorMsg'); }
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function toggle(id, on) { document.getElementById(id).classList.toggle('hidden', !on); }
function clearRefreshTimer() { if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; } }















