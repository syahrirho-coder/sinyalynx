// lib/indicators.js
// Small dependency-free technical indicator helpers.
// Candles are expected oldest -> newest, each { open, high, low, close } as numbers.

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
  }
  return emaPrev;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

function swingHigh(candles, lookback = 40) {
  const slice = candles.slice(-lookback);
  return Math.max(...slice.map((c) => c.high));
}

function swingLow(candles, lookback = 40) {
  const slice = candles.slice(-lookback);
  return Math.min(...slice.map((c) => c.low));
}

// Consecutive up/down candle momentum count, useful narrative signal.
function momentumStreak(candles) {
  let streak = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const dir = candles[i].close >= candles[i - 1].close ? 1 : -1;
    if (streak === 0) streak = dir;
    else if (Math.sign(streak) === dir) streak += dir;
    else break;
  }
  return streak;
}

// MACD (12,26,9) via successive EMA series, not just single-point EMA.
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValues = macdLine.filter((v) => v !== null);
  const signalSeries = emaSeries(macdValues, signalPeriod);
  const signal = signalSeries[signalSeries.length - 1];
  const macdVal = macdValues[macdValues.length - 1];
  if (signal === null || signal === undefined) return null;
  return { macd: macdVal, signal, histogram: macdVal - signal };
}

function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

function stochastic(candles, period = 14, smooth = 3) {
  if (candles.length < period + smooth) return null;
  const kValues = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));
    const close = candles[i].close;
    kValues.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }
  const k = kValues[kValues.length - 1];
  const d = kValues.slice(-smooth).reduce((a, b) => a + b, 0) / Math.min(smooth, kValues.length);
  return { k, d };
}

// Simplified ADX (Wilder's smoothing), measures trend strength 0-100.
function adx(candles, period = 14) {
  if (candles.length < period * 2) return null;
  const plusDM = [];
  const minusDM = [];
  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trList.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }
  const smooth = (arr, p) => {
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [sum];
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      out.push(sum);
    }
    return out;
  };
  const trS = smooth(trList, period);
  const plusS = smooth(plusDM, period);
  const minusS = smooth(minusDM, period);
  const len = Math.min(trS.length, plusS.length, minusS.length);
  const dxList = [];
  for (let i = 0; i < len; i++) {
    const plusDI = trS[i] === 0 ? 0 : (plusS[i] / trS[i]) * 100;
    const minusDI = trS[i] === 0 ? 0 : (minusS[i] / trS[i]) * 100;
    const sum = plusDI + minusDI;
    dxList.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }
  const last = dxList.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

// VWAP over the whole candle window. Returns null when the data source
// (e.g. TwelveData forex) doesn't include volume — reported as n/a to Claude
// rather than silently using a wrong formula.
function vwap(candles) {
  const hasVolume = candles.some((c) => typeof c.volume === "number" && c.volume > 0);
  if (!hasVolume) return null;
  let pvSum = 0;
  let vSum = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pvSum += typical * v;
    vSum += v;
  }
  return vSum === 0 ? null : pvSum / vSum;
}

function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  return {
    price: closes[closes.length - 1],
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema100: ema(closes, Math.min(100, closes.length - 1)),
    rsi14: rsi(closes, 14),
    atr14: atr(candles, 14),
    swingHigh24: swingHigh(candles, Math.min(96, candles.length)),
    swingLow24: swingLow(candles, Math.min(96, candles.length)),
    momentumStreak: momentumStreak(candles),
    macd: macd(closes),
    bollinger: bollingerBands(closes, 20, 2),
    stochastic: stochastic(candles, 14, 3),
    adx14: adx(candles, 14),
    vwap: vwap(candles),
    candleCount: candles.length,
  };
}

module.exports = {
  ema,
  rsi,
  atr,
  swingHigh,
  swingLow,
  momentumStreak,
  macd,
  bollingerBands,
  stochastic,
  adx,
  vwap,
  computeIndicators,
};
