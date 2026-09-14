// lib/dexpaprika.js
// Replaces Birdeye (which required BIRDEYE_API_KEY, no free tier) with
// DexPaprika (https://api.dexpaprika.com) — keyless, ~10,000 req/day on the
// shared public tier, no signup needed.
//
// IMPORTANT HONESTY NOTE: DexPaprika does NOT expose per-wallet trade data
// the way Birdeye's `top_traders` endpoint did. It only has POOL-level
// aggregates (buy/sell USD volume + txn counts per timeframe). So this is
// NOT a like-for-like swap of "wallet flow" — there is no individual
// wallet address, tag, or net-position data anymore. What we build instead
// is a "buy/sell pressure" indicator: for each timeframe, how much USD
// flowed in via buys vs. out via sells on that pool. That's still a
// genuinely useful directional signal (and multi-timeframe, which Birdeye's
// single 24h snapshot wasn't) — it's just not wallet-level. Every place
// that renders this now says "Tekanan Beli/Jual" (buy/sell pressure), not
// "Wallet Flow", so the AI prompt and the UI don't overstate what the data
// actually is.
//
// Token-level security/risk (mint authority, holder concentration, etc.)
// that Birdeye's /defi/token_security used to provide has NO DexPaprika
// equivalent — DexPaprika doesn't do holder/authority analysis. That
// section is dropped rather than faked; lib/memecoin.js's on-chain
// liquidity/age checks plus the optional GMGN risk block (lib/gmgn.js,
// unrelated to this file, opt-in via GMGN_API_KEY) cover risk instead.

const DEXPAPRIKA_API = "https://api.dexpaprika.com";
const FETCH_TIMEOUT_MS = 6000;

// A deep, long-running Raydium CLMM SOL/USDC pool on Solana — used as the
// reference pool for "native SOL" buy/sell pressure (the composite panel
// shown for market=crypto, base=SOL). Override via env var if you'd rather
// point at a different pool (e.g. a specific SOL/USDT pool).
const DEFAULT_SOL_USDC_POOL = process.env.DEXPAPRIKA_SOL_POOL || "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

async function safeJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function windowMetrics(w) {
  if (!w) return null;
  const buyUsd = num(w.buy_usd);
  const sellUsd = num(w.sell_usd);
  return {
    buyUsd,
    sellUsd,
    netUsd: buyUsd != null && sellUsd != null ? buyUsd - sellUsd : null,
    buys: w.buys ?? null,
    sells: w.sells ?? null,
    txns: w.txns ?? null,
    volumeUsd: num(w.volume_usd),
    priceChangePercent: num(w.last_price_usd_change),
  };
}

/**
 * Buy/sell pressure for a single on-chain pool, across DexPaprika's
 * standard timeframe buckets. `network` is a DexPaprika network slug
 * (e.g. "solana"). `poolAddress` is the pool's on-chain address (the SAME
 * address DexScreener calls `pairAddress`).
 */
async function fetchDexPaprikaPoolFlow(poolAddress, opts = {}) {
  if (!poolAddress) return null;
  const network = opts.network || "solana";
  const j = await safeJson(`${DEXPAPRIKA_API}/networks/${network}/pools/${poolAddress}`);
  if (!j) return null;

  const timeframes = {
    m5: windowMetrics(j["5m"]),
    h1: windowMetrics(j["1h"]),
    h6: windowMetrics(j["6h"]),
    h24: windowMetrics(j["24h"]),
  };

  const h24 = timeframes.h24;
  return {
    source: "DexPaprika Pool Flow",
    label: opts.label || "Tekanan Beli/Jual 24 jam (DexPaprika)",
    network,
    poolAddress,
    dexName: j.dex_name || j.dex_id || null,
    priceUsd: num(j.last_price_usd),
    timeframes,
    netFlowUsd24h: h24 ? h24.netUsd : null,
    buysVsSells24h: h24 && h24.buys != null && h24.sells != null ? { buys: h24.buys, sells: h24.sells } : null,
  };
}

/** Convenience wrapper for the native-SOL composite panel (market=crypto). */
async function fetchSolanaFlow(opts = {}) {
  return fetchDexPaprikaPoolFlow(DEFAULT_SOL_USDC_POOL, {
    network: "solana",
    label: opts.label || "Tekanan Beli/Jual SOL 24 jam (DexPaprika, pool SOL/USDC)",
  });
}

/**
 * Basic pool snapshot (liquidity/volume/txns) — used by the memecoin AI
 * Scout to cross-check a DexScreener candidate against a second, independent
 * data source before it's ever shown to the AI or the user.
 */
async function fetchDexPaprikaPoolSnapshot(poolAddress, network = "solana") {
  const j = await safeJson(`${DEXPAPRIKA_API}/networks/${network}/pools/${poolAddress}`);
  if (!j) return null;
  return {
    priceUsd: num(j.last_price_usd),
    dexName: j.dex_name || j.dex_id || null,
    h24: windowMetrics(j["24h"]),
    h1: windowMetrics(j["1h"]),
    h6: windowMetrics(j["6h"]),
  };
}

module.exports = {
  fetchDexPaprikaPoolFlow,
  fetchSolanaFlow,
  fetchDexPaprikaPoolSnapshot,
  DEFAULT_SOL_USDC_POOL,
};
