// api/prices.js
// Serverless function (Vercel) that fetches the latest price for a batch of
// symbols and returns them in a single JSON response.
//
// Request:  POST { items: [{ id, ticker, market }] }
//   market: 'th'     -> Thai (SET) stock, e.g. ticker "PTT" or "PTT.BK"
//           'us'      -> Finnhub-supported stock/ETF, e.g. "AAPL"
//           'crypto'  -> crypto symbol, e.g. "BTC" or "BINANCE:BTCUSDT"
//
// Response: { results: [{ id, price }] }  (or { id, error } on failure)

export default async function handler(req, res) {
  // Allow the browser-based app to call this from any origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'ใช้ได้เฉพาะ POST เท่านั้น' });
  }

  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'ต้องส่ง items เป็น array ที่ไม่ว่าง' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: 'ส่งได้ไม่เกิน 50 รายการต่อครั้ง' });
  }

  const results = await Promise.all(items.map(async (item) => {
    try {
      const price = await getPrice(item);
      return { id: item.id, price };
    } catch (err) {
      return { id: item.id, error: err.message || 'ดึงราคาไม่สำเร็จ' };
    }
  }));

  return res.status(200).json({ results });
}

async function getPrice({ ticker, market }) {
  if (market === 'fx') return getFxRate();
  if (!ticker) throw new Error('ไม่มีสัญลักษณ์ (ticker)');
  if (market === 'th') return getThaiPrice(ticker);
  if (market === 'crypto') return getFinnhubPrice(normalizeCrypto(ticker));
  return getFinnhubPrice(ticker.toUpperCase().trim()); // default: 'us' / foreign stock — Finnhub is case-sensitive
}

// --- USD/THB exchange rate ---
// Primary source: Frankfurter (ECB reference rates) — free, no API key needed, CORS-enabled.
// Falls back to Finnhub's forex quote if Frankfurter is unreachable and a Finnhub key is set.
async function getFxRate() {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB');
    if (r.ok) {
      const data = await r.json();
      const rate = data && data.rates && data.rates.THB;
      if (typeof rate === 'number' && rate > 0) return rate;
    }
  } catch (e) {
    // fall through to backup source below
  }

  const key = process.env.FINNHUB_API_KEY;
  if (key) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent('OANDA:USD_THB')}&token=${key}`;
      const r2 = await fetch(url);
      if (r2.ok) {
        const data2 = await r2.json();
        if (data2 && typeof data2.c === 'number' && data2.c > 0) return data2.c;
      }
    } catch (e) {
      // no more fallbacks left
    }
  }

  throw new Error('ไม่พบอัตราแลกเปลี่ยน (ทั้ง Frankfurter และ Finnhub ใช้ไม่ได้)');
}

// --- Finnhub: US stocks, ETFs, forex, crypto (free tier) ---
async function getFinnhubPrice(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('ยังไม่ได้ตั้งค่า FINNHUB_API_KEY');
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub error (${r.status})`);
  const data = await r.json();
  if (!data || typeof data.c !== 'number' || data.c === 0) {
    throw new Error('ไม่พบราคาสำหรับสัญลักษณ์นี้');
  }
  return data.c;
}

function normalizeCrypto(ticker) {
  const t = ticker.toUpperCase();
  if (t.includes(':')) return t; // already fully qualified, e.g. BINANCE:BTCUSDT
  return `BINANCE:${t}USDT`;
}

// --- Thai (SET) stocks ---
// Finnhub's free tier does not cover Thai equities, so this uses Yahoo
// Finance's public (unofficial, undocumented) chart endpoint instead.
// It requires no API key but is not an official/guaranteed API and may
// change or rate-limit without notice. If your app has a Thai brokerage
// account with Settrade Open API access, swap this function out for a
// call to Settrade's official market-data endpoint instead.
async function getThaiPrice(ticker) {
  const symbol = ticker.toUpperCase().endsWith('.BK') ? ticker.toUpperCase() : `${ticker.toUpperCase()}.BK`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo Finance error (${r.status})`);
  const data = await r.json();
  const price = data && data.chart && data.chart.result && data.chart.result[0]
    && data.chart.result[0].meta && data.chart.result[0].meta.regularMarketPrice;
  if (typeof price !== 'number') throw new Error('ไม่พบราคาสำหรับสัญลักษณ์นี้');
  return price;
}
