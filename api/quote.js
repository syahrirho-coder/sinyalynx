// api/quote.js — GET /api/quote?symbol=BTCUSDT&market=crypto
const { tdFetch, toTwelveDataSymbol } = require("../lib/twelvedata");
const { resolveMemecoinToken, fetchMemecoinOhlcv, MEME_STYLE_INTERVALS } = require("../lib/memecoin");
const { toBinanceFuturesSymbol, fetchFuturesKlines, fetch24hrTicker } = require("../lib/marketdata");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  try {
    const params = req.query || {};
    const rawSymbol = params.symbol;
    const market = String(params.market || "crypto").toLowerCase();
    if (!rawSymbol) {
      return json(res, 400, { error: "Parameter 'symbol' wajib diisi." });
    }

    if (market === "memecoin") {
      return json(res, 200, await buildMemecoinQuote(rawSymbol));
    }

    if (market === "binance_futures") {
      return json(res, 200, await buildBinanceFuturesQuote(rawSymbol));
    }

    const symbol = toTwelveDataSymbol(rawSymbol, market);
    const extraParams = market === "crypto" ? { exchange: "Binance" } : {};

    const [quote, series] = await Promise.all([
      tdFetch("quote", { symbol, ...extraParams }),
      tdFetch("time_series", { symbol, interval: "15min", outputsize: "60", ...extraParams }),
    ]);

    const candles = (series.values || [])
      .slice()
      .reverse()
      .map((v) => ({
        time: v.datetime,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
      }));

    const price = Number(quote.close);
    if (!Number.isFinite(price)) {
      throw new Error(`TwelveData tidak mengembalikan data harga untuk ${symbol}. Coba simbol lain atau cek nama pair-nya.`);
    }

    return json(res, 200, {
      symbol: rawSymbol.toUpperCase(),
      td_symbol: quote.symbol || symbol,
      exchange: quote.exchange || null,
      price,
      percent_change: Number(quote.percent_change) || 0,
      high: Number(quote.high),
      low: Number(quote.low),
      timestamp: quote.datetime || null,
      candles,
    });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
};

// Preview quote for the "memecoin" market — resolves via DexScreener then
// pulls a short GeckoTerminal candle window (15min bars) for the mini chart.
async function buildMemecoinQuote(rawSymbol) {
  const token = await resolveMemecoinToken(rawSymbol);
  const ohlcv = await fetchMemecoinOhlcv(token.pairAddress, { ...MEME_STYLE_INTERVALS.m5, limit: 60 });

  if (!Number.isFinite(token.priceUsd)) {
    throw new Error(`DexScreener tidak mengembalikan harga untuk ${token.baseToken.symbol}. Coba ticker lain atau cek alamat token-nya.`);
  }

  const highs = ohlcv.map((c) => c.high).filter(Number.isFinite);
  const lows = ohlcv.map((c) => c.low).filter(Number.isFinite);

  return {
    symbol: rawSymbol.toUpperCase(),
    td_symbol: `${token.baseToken.symbol}/${token.quoteToken.symbol}`,
    exchange: `${token.dexId} (Solana)`,
    price: token.priceUsd,
    percent_change: token.priceChange.h24 ?? 0,
    high: highs.length ? Math.max(...highs) : token.priceUsd,
    low: lows.length ? Math.min(...lows) : token.priceUsd,
    timestamp: null,
    liquidity_warning: token.liquidityWarning || null,
    candles: ohlcv.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
  };
}

// Preview quote for the "binance_futures" market.
async function buildBinanceFuturesQuote(rawSymbol) {
  const symbol = toBinanceFuturesSymbol(rawSymbol);
  const [ticker, candles] = await Promise.all([fetch24hrTicker(symbol), fetchFuturesKlines(symbol, "15m", 60)]);

  const price = ticker ? ticker.lastPrice : candles[candles.length - 1]?.close;
  if (!Number.isFinite(price)) {
    throw new Error(`Binance Futures tidak mengembalikan harga untuk ${symbol}. Coba simbol lain (mis. BTCUSDT).`);
  }

  return {
    symbol: rawSymbol.toUpperCase(),
    td_symbol: symbol,
    exchange: "Binance Futures",
    price,
    percent_change: ticker ? ticker.priceChangePercent : 0,
    high: ticker ? ticker.highPrice : Math.max(...candles.map((c) => c.high)),
    low: ticker ? ticker.lowPrice : Math.min(...candles.map((c) => c.low)),
    timestamp: null,
    candles: candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
  };
}

function json(res, statusCode, body) {
  res.status(statusCode).setHeader("content-type", "application/json").send(JSON.stringify(body));
}
