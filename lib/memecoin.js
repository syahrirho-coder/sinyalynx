// lib/memecoin.js
// Support for "gmgn.ai style" memecoins: small/new Solana tokens (pump.fun
// launches, etc.) not listed on Binance/Bybit/OKX and with no TwelveData
// price feed. Keyless public endpoints only:
//   - DexScreener: resolve a ticker/name/contract address -> the Solana
//     pair with the deepest liquidity that also clears a minimum
//     liquidity + minimum pair-age bar (see resolveMemecoinToken below —
//     this is the fix for pools that used to surface a token that was
//     too new / too thin to trade safely).
//   - GeckoTerminal OHLCV API: candle data for the resolved pool, same
//     shape indicators.js already expects from every other market.
//   - DexPaprika (lib/dexpaprika.js): pool-level buy/sell pressure,
//     replacing Birdeye's wallet-level top-trader feed (see the honesty
//     note in lib/dexpaprika.js for exactly what changed).

const { fetchDexPaprikaPoolFlow } = require("./dexpaprika");
const { fetchGmgnTokenSecurity } = require("./gmgn"); // optional, opt-in via GMGN_API_KEY, unrelated to the Birdeye swap

const DEXSCREENER_API = "https://api.dexscreener.com";
const GECKOTERMINAL_API = "https://api.geckoterminal.com/api/v2";
const FETCH_TIMEOUT_MS = 6000;

// A candidate pool must clear BOTH of these to be picked without a warning.
// Override via env vars if these defaults are too strict/loose for your
// audience. This is the direct fix for "selalu muncul token yang terlalu
// baru / belum cukup liquid": before, the code just took the highest-
// liquidity Solana pair returned by DexScreener with NO floor at all, so a
// $400-liquidity pool from 20 minutes ago could win if it was literally the
// only match for that ticker.
const MIN_LIQUIDITY_USD = Number(process.env.MEMECOIN_MIN_LIQUIDITY_USD) || 15000;
const MIN_PAIR_AGE_MINUTES = Number(process.env.MEMECOIN_MIN_AGE_MINUTES) || 60;

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

// Base58 Solana address: 32-44 chars, alphabet excludes 0/O/I/l.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Map trading style -> GeckoTerminal OHLCV params ({timeframe, aggregate}).
// GeckoTerminal's OHLCV endpoint takes a base timeframe (day/hour/minute)
// plus an aggregate multiplier, unlike TwelveData's plain interval string.
const MEME_STYLE_INTERVALS = {
  m1: { timeframe: "minute", aggregate: 1, limit: 150, label: "M1" },
  m5: { timeframe: "minute", aggregate: 5, limit: 150, label: "M5" },
  m30: { timeframe: "minute", aggregate: 15, limit: 150, label: "M15" },
  scalping: { timeframe: "hour", aggregate: 1, limit: 150, label: "H1" },
  daytrade: { timeframe: "hour", aggregate: 4, limit: 150, label: "H4" },
  swing: { timeframe: "hour", aggregate: 12, limit: 150, label: "H12" },
};

function pairAgeMinutes(pairCreatedAt) {
  if (!pairCreatedAt) return null;
  const ms = Date.now() - Number(pairCreatedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms / 60000 : null;
}

function passesLiquidityAndAge(p) {
  const liq = Number(p.liquidity?.usd) || 0;
  const ageMin = pairAgeMinutes(p.pairCreatedAt);
  return liq >= MIN_LIQUIDITY_USD && (ageMin === null || ageMin >= MIN_PAIR_AGE_MINUTES);
}

// Picks the best Solana candidate: prefer pairs that clear BOTH the
// liquidity and age floor (sorted by liquidity desc among those); only if
// NONE clear the bar does this fall back to the single highest-liquidity
// pair overall, clearly flagged so the caller can warn the user instead of
// silently presenting a thin/fresh pool as if it were vetted.
function pickBestSolanaPair(pairs) {
  const solPairs = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p.chainId === "solana");
  if (solPairs.length === 0) return null;
  solPairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));

  const qualified = solPairs.filter(passesLiquidityAndAge);
  if (qualified.length > 0) return { pair: qualified[0], passedFilter: true };
  return { pair: solPairs[0], passedFilter: false };
}

function normalizePair(p) {
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId || "unknown DEX",
    url: p.url || null,
    chainId: "solana",
    baseToken: {
      address: p.baseToken?.address || null,
      name: p.baseToken?.name || p.baseToken?.symbol || "",
      symbol: p.baseToken?.symbol || "",
    },
    quoteToken: {
      address: p.quoteToken?.address || null,
      symbol: p.quoteToken?.symbol || "",
    },
    priceUsd: p.priceUsd !== undefined ? Number(p.priceUsd) : null,
    liquidityUsd: p.liquidity?.usd !== undefined ? Number(p.liquidity.usd) : null,
    fdvUsd: p.fdv !== undefined ? Number(p.fdv) : null,
    marketCapUsd: p.marketCap !== undefined ? Number(p.marketCap) : null,
    volume: {
      m5: p.volume?.m5 !== undefined ? Number(p.volume.m5) : null,
      h1: p.volume?.h1 !== undefined ? Number(p.volume.h1) : null,
      h6: p.volume?.h6 !== undefined ? Number(p.volume.h6) : null,
      h24: p.volume?.h24 !== undefined ? Number(p.volume.h24) : null,
    },
    priceChange: {
      m5: p.priceChange?.m5 !== undefined ? Number(p.priceChange.m5) : null,
      h1: p.priceChange?.h1 !== undefined ? Number(p.priceChange.h1) : null,
      h6: p.priceChange?.h6 !== undefined ? Number(p.priceChange.h6) : null,
      h24: p.priceChange?.h24 !== undefined ? Number(p.priceChange.h24) : null,
    },
    pairCreatedAt: p.pairCreatedAt || null,
  };
}

// Resolve a user-typed ticker/name ("WIF", "popcat") OR a pasted Solana
// contract/mint address into a concrete DexScreener pair that clears the
// liquidity + age bar above (falling back to the best available pair,
// flagged, if truly nothing clears it).
async function resolveMemecoinToken(rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) throw new Error("Simbol/token memecoin kosong.");

  let pairs = null;

  if (SOLANA_ADDRESS_RE.test(query)) {
    const j = await safeJson(`${DEXSCREENER_API}/latest/dex/tokens/${encodeURIComponent(query)}`);
    pairs = j?.pairs || null;
  }

  if (!pairs || pairs.length === 0) {
    const j = await safeJson(`${DEXSCREENER_API}/latest/dex/search?q=${encodeURIComponent(query)}`);
    pairs = j?.pairs || null;
  }

  const picked = pickBestSolanaPair(pairs);
  if (!picked) {
    throw new Error(
      `Token/pair "${query}" tidak ditemukan di DexScreener (chain Solana). Coba ticker lain atau paste langsung alamat mint token-nya.`
    );
  }
  const token = normalizePair(picked.pair);
  return {
    ...token,
    liquidityWarning: picked.passedFilter
      ? null
      : `Likuiditas pool ini hanya $${Math.round(token.liquidityUsd || 0).toLocaleString(
          "en-US"
        )} dan/atau umurnya masih di bawah ${MIN_PAIR_AGE_MINUTES} menit — di bawah ambang batas aman ($${MIN_LIQUIDITY_USD.toLocaleString(
          "en-US"
        )}, ${MIN_PAIR_AGE_MINUTES} menit). Ini kemungkinan token yang SANGAT baru/tipis; risiko rug dan slippage ekstrem jauh lebih tinggi dari biasanya.`,
  };
}

// OHLCV candles for the resolved pool, in {time,open,high,low,close,volume}
// shape lib/indicators.js already expects. Sourced from GeckoTerminal's
// public OHLCV endpoint (keyless).
async function fetchMemecoinOhlcv(poolAddress, styleCfg) {
  const cfg = styleCfg || MEME_STYLE_INTERVALS.scalping;
  const j = await safeJson(
    `${GECKOTERMINAL_API}/networks/solana/pools/${poolAddress}/ohlcv/${cfg.timeframe}?aggregate=${cfg.aggregate}&limit=${cfg.limit}&currency=usd`
  );
  const rows = j?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return [];
  // GeckoTerminal returns [timestamp_seconds, open, high, low, close, volume], newest first.
  return rows
    .map((r) => ({
      time: new Date(Number(r[0]) * 1000).toISOString(),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close))
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

// Composite object shaped to match what public/index.html's compositeHTML()
// already knows how to render (onChain + walletFlow blocks), so no
// frontend changes are needed for the memecoin market to display properly.
function buildMemecoinComposite(token, flow, gmgn) {
  const v = token.volume;
  const vol1hRunRate = typeof v.h1 === "number" ? v.h1 * 24 : null;
  const volumeTrend = vol1hRunRate != null && typeof v.h24 === "number" && v.h24 > 0 ? vol1hRunRate / v.h24 : null;

  return {
    baseSymbol: token.baseToken.symbol,
    onChain: {
      source: `DexScreener (${token.dexId}, Solana)`,
      label: `DexScreener (${token.dexId}, Solana)`,
      poolName: `${token.baseToken.symbol}/${token.quoteToken.symbol}`,
      poolAddress: token.pairAddress,
      url: token.url,
      tvlUsd: token.liquidityUsd,
      currentPrice: token.priceUsd,
      fdvUsd: token.fdvUsd,
      marketCapUsd: token.marketCapUsd,
      pairCreatedAt: token.pairCreatedAt,
      volume: { m5: v.m5, h1: v.h1, h4: v.h6, h24: v.h24 },
      priceChange: token.priceChange,
      feeTvlRatio: { h1: null, h24: null },
      apr24h: null,
      farmApr: null,
      hasFarm: false,
      dynamicFeePct: null,
      volumeTrendVsDailyAvg: volumeTrend,
      liquidityWarning: token.liquidityWarning || null,
      tokenX: {
        symbol: token.baseToken.symbol,
        holders: null,
        marketCap: token.marketCapUsd ?? token.fdvUsd,
        isVerified: null,
      },
      tokenY: { symbol: token.quoteToken.symbol, holders: null, marketCap: null, isVerified: null },
    },
    walletFlow: flow, // still named walletFlow for frontend compatibility, but is POOL-level buy/sell pressure now (see lib/dexpaprika.js)
    gmgn,
  };
}

function fmt(n, digits = 4) {
  return n === null || n === undefined || Number.isNaN(n) ? "n/a" : Number(n).toFixed(digits);
}

function pairAgeText(pairCreatedAt) {
  const ageMin = pairAgeMinutes(pairCreatedAt);
  if (ageMin === null) return "n/a";
  if (ageMin < 60) return `${ageMin.toFixed(0)} menit`;
  const hours = ageMin / 60;
  if (hours < 24) return `${hours.toFixed(1)} jam`;
  return `${(hours / 24).toFixed(1)} hari`;
}

// Text block fed to the AI prompt.
function buildMemecoinCompositeText(composite) {
  const oc = composite.onChain;
  const lines = [];

  lines.push(`--- On-Chain DEX (Solana, via ${oc.source}) ---`);
  lines.push(`Pool: ${oc.poolName} (dex: ${oc.poolAddress ? oc.poolAddress.slice(0, 4) + "..." + oc.poolAddress.slice(-4) : "n/a"}).`);
  lines.push(`Harga saat ini: $${fmt(oc.currentPrice, 8)}. Likuiditas pool: $${fmt(oc.tvlUsd, 0)}.`);
  lines.push(`Market Cap: $${fmt(oc.marketCapUsd, 0)}, FDV (Fully Diluted Valuation): $${fmt(oc.fdvUsd, 0)}.`);
  lines.push(`Umur pair (sejak pool dibuat): ${pairAgeText(oc.pairCreatedAt)}.`);
  lines.push(
    `Volume: 5 menit $${fmt(oc.volume.m5, 0)}, 1 jam $${fmt(oc.volume.h1, 0)}, 4 jam $${fmt(oc.volume.h4, 0)}, 24 jam $${fmt(oc.volume.h24, 0)}.`
  );
  lines.push(
    `Perubahan harga: 5 menit ${fmt(oc.priceChange.m5, 2)}%, 1 jam ${fmt(oc.priceChange.h1, 2)}%, 6 jam ${fmt(oc.priceChange.h6, 2)}%, 24 jam ${fmt(oc.priceChange.h24, 2)}%.`
  );
  if (oc.volumeTrendVsDailyAvg != null) {
    const trend = oc.volumeTrendVsDailyAvg;
    lines.push(
      `Momentum volume: run-rate 1 jam terakhir (diproyeksi 24 jam) adalah ${fmt(trend * 100, 0)}% dari volume 24 jam aktual — ${
        trend > 1.3 ? "aktivitas trading sedang MENINGKAT tajam." : trend < 0.7 ? "aktivitas trading sedang MELAMBAT." : "aktivitas trading relatif stabil."
      }`
    );
  }
  if (oc.liquidityWarning) {
    lines.push(`PERINGATAN LIKUIDITAS: ${oc.liquidityWarning}`);
  }
  lines.push(
    "Catatan risiko: ini token memecoin Solana on-chain (kemungkinan baru/kapitalisasi kecil) — likuiditas bisa tipis dan slippage besar, harga sangat volatile, dan risiko rug/scam nyata terutama jika umur pair masih sangat muda atau likuiditas sangat kecil relatif ke volume."
  );

  const wf = composite.walletFlow;
  if (wf) {
    lines.push(`--- Tekanan Beli/Jual Pool (via ${wf.source}) ---`);
    const h24 = wf.timeframes?.h24;
    const h1 = wf.timeframes?.h1;
    if (h24) {
      lines.push(
        `24 jam: volume beli $${fmt(h24.buyUsd, 0)}, volume jual $${fmt(h24.sellUsd, 0)} (${h24.buys ?? "n/a"} tx beli vs ${h24.sells ?? "n/a"} tx jual). Net: ${h24.netUsd >= 0 ? "+" : ""}$${fmt(h24.netUsd, 0)} (${h24.netUsd > 0 ? "net tekanan BELI" : h24.netUsd < 0 ? "net tekanan JUAL" : "seimbang"}).`
      );
    }
    if (h1) {
      lines.push(`1 jam terakhir: beli $${fmt(h1.buyUsd, 0)} vs jual $${fmt(h1.sellUsd, 0)}.`);
    }
    lines.push(
      "Catatan: ini agregat tekanan beli/jual di level POOL (bukan data per-wallet individual) — pakai sebagai indikasi arah minat pasar, bukan kepastian arah harga."
    );
  } else {
    lines.push("--- Tekanan Beli/Jual Pool ---");
    lines.push("n/a (DexPaprika belum mengindeks pool ini, atau gagal diambil).");
  }

  const g = composite.gmgn;
  if (g) {
    lines.push("--- Analisis Risiko GMGN (opsional) ---");
    lines.push(`Rug ratio (skor risiko rug): ${g.rugRatioPercent != null ? g.rugRatioPercent.toFixed(1) + "%" : "n/a"}.`);
    lines.push(`Bundler wallet (beli serentak pas launch, indikasi insider): ${g.bundlerPercent != null ? g.bundlerPercent.toFixed(1) + "%" : "n/a"} dari volume.`);
    lines.push(`Sniper wallet (bot beli detik pertama): ${g.sniperCount != null ? g.sniperCount + " wallet" : "n/a"}.`);
    lines.push(`Insider/rat trader: ${g.insiderPercent != null ? g.insiderPercent.toFixed(1) + "%" : "n/a"} dari volume.`);
    lines.push(`Wash trading terdeteksi: ${g.isWashTrading === true ? "YA (waspada, volume bisa palsu)" : g.isWashTrading === false ? "tidak" : "n/a"}.`);
    if (g.isHoneypot === true) lines.push("PERINGATAN: token ini terdeteksi sebagai honeypot (kemungkinan tidak bisa dijual).");
  }
  // If GMGN isn't configured (no GMGN_API_KEY), the section is simply
  // omitted rather than printing a wall of "n/a" for an optional feature.

  return lines.join("\n");
}

async function fetchMemecoinData(rawQuery, style) {
  const token = await resolveMemecoinToken(rawQuery);
  const styleCfg = MEME_STYLE_INTERVALS[style] || MEME_STYLE_INTERVALS.scalping;
  const [candles, flow, gmgn] = await Promise.all([
    fetchMemecoinOhlcv(token.pairAddress, styleCfg),
    fetchDexPaprikaPoolFlow(token.pairAddress, { label: `Tekanan Beli/Jual ${token.baseToken.symbol} 24 jam (DexPaprika)` }),
    fetchGmgnTokenSecurity(token.baseToken.address),
  ]);
  const composite = buildMemecoinComposite(token, flow, gmgn);
  return { token, styleCfg, candles, composite };
}

module.exports = {
  MEME_STYLE_INTERVALS,
  MIN_LIQUIDITY_USD,
  MIN_PAIR_AGE_MINUTES,
  resolveMemecoinToken,
  fetchMemecoinOhlcv,
  buildMemecoinComposite,
  buildMemecoinCompositeText,
  fetchMemecoinData,
};
