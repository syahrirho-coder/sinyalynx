// lib/marketdata.js
// "Composite data" layer for crypto pairs, pulled from public endpoints that
// don't need an API key: Binance Futures, Bybit, and OKX (funding rate, open
// interest, long/short ratio, orderbook imbalance) plus CoinGecko (BTC
// dominance). Everything here is best-effort: if a symbol isn't listed on a
// given exchange (e.g. a small-cap alt) the relevant field just comes back
// null and the AI prompt says so instead of a fabricated number.

const BINANCE_FAPI = "https://fapi.binance.com";
const BYBIT_API = "https://api.bybit.com";
const OKX_API = "https://www.okx.com";
const COINGECKO = "https://api.coingecko.com/api/v3";

// Hard per-request timeout so one slow/hanging exchange endpoint can never
// stall the whole composite-data batch and drag the function past Netlify's
// synchronous execution limit (which was surfacing to the frontend as an
// HTML error page -> "Unexpected token '<'" instead of a JSON response).
const FETCH_TIMEOUT_MS = 5000;

async function safeJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Splits a no-slash symbol like "BTCUSDT" into { base: "BTC", quote: "USDT" }.
// Used to build OKX's instId format ("BTC-USDT-SWAP").
const QUOTE_SUFFIXES = ["USDT", "USDC", "BUSD", "USD"];
function splitBaseQuote(symbol) {
  for (const suffix of QUOTE_SUFFIXES) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      return { base: symbol.slice(0, symbol.length - suffix.length), quote: suffix };
    }
  }
  return null;
}

/* ---------------- Binance Futures ---------------- */

// Normalizes user input ("btc", "BTC/USDT", "btcusdt") into a Binance
// Futures perpetual symbol ("BTCUSDT"). Defaults the quote to USDT when the
// user only typed a base asset, since that's the overwhelming majority of
// USDT-M perpetuals on Binance.
function toBinanceFuturesSymbol(raw) {
  const input = String(raw || "").trim().toUpperCase().replace("/", "");
  if (!input) return input;
  const hasQuote = QUOTE_SUFFIXES.some((q) => input.endsWith(q) && input.length > q.length);
  return hasQuote ? input : `${input}USDT`;
}

// Style key (same ones used across the app for TwelveData) -> Binance
// Futures kline interval string.
const BINANCE_FUTURES_KLINE_INTERVALS = {
  m1: "1m",
  m5: "5m",
  m30: "30m",
  scalping: "15m",
  daytrade: "1h",
  swing: "4h",
};

// Candles pulled DIRECTLY from Binance Futures (no TwelveData in the
// middle) — real perpetual price action, no API key needed, no rate-limit
// juggling. This is the primary price source for market:"binance_futures",
// unlike market:"crypto" which goes through TwelveData.
async function fetchFuturesKlines(symbol, interval, limit = 150) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(
      `${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: controller.signal }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Binance Futures klines timeout untuk ${symbol}.`);
    throw new Error(`Gagal mengambil candle Binance Futures untuk ${symbol}: ${err.message}`);
  }
  clearTimeout(timer);

  const json = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(json)) {
    const msg = json && json.msg ? json.msg : `HTTP ${res.status}`;
    throw new Error(`Binance Futures error untuk ${symbol}: ${msg}`);
  }

  return json.map((k) => ({
    time: new Date(k[0]).toISOString(),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

// 24hr rolling ticker — used for the quote preview (price/%change/high/low)
// so the "Analisa Sendiri" preview card shows the same numbers a trader
// would see on Binance itself, not just derived from the candle window.
async function fetch24hrTicker(symbol) {
  const j = await safeJson(`${BINANCE_FAPI}/fapi/v1/ticker/24hr?symbol=${symbol}`);
  if (!j || j.code) return null;
  return {
    lastPrice: Number(j.lastPrice),
    priceChangePercent: Number(j.priceChangePercent),
    highPrice: Number(j.highPrice),
    lowPrice: Number(j.lowPrice),
  };
}

// symbol expected in Binance format, e.g. "BTCUSDT" (no slash).
async function fetchFundingRate(symbol) {
  const j = await safeJson(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
  if (!j || j.code) return null;
  return {
    fundingRate: Number(j.lastFundingRate) * 100, // as %
    markPrice: Number(j.markPrice),
  };
}

async function fetchOpenInterest(symbol) {
  const j = await safeJson(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
  if (!j || j.code) return null;
  return { openInterest: Number(j.openInterest) };
}

async function fetchLongShortRatio(symbol) {
  const j = await safeJson(
    `${BINANCE_FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`
  );
  if (!Array.isArray(j) || j.length === 0) return null;
  const last = j[0];
  return {
    longShortRatio: Number(last.longShortRatio),
    longAccount: Number(last.longAccount) * 100,
    shortAccount: Number(last.shortAccount) * 100,
  };
}

async function fetchOrderbookImbalance(symbol) {
  const j = await safeJson(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${symbol}&limit=50`);
  if (!j || !j.bids || !j.asks) return null;
  const bidVol = j.bids.reduce((s, [, qty]) => s + Number(qty), 0);
  const askVol = j.asks.reduce((s, [, qty]) => s + Number(qty), 0);
  const total = bidVol + askVol;
  if (total === 0) return null;
  return {
    bidVolume: bidVol,
    askVolume: askVol,
    imbalancePct: ((bidVol - askVol) / total) * 100, // positive = buy-side heavier
  };
}

/* ---------------- Bybit (linear perpetual, symbol format same as Binance) ---------------- */

// One call gets both funding rate and open interest for Bybit.
async function fetchBybitTicker(symbol) {
  const j = await safeJson(`${BYBIT_API}/v5/market/tickers?category=linear&symbol=${symbol}`);
  const item = j?.result?.list?.[0];
  if (!item) return null;
  return {
    fundingRate: Number(item.fundingRate) * 100, // as %
    openInterest: Number(item.openInterest),
  };
}

async function fetchBybitOrderbook(symbol) {
  const j = await safeJson(`${BYBIT_API}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`);
  const bids = j?.result?.b;
  const asks = j?.result?.a;
  if (!Array.isArray(bids) || !Array.isArray(asks)) return null;
  const bidVol = bids.reduce((s, [, qty]) => s + Number(qty), 0);
  const askVol = asks.reduce((s, [, qty]) => s + Number(qty), 0);
  const total = bidVol + askVol;
  if (total === 0) return null;
  return { imbalancePct: ((bidVol - askVol) / total) * 100 };
}

async function fetchBybitLongShort(symbol) {
  const j = await safeJson(
    `${BYBIT_API}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=1`
  );
  const item = j?.result?.list?.[0];
  if (!item) return null;
  const buyRatio = Number(item.buyRatio);
  const sellRatio = Number(item.sellRatio);
  if (!Number.isFinite(buyRatio) || !Number.isFinite(sellRatio) || sellRatio === 0) return null;
  return {
    longShortRatio: buyRatio / sellRatio,
    longAccount: buyRatio * 100,
    shortAccount: sellRatio * 100,
  };
}

/* ---------------- OKX (perpetual swap, needs BASE-QUOTE-SWAP instId) ---------------- */

async function fetchOkxFundingAndOI(symbol) {
  const parts = splitBaseQuote(symbol);
  if (!parts) return null;
  const instId = `${parts.base}-${parts.quote}-SWAP`;
  const [fr, oi] = await Promise.all([
    safeJson(`${OKX_API}/api/v5/public/funding-rate?instId=${instId}`),
    safeJson(`${OKX_API}/api/v5/public/open-interest?instId=${instId}`),
  ]);
  const frItem = fr?.data?.[0];
  const oiItem = oi?.data?.[0];
  if (!frItem && !oiItem) return null;
  return {
    fundingRate: frItem ? Number(frItem.fundingRate) * 100 : null, // as %
    openInterest: oiItem ? Number(oiItem.oiCcy || oiItem.oi) : null,
  };
}

async function fetchOkxOrderbook(symbol) {
  const parts = splitBaseQuote(symbol);
  if (!parts) return null;
  const instId = `${parts.base}-${parts.quote}-SWAP`;
  const j = await safeJson(`${OKX_API}/api/v5/market/books?instId=${instId}&sz=50`);
  const item = j?.data?.[0];
  if (!item || !item.bids || !item.asks) return null;
  const bidVol = item.bids.reduce((s, [, qty]) => s + Number(qty), 0);
  const askVol = item.asks.reduce((s, [, qty]) => s + Number(qty), 0);
  const total = bidVol + askVol;
  if (total === 0) return null;
  return { imbalancePct: ((bidVol - askVol) / total) * 100 };
}

async function fetchOkxLongShort(symbol) {
  const parts = splitBaseQuote(symbol);
  if (!parts) return null;
  const j = await safeJson(
    `${OKX_API}/api/v5/rubik-stat/contracts/long-short-account-ratio?ccy=${parts.base}&period=1H`
  );
  const item = j?.data?.[0]; // [timestamp, ratio]
  const ratio = item ? Number(item[1]) : NaN;
  if (!Number.isFinite(ratio)) return null;
  return { longShortRatio: ratio };
}

async function fetchBtcDominance() {
  const j = await safeJson(`${COINGECKO}/global`);
  const pct = j?.data?.market_cap_percentage?.btc;
  if (typeof pct !== "number") return null;
  return { btcDominance: pct };
}

/* ---------------- Solana on-chain DEX data (Meteora) ----------------
 * Meteora's official DLMM API (dlmm.datapi.meteora.ag) is public/keyless —
 * confirmed via its OpenAPI spec (security: []). It's used here ONLY for
 * SOL, as a complement to the Binance/Bybit/OKX derivatives data above:
 * where those show CEX futures positioning (funding/OI/long-short), this
 * shows actual spot DEX liquidity/volume for SOL on-chain, which those
 * exchanges can't see. Jupiter's API is intentionally NOT used — as of
 * Jan 31 2026 api.jup.ag requires a paid API key for every request, so it
 * doesn't fit the "no key needed" composite-data layer this file is built
 * around; wire it in separately if a Jupiter key is ever added.
 */
const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";

async function fetchSolanaOnChainData(base) {
  if (String(base || "").toUpperCase() !== "SOL") return null;

  const j = await safeJson(
    `${METEORA_DLMM_API}/pools?query=SOL&sort_by=tvl:desc&page_size=15&filter_by=is_blacklisted=false`
  );
  const pools = Array.isArray(j?.data) ? j.data : [];
  if (pools.length === 0) return null;

  // Keep only genuine SOL paired against a USD stablecoin (SOL/USDC or
  // SOL/USDT) — the raw "SOL" text search also returns unrelated
  // SOL-ticker-adjacent pools — then take the deepest one by TVL as the
  // representative on-chain venue.
  const isStable = (sym) => ["USDC", "USDT"].includes(String(sym || "").toUpperCase());
  const solUsdPools = pools.filter((p) => {
    const xSym = p.token_x?.symbol;
    const ySym = p.token_y?.symbol;
    const hasSol = String(xSym).toUpperCase() === "SOL" || String(ySym).toUpperCase() === "SOL";
    const hasStable = isStable(xSym) || isStable(ySym);
    return hasSol && hasStable && !p.is_blacklisted;
  });
  const pool = solUsdPools[0];
  if (!pool) return null;

  const v = pool.volume || {};
  const f = pool.fees || {};
  const ftv = pool.fee_tvl_ratio || {};
  // Momentum read: is trading activity accelerating or cooling off right
  // now, vs. the day's average? Compare the hourly run-rate (1h * 24) to
  // the actual 24h volume — same idea as the CEX momentum-kline block
  // above, just for on-chain DEX flow instead of CEX price action.
  const vol1hRunRate = typeof v["1h"] === "number" ? v["1h"] * 24 : null;
  const volumeTrend =
    vol1hRunRate != null && typeof v["24h"] === "number" && v["24h"] > 0
      ? vol1hRunRate / v["24h"]
      : null;

  return {
    source: "Meteora DLMM (Solana)",
    poolName: pool.name,
    poolAddress: pool.address,
    tvlUsd: pool.tvl,
    currentPrice: pool.current_price,
    createdAt: pool.created_at,
    apr24h: pool.apr,
    apy24h: pool.apy,
    dynamicFeePct: pool.dynamic_fee_pct,
    hasFarm: pool.has_farm,
    farmApr: pool.farm_apr,
    volume: { m30: v["30m"], h1: v["1h"], h4: v["4h"], h24: v["24h"] },
    fees: { h1: f["1h"], h4: f["4h"], h24: f["24h"] },
    feeTvlRatio: { h1: ftv["1h"], h24: ftv["24h"] },
    volumeTrendVsDailyAvg: volumeTrend,
    cumulativeVolume: pool.cumulative_metrics?.volume ?? null,
    cumulativeFees: pool.cumulative_metrics?.fees ?? null,
    tokenX: pool.token_x
      ? {
          symbol: pool.token_x.symbol,
          holders: pool.token_x.holders,
          marketCap: pool.token_x.market_cap,
          isVerified: pool.token_x.is_verified,
        }
      : null,
    tokenY: pool.token_y
      ? {
          symbol: pool.token_y.symbol,
          holders: pool.token_y.holders,
          marketCap: pool.token_y.market_cap,
          isVerified: pool.token_y.is_verified,
        }
      : null,
  };
}

/* ---------------- Solana buy/sell pressure (DexPaprika, replaces Birdeye) ----------------
 * Birdeye required a paid-tier API key (BIRDEYE_API_KEY) with no keyless
 * option. Replaced with DexPaprika (api.dexpaprika.com) — fully keyless,
 * ~10k requests/day on the shared public tier. DexPaprika only has
 * POOL-level buy/sell aggregates (no per-wallet breakdown), so this is
 * labeled "buy/sell pressure" rather than "wallet flow" — see
 * lib/dexpaprika.js for the full explanation. Birdeye's separate
 * token-security endpoint (mint/freeze authority, holder concentration)
 * has no DexPaprika equivalent and was dropped rather than faked; risk
 * context for memecoins now comes from on-chain liquidity/pair-age checks
 * in lib/memecoin.js plus the optional GMGN block (lib/gmgn.js).
 */
const { fetchDexPaprikaPoolFlow, fetchSolanaFlow: fetchSolanaFlowFromDexPaprika } = require("./dexpaprika");

// Thin wrapper kept for the existing "native SOL inside the crypto market"
// call site in fetchCompositeData below — unchanged call site, new source.
async function fetchSolanaWalletFlow(base) {
  if (String(base || "").toUpperCase() !== "SOL") return null;
  return fetchSolanaFlowFromDexPaprika();
}

// Generalized version, usable for ANY Solana pool address — used by
// lib/memecoin.js for gmgn.ai-style memecoins (pump.fun launches, small
// Solana tokens). Takes a POOL address (DexScreener's `pairAddress`), not a
// token mint address — DexPaprika's pool endpoint is keyed by pool, not by
// token.
async function fetchWalletFlowForMint(poolAddress, opts = {}) {
  return fetchDexPaprikaPoolFlow(poolAddress, opts);
}

/* ---------------- Liquidation pressure (estimated) ----------------
 * Binance retired the public GET /fapi/v1/allForceOrders endpoint (raw
 * liquidation orders), and no exchange exposes aggregate liquidation data
 * over plain REST anymore — it's WebSocket-only (!forceOrder@arr), which
 * doesn't fit a stateless per-request serverless function. So instead of
 * faking a "$X liquidated" number we don't actually have, this estimates
 * liquidation *pressure* from something Binance still gives us for free:
 * a sharp Open Interest drop happening alongside a directional price move
 * is the signature of a liquidation flush (positions force-closed, OI
 * falls, price gets pushed further in that direction). It's a proxy, not
 * a ground-truth liquidation feed — the prompt text says so explicitly.
 */
async function fetchLiquidationPressure(symbol) {
  const [oiHist, klines] = await Promise.all([
    safeJson(`${BINANCE_FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=7`),
    safeJson(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=7`),
  ]);
  if (!Array.isArray(oiHist) || oiHist.length < 2 || !Array.isArray(klines) || klines.length < 2) {
    return null;
  }

  const oiFirst = Number(oiHist[0].sumOpenInterest);
  const oiLast = Number(oiHist[oiHist.length - 1].sumOpenInterest);
  if (!oiFirst) return null;
  const oiChangePct = ((oiLast - oiFirst) / oiFirst) * 100;

  const priceFirst = Number(klines[0][1]); // open of first candle
  const priceLast = Number(klines[klines.length - 1][4]); // close of last candle
  if (!priceFirst) return null;
  const priceChangePct = ((priceLast - priceFirst) / priceFirst) * 100;

  const windowMinutes = oiHist.length * 5;
  const oiDropMagnitude = Math.abs(oiChangePct);

  let magnitude = "rendah";
  if (oiDropMagnitude > 5) magnitude = "tinggi";
  else if (oiDropMagnitude > 2) magnitude = "sedang";

  // Only call it a liquidation-style flush when OI actually contracted
  // meaningfully; OI rising just means fresh positions opening, not forced closes.
  let bias = "netral";
  if (oiChangePct < -1.5) {
    bias = priceChangePct < 0 ? "long_liq" : "short_liq";
  }

  return {
    windowMinutes,
    oiChangePct,
    priceChangePct,
    bias, // "long_liq" | "short_liq" | "netral"
    magnitude, // "rendah" | "sedang" | "tinggi"
  };
}

/* ---------------- News (crypto, via CryptoCompare's free public feed) ---------------- */

const CRYPTOCOMPARE_NEWS = "https://min-api.cryptocompare.com/data/v2/news/";

// Coarse keyword screen for "this could actually move the market" news vs
// routine coin-specific chatter. Not sentiment analysis — just a trigger so
// the AI knows when a fresh, high-impact headline lines up with a real price
// move (i.e. this isn't background noise, it's a live catalyst).
const HIGH_IMPACT_KEYWORDS = [
  "fed", "federal reserve", "interest rate", "rate cut", "rate hike", "fomc",
  "cpi", "inflation", "sec", "lawsuit", "sues", "sued", "regulation", "ban",
  "etf", "approval", "approved", "reject", "hack", "hacked", "exploit",
  "breach", "halving", "delist", "delisting", "bankrupt", "bankruptcy",
  "liquidat", "crash", "plunge", "surge", "all-time high", "ath",
  "tariff", "war", "sanction", "shutdown", "default", "stablecoin depeg",
  "depeg", "outage", "downtime",
];

function isHighImpact(title) {
  const t = String(title || "").toLowerCase();
  return HIGH_IMPACT_KEYWORDS.some((kw) => t.includes(kw));
}

async function fetchNews(rawBase, limit = 5) {
  const base = String(rawBase || "").toUpperCase();
  if (!base) return null;

  // First try filtering by CryptoCompare's category taxonomy (works for
  // majors like BTC/ETH/SOL). If that comes back empty (small-cap coin not
  // in their category list), fall back to the general latest feed and
  // filter client-side by whether the coin ticker/name shows up.
  let items = await safeJson(
    `${CRYPTOCOMPARE_NEWS}?lang=EN&categories=${encodeURIComponent(base)}&sortOrder=latest`
  );
  let articles = Array.isArray(items?.Data) ? items.Data : [];

  if (articles.length === 0) {
    const general = await safeJson(`${CRYPTOCOMPARE_NEWS}?lang=EN&sortOrder=latest`);
    const all = Array.isArray(general?.Data) ? general.Data : [];
    if (all.length === 0) return null; // feed itself failed/unreachable
    articles = all.filter((a) => {
      const tags = `${a.title || ""} ${a.categories || ""}`.toUpperCase();
      return tags.includes(base);
    });
  }

  const nowSec = Date.now() / 1000;
  const mapped = articles.slice(0, limit).map((a) => ({
    title: a.title,
    source: a.source_info?.name || a.source || "n/a",
    ageMinutes: a.published_on ? Math.max(0, Math.round((nowSec - a.published_on) / 60)) : null,
    url: a.url,
    highImpact: isHighImpact(a.title),
  }));

  return { articles: mapped };
}

/* ---------------- Momentum (multi-timeframe) + major-news cross-check ----------------
 * Pulls short-term % price change over a few windows from Binance klines, and
 * flags when a high-impact headline landed recently AND price is actually
 * moving hard in that same window — i.e. distinguishes "there's a headline"
 * from "there's a headline AND the market is actually reacting to it right now".
 */
async function fetchMomentumKlines(symbol) {
  return safeJson(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=61`);
}

// Pure computation over already-fetched klines + news — no network I/O, so
// this can run synchronously right after the parallel batch resolves instead
// of firing its own fetch afterwards (which used to add a second sequential
// round trip on top of the composite batch).
function buildMomentum(klines, news) {
  if (!Array.isArray(klines) || klines.length < 2) return null;

  const closeAt = (minutesAgo) => {
    const idx = klines.length - 1 - minutesAgo;
    return idx >= 0 ? Number(klines[idx][4]) : null;
  };
  const last = Number(klines[klines.length - 1][4]);
  const pctChange = (past) => (past ? ((last - past) / past) * 100 : null);

  const m5 = pctChange(closeAt(5));
  const m15 = pctChange(closeAt(15));
  const h1 = pctChange(closeAt(60));

  // Strongest short-term move wins for the "is this a momentum burst" check.
  const strongestAbs = Math.max(...[m5, m15].filter((v) => v !== null).map(Math.abs), 0);
  const burst = strongestAbs > 1.5; // >1.5% within 15 min = notable burst

  let majorNewsWindow = null;
  const highImpactArticles = (news?.articles || []).filter((a) => a.highImpact);
  const freshHighImpact = highImpactArticles.find((a) => a.ageMinutes !== null && a.ageMinutes <= 120);
  if (freshHighImpact) {
    majorNewsWindow = {
      article: freshHighImpact.title,
      ageMinutes: freshHighImpact.ageMinutes,
      coincidesWithBurst: burst,
    };
  }

  return { m5, m15, h1, burst, majorNewsWindow };
}



// Runs every composite-data fetch (Binance, Bybit, OKX, CoinGecko) in
// parallel and returns only the ones that succeeded — never throws, since
// this layer is an enhancement, not a requirement, for producing a signal.
async function fetchCompositeData(rawSymbol) {
  const symbol = String(rawSymbol || "").toUpperCase().replace("/", "");
  const base = splitBaseQuote(symbol)?.base || symbol;

  const [
    funding,
    oi,
    longShort,
    orderbook,
    dominance,
    bybitTicker,
    bybitOrderbook,
    bybitLongShort,
    okxFundingOI,
    okxOrderbook,
    okxLongShort,
    liquidation,
    news,
    momentumKlines,
    onChain,
    walletFlow,
  ] = await Promise.all([
    fetchFundingRate(symbol),
    fetchOpenInterest(symbol),
    fetchLongShortRatio(symbol),
    fetchOrderbookImbalance(symbol),
    fetchBtcDominance(),
    fetchBybitTicker(symbol),
    fetchBybitOrderbook(symbol),
    fetchBybitLongShort(symbol),
    fetchOkxFundingAndOI(symbol),
    fetchOkxOrderbook(symbol),
    fetchOkxLongShort(symbol),
    fetchLiquidationPressure(symbol),
    fetchNews(base),
    fetchMomentumKlines(symbol),
    fetchSolanaOnChainData(base),
    fetchSolanaWalletFlow(base),
  ]);

  // Pure sync computation now — the klines fetch already ran inside the
  // batch above, so this no longer adds a second sequential round trip.
  const momentum = buildMomentum(momentumKlines, news);

  return {
    liquidation,
    news,
    momentum,
    onChain,
    walletFlow,
    baseSymbol: base,
    // Binance Futures (kept at top level, unchanged shape for backward compat)
    funding,
    openInterest: oi,
    longShort,
    orderbook,
    dominance,
    // Bybit
    bybit: {
      funding: bybitTicker ? { fundingRate: bybitTicker.fundingRate } : null,
      openInterest: bybitTicker ? { openInterest: bybitTicker.openInterest } : null,
      orderbook: bybitOrderbook,
      longShort: bybitLongShort,
    },
    // OKX
    okx: {
      funding: okxFundingOI && okxFundingOI.fundingRate !== null ? { fundingRate: okxFundingOI.fundingRate } : null,
      openInterest:
        okxFundingOI && okxFundingOI.openInterest !== null ? { openInterest: okxFundingOI.openInterest } : null,
      orderbook: okxOrderbook,
      longShort: okxLongShort,
    },
  };
}

module.exports = {
  toBinanceFuturesSymbol,
  BINANCE_FUTURES_KLINE_INTERVALS,
  fetchFuturesKlines,
  fetch24hrTicker,
  fetchFundingRate,
  fetchOpenInterest,
  fetchLongShortRatio,
  fetchOrderbookImbalance,
  fetchBtcDominance,
  fetchBybitTicker,
  fetchBybitOrderbook,
  fetchBybitLongShort,
  fetchOkxFundingAndOI,
  fetchOkxOrderbook,
  fetchOkxLongShort,
  fetchLiquidationPressure,
  fetchNews,
  fetchMomentumKlines,
  buildMomentum,
  fetchSolanaOnChainData,
  fetchSolanaWalletFlow,
  fetchWalletFlowForMint,
  fetchCompositeData,
};
