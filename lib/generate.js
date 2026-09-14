// lib/generate.js
const { tdFetch, toTwelveDataSymbol, STYLE_INTERVALS } = require("./twelvedata");
const { computeIndicators } = require("./indicators");
const {
  fetchCompositeData,
  toBinanceFuturesSymbol,
  BINANCE_FUTURES_KLINE_INTERVALS,
  fetchFuturesKlines,
} = require("./marketdata");
const { callGroq, SIGNAL_JSON_SPEC } = require("./groq");
const { fetchMemecoinData, buildMemecoinCompositeText } = require("./memecoin");

function fmt(n, digits = 4) {
  return n === null || n === undefined || Number.isNaN(n) ? "n/a" : Number(n).toFixed(digits);
}

function buildIndicatorText(ind) {
  const lines = [
    `Harga saat ini: ${ind.price}`,
    `EMA20: ${fmt(ind.ema20)}`,
    `EMA50: ${fmt(ind.ema50)}`,
    `EMA100: ${fmt(ind.ema100)}`,
    `RSI14: ${fmt(ind.rsi14, 1)}`,
    `ATR14: ${fmt(ind.atr14)}`,
    `Swing high (rentang data): ${fmt(ind.swingHigh24)}`,
    `Swing low (rentang data): ${fmt(ind.swingLow24)}`,
    `Momentum streak candle terakhir: ${ind.momentumStreak}`,
    `MACD: ${ind.macd ? `line ${fmt(ind.macd.macd)}, signal ${fmt(ind.macd.signal)}, histogram ${fmt(ind.macd.histogram)}` : "n/a"}`,
    `Bollinger Bands (20,2): ${ind.bollinger ? `upper ${fmt(ind.bollinger.upper)}, middle ${fmt(ind.bollinger.middle)}, lower ${fmt(ind.bollinger.lower)}` : "n/a"}`,
    `Stochastic (14,3): ${ind.stochastic ? `%K ${fmt(ind.stochastic.k, 1)}, %D ${fmt(ind.stochastic.d, 1)}` : "n/a"}`,
    `ADX14 (kekuatan tren): ${fmt(ind.adx14, 1)}`,
    `VWAP: ${ind.vwap ? fmt(ind.vwap) : "n/a (data volume tidak tersedia dari sumber harga)"}`,
    `Jumlah candle dianalisa: ${ind.candleCount}`,
  ];
  return lines.join("\n");
}

function buildCompositeText(composite) {
  if (!composite) return "Data komposit (funding rate/OI/long-short/orderbook/dominasi BTC): tidak diambil untuk market ini.";
  const lines = [];

  lines.push("--- Binance Futures ---");
  lines.push(
    composite.funding
      ? `Funding Rate (per 8 jam): ${fmt(composite.funding.fundingRate, 4)}% — ${composite.funding.fundingRate > 0 ? "long membayar short (bias crowd long)" : "short membayar long (bias crowd short)"}`
      : "Funding Rate: n/a (pair tidak terdaftar di Binance Futures atau data gagal diambil)"
  );
  lines.push(
    composite.openInterest
      ? `Open Interest: ${composite.openInterest.openInterest.toLocaleString("en-US")} kontrak`
      : "Open Interest: n/a"
  );
  lines.push(
    composite.longShort
      ? `Long/Short Account Ratio (1h, akun retail): ${fmt(composite.longShort.longShortRatio, 2)} (long ${fmt(composite.longShort.longAccount, 1)}% vs short ${fmt(composite.longShort.shortAccount, 1)}%)`
      : "Long/Short Ratio: n/a"
  );
  lines.push(
    composite.orderbook
      ? `Orderbook Imbalance (top 50 level): ${fmt(composite.orderbook.imbalancePct, 1)}% ${composite.orderbook.imbalancePct > 0 ? "condong ke sisi beli (bid)" : "condong ke sisi jual (ask)"}`
      : "Orderbook Imbalance: n/a"
  );

  lines.push("--- Bybit ---");
  lines.push(
    composite.bybit?.funding
      ? `Funding Rate (per 8 jam): ${fmt(composite.bybit.funding.fundingRate, 4)}%`
      : "Funding Rate: n/a (pair tidak terdaftar di Bybit Futures atau data gagal diambil)"
  );
  lines.push(
    composite.bybit?.openInterest
      ? `Open Interest: ${composite.bybit.openInterest.openInterest.toLocaleString("en-US")} kontrak`
      : "Open Interest: n/a"
  );
  lines.push(
    composite.bybit?.longShort
      ? `Long/Short Account Ratio (1h): ${fmt(composite.bybit.longShort.longShortRatio, 2)} (long ${fmt(composite.bybit.longShort.longAccount, 1)}% vs short ${fmt(composite.bybit.longShort.shortAccount, 1)}%)`
      : "Long/Short Ratio: n/a"
  );
  lines.push(
    composite.bybit?.orderbook
      ? `Orderbook Imbalance (top 50 level): ${fmt(composite.bybit.orderbook.imbalancePct, 1)}% ${composite.bybit.orderbook.imbalancePct > 0 ? "condong ke sisi beli (bid)" : "condong ke sisi jual (ask)"}`
      : "Orderbook Imbalance: n/a"
  );

  lines.push("--- OKX ---");
  lines.push(
    composite.okx?.funding
      ? `Funding Rate (per 8 jam): ${fmt(composite.okx.funding.fundingRate, 4)}%`
      : "Funding Rate: n/a (pair tidak terdaftar di OKX Swap atau data gagal diambil)"
  );
  lines.push(
    composite.okx?.openInterest
      ? `Open Interest: ${composite.okx.openInterest.openInterest.toLocaleString("en-US")} kontrak/koin`
      : "Open Interest: n/a"
  );
  lines.push(
    composite.okx?.longShort
      ? `Long/Short Account Ratio (1h): ${fmt(composite.okx.longShort.longShortRatio, 2)}`
      : "Long/Short Ratio: n/a"
  );
  lines.push(
    composite.okx?.orderbook
      ? `Orderbook Imbalance (top 50 level): ${fmt(composite.okx.orderbook.imbalancePct, 1)}% ${composite.okx.orderbook.imbalancePct > 0 ? "condong ke sisi beli (bid)" : "condong ke sisi jual (ask)"}`
      : "Orderbook Imbalance: n/a"
  );

  lines.push("--- Lainnya ---");
  lines.push(
    composite.dominance
      ? `BTC Dominance (seluruh market crypto): ${fmt(composite.dominance.btcDominance, 1)}%`
      : "BTC Dominance: n/a"
  );

  lines.push("--- Estimasi Tekanan Liquidation ---");
  if (composite.liquidation) {
    const liq = composite.liquidation;
    const biasText =
      liq.bias === "long_liq"
        ? "indikasi LONG LIQUIDATION (posisi long dipaksa tutup, menekan harga turun)"
        : liq.bias === "short_liq"
        ? "indikasi SHORT LIQUIDATION (posisi short dipaksa tutup/short squeeze, menekan harga naik)"
        : "netral, tidak ada tanda flush liquidation signifikan";
    lines.push(
      `Window ${liq.windowMinutes} menit terakhir (Binance Futures): perubahan Open Interest ${fmt(liq.oiChangePct, 2)}%, perubahan harga ${fmt(liq.priceChangePct, 2)}%, magnitude ${liq.magnitude}, bias: ${biasText}.`
    );
    lines.push(
      "Catatan: ini ESTIMASI dari perubahan Open Interest + harga, BUKAN data liquidation order asli (Binance sudah mematikan endpoint publik untuk itu). Jangan sebut angka dolar liquidation spesifik, karena kita tidak punya angka itu."
    );
  } else {
    lines.push("Estimasi Liquidation: n/a (data Open Interest history/kline gagal diambil untuk pair ini)");
  }

  lines.push("--- Berita Terbaru ---");
  if (composite.news && Array.isArray(composite.news.articles) && composite.news.articles.length > 0) {
    composite.news.articles.forEach((a, i) => {
      const age = a.ageMinutes !== null && a.ageMinutes !== undefined ? `${a.ageMinutes} menit lalu` : "waktu n/a";
      const tag = a.highImpact ? " [BERITA BESAR]" : "";
      lines.push(`${i + 1}. [${a.source}, ${age}]${tag} ${a.title}`);
    });
  } else if (composite.news) {
    lines.push("Tidak ada berita spesifik untuk koin ini dalam waktu dekat.");
  } else {
    lines.push("Berita: n/a (feed berita gagal diambil)");
  }

  lines.push("--- Momentum & Katalis Berita ---");
  if (composite.momentum) {
    const mom = composite.momentum;
    lines.push(
      `Perubahan harga: 5 menit ${fmt(mom.m5, 2)}%, 15 menit ${fmt(mom.m15, 2)}%, 1 jam ${fmt(mom.h1, 2)}%.`
    );
    lines.push(mom.burst ? "Status: sedang terjadi BURST MOMENTUM (>1.5% dalam 15 menit terakhir)." : "Status: pergerakan harga normal, tidak ada burst momentum.");
    if (mom.majorNewsWindow) {
      const mnw = mom.majorNewsWindow;
      lines.push(
        `Berita besar terdeteksi ${mnw.ageMinutes} menit lalu: "${mnw.article}". ${
          mnw.coincidesWithBurst
            ? "Momentum harga saat ini SEJALAN dengan berita ini — kemungkinan besar ini adalah penggerak (catalyst) utama pergerakan harga saat ini, beri bobot lebih tinggi pada arah pergerakan ini."
            : "Namun harga belum menunjukkan reaksi kuat — pasar mungkin belum sepenuhnya pricing-in berita ini, atau berita ini kurang berdampak dari perkiraan."
        }`
      );
    } else {
      lines.push("Tidak ada berita berdampak besar (macro/regulasi/hack/dll) dalam 2 jam terakhir.");
    }
  } else {
    lines.push("Momentum: n/a (data kline 1m gagal diambil)");
  }

  // Only present for SOL — on-chain DEX liquidity/volume from Meteora,
  // complementing the CEX derivatives data above with actual on-chain
  // spot activity those exchanges can't see.
  if (composite.onChain) {
    const oc = composite.onChain;
    lines.push("--- Data On-Chain DEX (Solana, via Meteora) ---");
    lines.push(
      `Pool utama: ${oc.poolName} — TVL $${fmt(oc.tvlUsd, 0)}, harga on-chain $${fmt(oc.currentPrice, 4)}.`
    );
    lines.push(
      `Volume: 1 jam $${fmt(oc.volume.h1, 0)}, 4 jam $${fmt(oc.volume.h4, 0)}, 24 jam $${fmt(oc.volume.h24, 0)}.`
    );
    lines.push(
      `Fee terkumpul: 1 jam $${fmt(oc.fees.h1, 2)}, 24 jam $${fmt(oc.fees.h24, 2)}. Rasio fee/TVL: 1 jam ${fmt(oc.feeTvlRatio.h1, 3)}%, 24 jam ${fmt(oc.feeTvlRatio.h24, 3)}%.`
    );
    if (oc.volumeTrendVsDailyAvg != null) {
      const trend = oc.volumeTrendVsDailyAvg;
      lines.push(
        `Momentum volume on-chain: run-rate volume 1 jam terakhir (diproyeksi 24 jam) adalah ${fmt(trend * 100, 0)}% dari volume 24 jam aktual — ${
          trend > 1.3
            ? "aktivitas trading DEX sedang MENINGKAT tajam dibanding rata-rata harian."
            : trend < 0.7
            ? "aktivitas trading DEX sedang MELAMBAT dibanding rata-rata harian."
            : "aktivitas trading DEX relatif stabil, sesuai rata-rata harian."
        }`
      );
    }
    lines.push(
      `APR 24 jam (insentif LP): ${fmt(oc.apr24h, 2)}%${oc.hasFarm ? `, plus farm reward APR ${fmt(oc.farmApr, 2)}%` : ""}. Dynamic fee saat ini: ${fmt(oc.dynamicFeePct, 3)}%${oc.dynamicFeePct != null && oc.dynamicFeePct > 0.5 ? " (fee melonjak biasanya menandakan volatilitas/aktivitas swap tinggi)" : ""}.`
    );
    const tokenNote = [oc.tokenX, oc.tokenY]
      .filter((t) => t && t.symbol && t.symbol.toUpperCase() !== "USDC" && t.symbol.toUpperCase() !== "USDT")
      .map((t) => `${t.symbol}: ${t.holders != null ? fmt(t.holders, 0) + " holders" : "n/a holders"}, market cap $${fmt(t.marketCap, 0)}${t.isVerified === false ? " (BELUM terverifikasi — waspada)" : ""}`)
      .join("; ");
    if (tokenNote) lines.push(`Info token: ${tokenNote}.`);
    lines.push(
      "Catatan: ini likuiditas & aktivitas trading on-chain (DEX Solana), bukan data derivatif CEX seperti funding rate/OI di atas — pakai sebagai konteks tambahan soal kedalaman likuiditas dan momentum minat trading di on-chain, bukan sinyal arah langsung."
    );
  } else if (String(composite.baseSymbol || "").toUpperCase() === "SOL") {
    lines.push("--- Data On-Chain DEX (Solana, via Meteora) ---");
    lines.push("n/a (gagal mengambil data pool Meteora untuk SOL)");
  }

  // Pool-level buy/sell pressure (DexPaprika, replaces Birdeye's
  // wallet-level top-trader feed — see lib/dexpaprika.js for why this is
  // labeled "pressure" rather than "wallet flow": DexPaprika has no
  // per-wallet breakdown, only aggregate pool buy/sell volume.
  if (composite.walletFlow) {
    const wf = composite.walletFlow;
    lines.push(`--- Tekanan Beli/Jual SOL (via ${wf.source}) ---`);
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
      "Catatan: ini agregat tekanan beli/jual di level pool SOL/USDC (bukan data per-wallet individual) — pakai sebagai indikasi arah minat pasar, bukan kepastian arah harga."
    );
  }

  return lines.join("\n");
}

// Memecoin Solana (gmgn.ai-style: pump.fun/small tokens not on Binance) —
// entirely different data pipeline (DexScreener + GeckoTerminal + DexPaprika
// instead of TwelveData + Binance/Bybit/OKX), so it's handled as its own
// path rather than being force-fit into the CEX-oriented code below.
async function generateMemecoinSignal({ symbol: rawSymbol, style = "scalping", keyOffset = 0 }) {
  const { token, styleCfg, candles, composite } = await fetchMemecoinData(rawSymbol, style);

  if (!candles || candles.length < 30) {
    throw new Error(
      `Data candle untuk ${token.baseToken.symbol} tidak cukup dari GeckoTerminal (pool: ${token.pairAddress}). Token mungkin terlalu baru atau kurang likuid.`
    );
  }

  const ind = computeIndicators(candles);
  const pairLabel = `${token.baseToken.symbol}/${token.quoteToken.symbol}`;

  const system = `Kamu adalah mesin analisa teknikal trading untuk aplikasi Signalynx, khusus memecoin Solana (token kecil/baru ala gmgn.ai/pump.fun yang TIDAK terdaftar di exchange CEX besar). Kamu diberi data indikator teknikal DAN data on-chain DEX (likuiditas, volume, market cap/FDV, umur pair, perubahan harga multi-timeframe) serta wallet flow top trader (jika tersedia) — semua SUDAH dihitung/diambil dari sumber live, jangan mengarang angka baru, dan jangan menyebut data yang ditandai "n/a".

Token memecoin sangat volatile dan berisiko tinggi (likuiditas tipis, slippage besar, potensi rug/scam) — pertimbangkan likuiditas pool dan umur pair saat menentukan level entry/SL/TP yang realistis (SL/TP relatif lebih lebar terhadap ATR dibanding pair major, karena wick ekstrem jauh lebih umum di memecoin). Kalau likuiditas sangat kecil relatif ke volume atau pair masih sangat baru, sebutkan risiko itu di reasoning.

Gabungkan struktur harga (EMA/MACD/Bollinger/Stochastic/ADX) dengan konteks on-chain (volume/momentum, market cap, wallet flow akumulasi/distribusi) untuk menentukan arah (BUY/SELL) dan level entry/SL/TP. ${SIGNAL_JSON_SPEC}`;

  const userText = `Instrumen: ${pairLabel} (memecoin Solana, dex: ${token.dexId})
Gaya trading: ${style} (timeframe ${styleCfg.label})

=== INDIKATOR TEKNIKAL ===
${buildIndicatorText(ind)}

=== DATA ON-CHAIN & RISIKO ===
${buildMemecoinCompositeText(composite)}

Buat satu sinyal trading sesuai spesifikasi JSON.`;

  const signal = await callGroq({ system, userText, keyOffset });

  return {
    symbol: String(rawSymbol || "").trim().toUpperCase() || token.baseToken.symbol,
    td_symbol: pairLabel,
    market: "memecoin",
    style,
    timeframe: styleCfg.label,
    price: ind.price,
    indicators: ind,
    composite,
    candles: candles.slice(-60),
    signal,
    source: `DexScreener + GeckoTerminal (${token.dexId}, Solana)${composite.walletFlow ? " + DexPaprika" : ""}${composite.gmgn ? " + GMGN" : ""}`,
    generated_at: new Date().toISOString(),
  };
}

// Shared system prompt for every CEX-priced market (crypto/forex/emas/saham
// via TwelveData, and binance_futures via direct Binance klines) — the
// indicator set and composite-data shape are identical either way, only
// where the candles come from differs.
function buildCexSystemPrompt() {
  return `Kamu adalah mesin analisa teknikal trading untuk aplikasi Signalynx. Kamu diberi data indikator teknikal DAN data komposit lintas exchange (Binance Futures, Bybit, OKX: funding rate, open interest, long/short ratio, orderbook imbalance; plus BTC dominance dari CoinGecko jika market crypto), estimasi tekanan liquidation, berita terbaru, serta momentum harga multi-timeframe — semua SUDAH dihitung/diambil dari sumber live — jangan mengarang angka baru, dan jangan menyebut data yang ditandai "n/a". Perhatikan juga apakah funding rate/positioning antar exchange searah atau berbeda (misal Binance long-heavy tapi OKX short-heavy) karena itu bisa jadi sinyal penting.

Untuk liquidation: bias "long_liq"/"short_liq" adalah ESTIMASI dari perubahan Open Interest + harga (bukan data liquidation order asli), pakai sebagai konfirmasi tambahan arah tekanan pasar saat ini, jangan sebut angka dolar liquidation.

Untuk berita dan momentum: kalau ada berita yang ditandai [BERITA BESAR] yang baru terjadi DAN "Status" menunjukkan burst momentum yang sejalan dengan arah berita itu, anggap itu katalis utama pergerakan saat ini dan beri bobot besar pada arah tersebut untuk entry — termasuk mempertimbangkan entry lebih agresif/cepat karena momentum baru mulai. Kalau ada berita besar tapi harga BELUM bereaksi (tidak ada burst), jangan buru-buru asumsikan arah — jelaskan di reasoning bahwa pasar belum pricing-in berita tersebut dan itu jadi risiko/potensi pergerakan susulan. Kalau tidak ada berita besar dan tidak ada burst momentum, andalkan struktur teknikal + positioning seperti biasa.

Gabungkan struktur harga (EMA/MACD/Bollinger/Stochastic/ADX) dengan konteks positioning (funding/long-short/orderbook/dominance), liquidation, dan momentum/berita di atas untuk menentukan arah (BUY/SELL) dan level entry/SL/TP yang realistis relatif terhadap ATR. ${SIGNAL_JSON_SPEC}`;
}

// Binance Futures (perpetual) sebagai market TERSENDIRI dari "crypto":
// candle diambil LANGSUNG dari Binance Futures klines (bukan lewat
// TwelveData), jadi harga persis sama dengan yang dipakai composite data
// (funding/OI/long-short/orderbook) di bawahnya — tidak ada key TwelveData
// yang perlu dikonfigurasi untuk market ini sama sekali. Indikator dihitung
// dengan fungsi yang SAMA (lib/indicators.js) dan sinyal tetap dibuat lewat
// Groq AI (lib/groq.js).
async function generateBinanceFuturesSignal({ symbol: rawSymbol, style = "scalping", keyOffset = 0 }) {
  const symbol = toBinanceFuturesSymbol(rawSymbol);
  const styleCfg = STYLE_INTERVALS[style] || STYLE_INTERVALS.scalping;
  const interval = BINANCE_FUTURES_KLINE_INTERVALS[style] || BINANCE_FUTURES_KLINE_INTERVALS.scalping;

  const [candles, composite] = await Promise.all([
    fetchFuturesKlines(symbol, interval, styleCfg.outputsize),
    fetchCompositeData(symbol),
  ]);

  if (!candles || candles.length < 30) {
    throw new Error(`Data candle Binance Futures untuk ${symbol} tidak cukup.`);
  }

  const ind = computeIndicators(candles);

  const system = buildCexSystemPrompt();
  const userText = `Instrumen: ${symbol} (Binance Futures Perpetual, harga & candle diambil langsung dari Binance, bukan agregat pihak ketiga)
Gaya trading: ${style} (timeframe ${styleCfg.label})

=== INDIKATOR TEKNIKAL ===
${buildIndicatorText(ind)}

=== DATA KOMPOSIT ===
${buildCompositeText(composite)}

Buat satu sinyal trading sesuai spesifikasi JSON.`;

  const signal = await callGroq({ system, userText, keyOffset });

  return {
    symbol: String(rawSymbol || "").trim().toUpperCase() || symbol,
    td_symbol: symbol,
    market: "binance_futures",
    style,
    timeframe: styleCfg.label,
    price: ind.price,
    indicators: ind,
    composite,
    candles: candles.slice(-60),
    signal,
    source: "Binance Futures (klines langsung) + Bybit/OKX Futures + CoinGecko",
    generated_at: new Date().toISOString(),
  };
}

async function generateSignal({ symbol: rawSymbol, market = "crypto", style = "scalping", keyOffset = 0 }) {
  if (market === "memecoin") {
    return generateMemecoinSignal({ symbol: rawSymbol, style, keyOffset });
  }
  if (market === "binance_futures") {
    return generateBinanceFuturesSignal({ symbol: rawSymbol, style, keyOffset });
  }

  const styleCfg = STYLE_INTERVALS[style] || STYLE_INTERVALS.scalping;
  const symbol = toTwelveDataSymbol(rawSymbol, market);
  const extraParams = market === "crypto" ? { exchange: "Binance" } : {};

  const compositePromise =
    market === "crypto" ? fetchCompositeData(rawSymbol) : Promise.resolve(null);

  const [series, composite] = await Promise.all([
    tdFetch("time_series", {
      symbol,
      interval: styleCfg.interval,
      outputsize: String(styleCfg.outputsize),
      ...extraParams,
    }),
    compositePromise,
  ]);

  if (!series.values || series.values.length < 30) {
    throw new Error(`Data candle untuk ${symbol} tidak cukup dari TwelveData.`);
  }

  const candles = series.values
    .slice()
    .reverse()
    .map((v) => ({
      time: v.datetime,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume !== undefined ? Number(v.volume) : undefined,
    }));

  const ind = computeIndicators(candles);

  const system = buildCexSystemPrompt();

  const userText = `Instrumen: ${symbol} (market: ${market})
Gaya trading: ${style} (timeframe ${styleCfg.label})

=== INDIKATOR TEKNIKAL ===
${buildIndicatorText(ind)}

=== DATA KOMPOSIT ===
${buildCompositeText(composite)}

Buat satu sinyal trading sesuai spesifikasi JSON.`;

  const signal = await callGroq({ system, userText, keyOffset });

  return {
    symbol: String(rawSymbol || "").trim().toUpperCase() || symbol,
    td_symbol: symbol,
    market,
    style,
    timeframe: styleCfg.label,
    price: ind.price,
    indicators: ind,
    composite,
    candles: candles.slice(-60),
    signal,
    source: composite ? "TwelveData + Binance/Bybit/OKX Futures + CoinGecko" : "TwelveData",
    generated_at: new Date().toISOString(),
  };
}

module.exports = { generateSignal, buildCompositeText };
