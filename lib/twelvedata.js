// lib/twelvedata.js
// TwelveData client with rotation across up to 10 API keys.
// Keys are read from env vars TD_API_KEY_1 .. TD_API_KEY_10.
// On rate-limit / credit-exhausted / invalid-key responses, the next key is tried
// automatically until one succeeds or all keys are exhausted.

const BASE_URL = "https://api.twelvedata.com";

function getKeys() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`TD_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  // Fallback: allow a single comma-separated TD_API_KEYS var too.
  if (keys.length === 0 && process.env.TD_API_KEYS) {
    process.env.TD_API_KEYS.split(",").forEach((k) => {
      if (k.trim()) keys.push(k.trim());
    });
  }
  return keys;
}

// Rotate the starting key by current minute so load spreads evenly across keys
// instead of always hammering key #1 first.
function rotatedKeyOrder(keys) {
  if (keys.length === 0) return keys;
  const offset = Math.floor(Date.now() / 60000) % keys.length;
  return keys.slice(offset).concat(keys.slice(0, offset));
}

function isRetryableError(json) {
  if (!json) return true;
  // TwelveData error shape: { code: 429 | 401 | 403 | 400, status: "error", message: "..." }
  if (json.status === "error" || json.code) {
    const code = Number(json.code);
    // 429 = rate limited / out of credits, 401/403 = bad key -> try next key.
    if (code === 429 || code === 401 || code === 403) return true;
    const msg = (json.message || "").toLowerCase();
    if (msg.includes("api credits") || msg.includes("run out") || msg.includes("limit")) {
      return true;
    }
  }
  return false;
}

// TwelveData sometimes answers with HTTP 200 + status:"ok" but a "shell"
// object that has no actual price data (open/high/low/close all null) —
// typically when the symbol/exchange combo has no data on the current plan.
// Treat that the same as a retryable error so we try the next key/exchange
// instead of silently returning nulls to the frontend.
function isEmptyShellResponse(path, json) {
  if (!json || json.status === "error") return false;
  if (path === "quote") {
    return json.close === null || json.close === undefined;
  }
  if (path === "time_series") {
    return !Array.isArray(json.values) || json.values.length === 0;
  }
  return false;
}
// Hard per-attempt timeout. Keys used to be tried strictly one-by-one, so a
// slow/hanging key multiplied its delay by however many keys came before it
// in the rotation — easily blowing past Netlify's synchronous function
// timeout and sending the frontend an HTML error page instead of JSON
// ("Unexpected token '<'"). Attempts now fire in parallel (same pattern as
// lib/groq.js) and each one is bounded on its own.
const FETCH_TIMEOUT_MS = 6000;

// One attempt against a single key. Resolves with the parsed json on
// success, rejects (with a labeled Error) on any failure so Promise.any()
// in tdFetchOnce just moves on to whichever other key answers first.
// `nonRetryable` errors (bad symbol etc, same on every key) are thrown with
// a special marker so the caller can surface that message directly instead
// of the generic "all keys failed" aggregate.
async function attemptTdKey(path, params, key, keyIndex, signal) {
  const qs = new URLSearchParams({ ...params, apikey: key });
  const url = `${BASE_URL}/${path}?${qs.toString()}`;

  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`key #${keyIndex + 1} network error: ${err.message}`);
  }
  const json = await res.json().catch(() => null);

  if (isRetryableError(json)) {
    throw new Error(json?.message || `TwelveData tidak mengembalikan data untuk simbol ini (key #${keyIndex + 1})`);
  }

  // A genuine TD error that ISN'T a key/rate-limit problem (e.g. code 400
  // "symbol not found") — this will fail the same way on every other key
  // too, so retrying is pointless. Mark it so the caller can throw it
  // immediately with TD's real message instead of the generic aggregate.
  if (json && (json.status === "error" || json.code)) {
    const err = new Error(
      `TwelveData error untuk "${params.symbol}"${params.exchange ? ` (exchange: ${params.exchange})` : ""}: ${
        json.message || `kode ${json.code}`
      }`
    );
    err.tdCode = Number(json.code) || null;
    err.tdMessage = json.message || "";
    err.nonRetryable = true;
    throw err;
  }

  if (isEmptyShellResponse(path, json)) {
    throw new Error(json?.message || `TwelveData tidak mengembalikan data untuk simbol ini (key #${keyIndex + 1})`);
  }

  return json;
}

/**
 * Call a TwelveData endpoint, trying all configured keys in parallel and
 * returning whichever succeeds first.
 * @param {string} path e.g. "quote", "time_series"
 * @param {Record<string,string>} params query params (without apikey)
 */
async function tdFetchOnce(path, params) {
  const keys = getKeys();
  if (keys.length === 0) {
    throw new Error("Tidak ada TwelveData API key yang dikonfigurasi (TD_API_KEY_1..TD_API_KEY_10).");
  }

  const order = rotatedKeyOrder(keys);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const attempts = order.map((key, i) => attemptTdKey(path, params, key, i, controller.signal));

  try {
    const result = await Promise.any(attempts);
    controller.abort(); // cancel whichever other key requests are still in flight
    return result;
  } catch (aggregateErr) {
    const errors = aggregateErr.errors || [aggregateErr];
    // A non-retryable error (bad symbol, etc.) fails identically on every
    // key — surface that real message instead of the generic aggregate.
    const nonRetryable = errors.find((e) => e?.nonRetryable);
    if (nonRetryable) throw nonRetryable;

    const messages = errors.map((e) => e?.message).filter(Boolean).join(" | ");
    throw new Error(`Semua ${order.length} TwelveData API key/kombinasi gagal atau tidak ada data. Error terakhir: ${messages || "unknown"}`);
  } finally {
    clearTimeout(timer);
  }
}

// Some TD plans/symbols reject the combo of a crypto `symbol` + `exchange`
// filter with a generic "symbol or figi parameter is missing or invalid"
// error even though symbol IS present — the exchange filter is what's
// actually rejected. If that specific case happens, retry once without
// `exchange` before giving up, since the plain symbol usually still works
// (TD just picks its own default/aggregated exchange for the pair).
async function tdFetch(path, params) {
  try {
    return await tdFetchOnce(path, params);
  } catch (err) {
    const msg = (err.tdMessage || err.message || "").toLowerCase();
    const rejectedSymbolParam = msg.includes("symbol") && (msg.includes("missing") || msg.includes("invalid"));
    if (params.exchange && rejectedSymbolParam) {
      const { exchange, ...rest } = params;
      try {
        return await tdFetchOnce(path, rest);
      } catch (err2) {
        throw err2;
      }
    }
    throw err;
  }
}

// Known quote currencies/assets, longest first, used to split a pair typed
// without a slash (e.g. "BTCUSDT" -> "BTC/USDT", "XAUUSD" -> "XAU/USD").
const QUOTE_SUFFIXES = ["USDT", "BUSD", "USDC", "IDR", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "XAU", "XAG"];

// Quote currencies TwelveData treats as USD-equivalent for crypto: TD does
// not index "BTC/USDT" as its own symbol — it indexes "BTC/USD" and lists
// Binance as one of the exchanges backing that price (Binance's own feed is
// in USDT, but TD abstracts that to USD). Sending symbol=BTC/USDT with
// exchange=Binance is therefore an invalid combo on TD's side even though
// the symbol looks reasonable — it needs to be BTC/USD instead.
const CRYPTO_STABLE_QUOTES = ["USDT", "BUSD", "USDC"];

function normalizeCryptoQuote(symbol, market) {
  if (market !== "crypto" || !symbol.includes("/")) return symbol;
  const [base, quote] = symbol.split("/");
  return CRYPTO_STABLE_QUOTES.includes(quote) ? `${base}/USD` : symbol;
}

function toTwelveDataSymbol(raw, market) {
  const input = String(raw || "").trim().toUpperCase();
  if (!input) return input;
  if (input.includes("/")) return normalizeCryptoQuote(input, market);
  if (market === "saham") return input; // e.g. AAPL, MSFT — used as-is

  for (const suffix of QUOTE_SUFFIXES) {
    if (input.endsWith(suffix) && input.length > suffix.length) {
      const base = input.slice(0, input.length - suffix.length);
      return normalizeCryptoQuote(`${base}/${suffix}`, market);
    }
  }
  return input;
}

// Map trading style -> TwelveData interval + how many candles to pull.
const STYLE_INTERVALS = {
  m1: { interval: "1min", outputsize: 150, label: "M1" },
  m5: { interval: "5min", outputsize: 150, label: "M5" },
  m30: { interval: "30min", outputsize: 150, label: "M30" },
  scalping: { interval: "15min", outputsize: 150, label: "M15" },
  daytrade: { interval: "1h", outputsize: 150, label: "H1" },
  swing: { interval: "4h", outputsize: 150, label: "H4" },
};

module.exports = { tdFetch, toTwelveDataSymbol, STYLE_INTERVALS, getKeys };
