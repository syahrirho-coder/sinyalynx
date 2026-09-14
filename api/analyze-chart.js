// api/analyze-chart.js — POST /api/analyze-chart (tab "Analisa Chart")
const { tdFetch, toTwelveDataSymbol } = require("../lib/twelvedata");
const { fetchCompositeData } = require("../lib/marketdata");
const { buildCompositeText } = require("../lib/generate");
const { callGroq, SIGNAL_JSON_SPEC } = require("../lib/groq");

const MAX_BYTES = 4 * 1024 * 1024; // 4MB, matches the UI's stated limit

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method !== "POST") {
    return json(res, 405, { error: "Gunakan POST." });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { image_base64, media_type, symbol: rawSymbol, market = "crypto", timeframe = "M15" } = body;

    if (!image_base64 || !media_type) {
      return json(res, 400, { error: "Chart image wajib diupload." });
    }
    if (!rawSymbol) {
      return json(res, 400, { error: "Parameter 'symbol' wajib diisi." });
    }
    const approxBytes = image_base64.length * 0.75;
    if (approxBytes > MAX_BYTES) {
      return json(res, 400, { error: "Ukuran gambar melebihi 4 MB." });
    }

    const marketLc = market.toLowerCase();
    const symbol = toTwelveDataSymbol(rawSymbol, marketLc);
    const extraParams = marketLc === "crypto" ? { exchange: "Binance" } : {};

    const [quoteResult, composite] = await Promise.allSettled([
      tdFetch("quote", { symbol, ...extraParams }),
      marketLc === "crypto" ? fetchCompositeData(rawSymbol) : Promise.resolve(null),
    ]);

    const liveQuote =
      quoteResult.status === "fulfilled"
        ? {
            price: Number(quoteResult.value.close),
            high: Number(quoteResult.value.high),
            low: Number(quoteResult.value.low),
            percent_change: Number(quoteResult.value.percent_change),
          }
        : null;
    const compositeData = composite.status === "fulfilled" ? composite.value : null;

    const system = `Kamu adalah mesin analisa teknikal trading untuk aplikasi Signalynx. Kamu diberi screenshot chart dari pengguna. Baca pola candlestick, garis/level yang mereka gambar (jika ada), dan struktur harga di gambar. ${
      liveQuote
        ? `Harga live terverifikasi saat ini untuk ${symbol} adalah ${liveQuote.price} — gunakan ini sebagai acuan harga saat ini, JANGAN memakai harga lama yang mungkin terlihat di chart.`
        : "Tidak ada harga live yang berhasil diambil, gunakan harga yang terlihat di chart sebagai acuan."
    } Gabungkan pembacaan chart dengan data komposit di bawah (kalau tersedia dan bukan n/a). ${SIGNAL_JSON_SPEC}`;

    const userText = `Instrumen: ${symbol} (market: ${market})
Timeframe chart: ${timeframe}
${liveQuote ? `Harga live: ${liveQuote.price} (H: ${liveQuote.high}, L: ${liveQuote.low}, perubahan: ${liveQuote.percent_change}%)` : ""}

=== DATA KOMPOSIT ===
${buildCompositeText(compositeData)}

Baca chart pada gambar, lalu buat satu sinyal trading sesuai spesifikasi JSON.`;

    const signal = await callGroq({
      system,
      userText,
      image: { mediaType: media_type, data: image_base64 },
    });

    return json(res, 200, {
      symbol,
      market,
      timeframe,
      live_quote: liveQuote,
      composite: compositeData,
      signal,
      source: liveQuote ? (compositeData ? "TwelveData + Binance/Bybit/OKX Futures + Chart" : "TwelveData + Chart") : "Chart",
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
};

function json(res, statusCode, body) {
  res.status(statusCode).setHeader("content-type", "application/json").send(JSON.stringify(body));
}
