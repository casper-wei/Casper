const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 8787);

const apiTargets = {
  '/api/twse': 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json',
  '/api/tpex': 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  '/api/value-twse': 'https://www.twse.com.tw/exchangeReport/BWIBBU_ALL?response=json',
  '/api/value-tpex': 'https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json',
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function proxyJson(res, target) {
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'CasperLocalProxy/1.0' },
    });
    if (!upstream.ok) {
      send(res, upstream.status, JSON.stringify({ error: `Upstream HTTP ${upstream.status}` }), 'application/json; charset=utf-8');
      return;
    }
    const text = await upstream.text();
    const body = target.includes('STOCK_DAY_ALL') ? normalizeTwseStockDayAll(text) : text;
    send(res, 200, body, 'application/json; charset=utf-8');
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), 'application/json; charset=utf-8');
  }
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

function normalizeTwseStockDayAll(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text;

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return JSON.stringify({ data: [] });

  const rows = lines.slice(1).map(parseCsvLine)
    .filter(row => row.length >= 11)
  const data = rows.map(row => [
      row[1], // code
      row[2], // name
      row[3], // trade volume
      row[4], // trade value
      row[5], // open
      row[6], // high
      row[7], // low
      row[8], // close
      row[9], // change
      row[10], // transaction
    ]);

  return JSON.stringify({ data, date: rows[0]?.[0] || '' });
}


async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, body, mimeTypes[ext] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }
  if (url.pathname === '/api/yahoo') {
    const ticker = url.searchParams.get('ticker');
    const range = url.searchParams.get('range') || '6mo';
    const interval = url.searchParams.get('interval') || '1d';
    if (!ticker || !/^[A-Za-z0-9.]+$/.test(ticker)) {
      send(res, 400, JSON.stringify({ error: 'Invalid ticker' }), 'application/json; charset=utf-8');
      return;
    }
    const target = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    await proxyJson(res, target);
    return;
  }
  if (apiTargets[url.pathname]) {
    await proxyJson(res, apiTargets[url.pathname]);
    return;
  }
  await serveStatic(req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Casper local server: http://127.0.0.1:${port}`);
});

