// lib/memecoinScout.js
// "AI Scout" — automatically discovers and ranks Solana memecoin
// candidates instead of requiring the user to type a ticker, using Groq
// to do the final ranking (same model/pipeline as the rest of the app).
//
// IMPORTANT — READ BEFORE CHANGING THE PROMPT:
// This does NOT output a "confidence this will gain 50%-1000%" number.
// The user clarified they mean price gains of 50%-1000% (not literal
// 50x/1000x multiples) — a far more plausible range for volatile
// memecoins. Still, having an AI hand out a % "confidence" that a specific
// token will move by a specific range is an unfalsifiable, overconfident
// claim no model can actually back up, and stating it as a real probability
// on a paid product risks people trading real money on a false promise.
// Instead, "target_profil_volatilitas" describes WHAT KIND of candidate
// the scout is looking for (high-momentum, still-small-cap, room-to-run —
// i.e. the type of setup that historically CAN see 50%-1000%+ swings), and
// the bounded 0-100 "skor_potensi_spekulatif" still just ranks candidates
// relative to each other based on momentum/liquidity/volume-growth
// factors that correlate with room-to-run — not a probability or promise
// of any specific % gain.

const { fetchDexPaprikaPoolSnapshot, fetchDexPaprikaPoolFlow } = require("./dexpaprika");
const { fetchGmgnTokenSecurity } = require("./gmgn"); // optional, opt-in via GMGN_API_KEY
const { fetchMintAuthorityStatus, fetchTopHolderConcentration } = require("./solanaOnchain"); // keyless, direct RPC
const { callGroq } = require("./groq");
const { MIN_LIQUIDITY_USD, MIN_PAIR_AGE_MINUTES } = require("./memecoin");

const DEXPAPRIKA_API = "https://api.dexpaprika.com";
const DEXSCREENER_API = "https://api.dexscreener.com";
const FETCH_TIMEOUT_MS = 7000;

// Discovery window: pools created in the last N days, so the scout is
// biased toward "new-ish but already proving liquidity/volume" tokens
// rather than either month-old coins or minute-old rugs.
const DISCOVERY_MAX_AGE_DAYS = Number(process.env.SCOUT_MAX_AGE_DAYS) || 21;
const DISCOVERY_MIN_VOLUME_24H = Number(process.env.SCOUT_MIN_VOLUME_24H) || 20000;
const DISCOVERY_MIN_TXNS_24H = Number(process.env.SCOUT_MIN_TXNS_24H) || 80;
const CANDIDATE_POOL_SIZE = 25; // how many discovery hits to cross-check against DexScreener
const FINAL_LIST_SIZE = 5; // how many the AI is asked to shortlist

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

// Step 1: discover raw candidates via DexPaprika's pool-filter screener —
// recently created Solana pools that already clear a minimum volume/txn
// bar (i.e. not dead on arrival).
async function discoverCandidatePools() {
  const createdAfter = Math.floor(Date.now() / 1000) - DISCOVERY_MAX_AGE_DAYS * 86400;
  const url =
    `${DEXPAPRIKA_API}/networks/solana/pools/filter?` +
    `volume_24h_min=${DISCOVERY_MIN_VOLUME_24H}&txns_24h_min=${DISCOVERY_MIN_TXNS_24H}` +
    `&created_after=${createdAfter}&sort_by=volume_24h&sort_dir=desc&limit=${CANDIDATE_POOL_SIZE}`;
  const j = await safeJson(url);
  const pools = j?.pools || j?.data || [];
  return Array.isArray(pools) ? pools : [];
}

// Step 2: cross-check each discovery hit against DexScreener, which is the
// source of truth for liquidity (DexPaprika's filter endpoint doesn't
// expose a working liquidity filter yet) — apply the SAME liquidity/age
// bar used by the manual memecoin market (lib/memecoin.js) so the scout
// never surfaces something the rest of the app would itself reject.
async function enrichAndFilter(rawPools) {
  const enriched = await Promise.all(
    rawPools.map(async (p) => {
      const poolAddress = p.id || p.pool_address || p.address;
      if (!poolAddress) return null;
      const j = await safeJson(`${DEXSCREENER_API}/latest/dex/pairs/solana/${poolAddress}`);
      const pair = Array.isArray(j?.pairs) ? j.pairs[0] : j?.pair;
      if (!pair) return null;

      const liquidityUsd = Number(pair.liquidity?.usd) || 0;
      const ageMin = pair.pairCreatedAt ? (Date.now() - Number(pair.pairCreatedAt)) / 60000 : null;
      if (liquidityUsd < MIN_LIQUIDITY_USD) return null;
      if (ageMin !== null && ageMin < MIN_PAIR_AGE_MINUTES) return null;

      return {
        symbol: pair.baseToken?.symbol || "?",
        name: pair.baseToken?.name || "",
        mintAddress: pair.baseToken?.address || null,
        pairAddress: poolAddress,
        dexId: pair.dexId || "unknown",
        url: pair.url || null,
        imageUrl: pair.info?.imageUrl || null,
        priceUsd: Number(pair.priceUsd) || null,
        liquidityUsd,
        fdvUsd: Number(pair.fdv) || null,
        marketCapUsd: Number(pair.marketCap) || null,
        ageMinutes: ageMin,
        volume: {
          h1: Number(pair.volume?.h1) || 0,
          h6: Number(pair.volume?.h6) || 0,
          h24: Number(pair.volume?.h24) || 0,
        },
        priceChange: {
          h1: Number(pair.priceChange?.h1) || 0,
          h6: Number(pair.priceChange?.h6) || 0,
          h24: Number(pair.priceChange?.h24) || 0,
        },
        txns24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
        buysVsSells24h: pair.txns?.h24 || null,
      };
    })
  );
  return enriched.filter(Boolean);
}

// Only run for the shortlist (not all 25 raw discoveries) since these are
// extra per-token lookups: GMGN risk (bundler/sniper/rug/wash-trade/
// honeypot — opt-in, silently null without GMGN_API_KEY) and DexPaprika's
// buy/sell pressure. This is what turns the scout's "alasan" from a pure
// mcap-math sentence into a real multi-factor read (liquidity health,
// momentum direction, insider/bot activity, rug risk) — the model still
// isn't allowed to turn any of it into an invented % forecast, but it now
// has the same kind of signals a human doing manual due-diligence would
// look at.
async function enrichWithRiskAndFlow(shortlist) {
  await Promise.all(
    shortlist.map(async (c) => {
      const [gmgn, flow, mintAuth, holderConc] = await Promise.all([
        fetchGmgnTokenSecurity(c.mintAddress).catch(() => null),
        fetchDexPaprikaPoolFlow(c.pairAddress).catch(() => null),
        fetchMintAuthorityStatus(c.mintAddress).catch(() => null),
        fetchTopHolderConcentration(c.mintAddress).catch(() => null),
      ]);
      c.gmgn = gmgn;
      c.flow = flow;
      c.mintAuth = mintAuth;
      c.holderConc = holderConc;
    })
  );
}

function fmt(n, digits = 0) {
  return n === null || n === undefined || Number.isNaN(n) ? "n/a" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
}

// Real, computed (not AI-invented) "headroom" scenarios: if this token's
// market cap reached common round-number milestones, what would the %
// price gain be. Pure math off the token's OWN current market cap — no
// comparison to other tokens' history is claimed, so nothing here is a
// forecast, just "if X then Y" arithmetic the AI is required to quote
// verbatim rather than replace with its own number.
const MCAP_MILESTONES_USD = [500_000, 1_000_000, 5_000_000, 20_000_000];

function computeMcapScenarios(marketCapUsd) {
  if (!marketCapUsd || marketCapUsd <= 0) return [];
  return MCAP_MILESTONES_USD.filter((m) => m > marketCapUsd)
    .slice(0, 2) // nearest milestone + one stretch milestone, keep prompt compact
    .map((milestone) => ({
      milestoneUsd: milestone,
      percentGain: Math.round((milestone / marketCapUsd - 1) * 100),
    }));
}

function buildCandidateText(c, i) {
  const buySell = c.buysVsSells24h ? `${c.buysVsSells24h.buys} beli / ${c.buysVsSells24h.sells} jual` : "n/a";
  const scenarios = computeMcapScenarios(c.marketCapUsd);
  const scenarioLine = scenarios.length
    ? `   Skenario MCap (perhitungan matematis, BUKAN prediksi): ${scenarios
        .map((s) => `kalau MCap capai $${fmt(s.milestoneUsd)} → harga +${s.percentGain}%`)
        .join(", ")}`
    : `   Skenario MCap: n/a (data market cap tidak tersedia)`;

  const lines = [
    `${i + 1}. ${c.symbol} (${c.name || "n/a"})`,
    `   Umur pool: ${c.ageMinutes != null ? (c.ageMinutes / 60).toFixed(1) + " jam" : "n/a"} | Likuiditas: $${fmt(c.liquidityUsd)} | Market Cap: $${fmt(c.marketCapUsd)} | FDV: $${fmt(c.fdvUsd)}`,
    `   Volume: 1j $${fmt(c.volume.h1)}, 6j $${fmt(c.volume.h6)}, 24j $${fmt(c.volume.h24)} | Transaksi 24j: ${buySell}`,
    `   Perubahan harga: 1j ${c.priceChange.h1.toFixed(1)}%, 6j ${c.priceChange.h6.toFixed(1)}%, 24j ${c.priceChange.h24.toFixed(1)}%`,
    scenarioLine,
  ];

  // Buy/sell pressure (DexPaprika) — pool-level, not wallet-level (see
  // lib/dexpaprika.js). Adds a second, independent read on momentum
  // direction beyond DexScreener's own priceChange numbers.
  if (c.flow?.timeframes?.h1 || c.flow?.timeframes?.h24) {
    const h1 = c.flow.timeframes.h1;
    const h24 = c.flow.timeframes.h24;
    lines.push(
      `   Tekanan beli/jual (DexPaprika): 1j beli $${fmt(h1?.buyUsd)} vs jual $${fmt(h1?.sellUsd)} | 24j beli $${fmt(h24?.buyUsd)} vs jual $${fmt(h24?.sellUsd)} (net ${h24?.netUsd > 0 ? "+" : ""}$${fmt(h24?.netUsd)})`
    );
  } else {
    lines.push("   Tekanan beli/jual (DexPaprika): n/a");
  }

  // On-chain mint/freeze authority + top-account concentration — read
  // directly via Solana RPC (lib/solanaOnchain.js), keyless, always
  // attempted (unlike GMGN which needs an API key).
  if (c.mintAuth) {
    lines.push(
      `   On-chain (RPC langsung): mint authority ${c.mintAuth.mintAuthorityRevoked ? "SUDAH DICABUT (aman)" : "MASIH AKTIF (dev bisa cetak token baru — risiko)"}, freeze authority ${c.mintAuth.freezeAuthorityRevoked ? "SUDAH DICABUT (aman)" : "MASIH AKTIF (dev bisa bekukan wallet — risiko)"}`
    );
  }
  if (c.holderConc) {
    lines.push(
      `   Konsentrasi top 10 akun terbesar: ${c.holderConc.top10Percent.toFixed(1)}% dari total supply (catatan: bisa termasuk akun pool likuiditas itu sendiri, bukan murni wallet individu)`
    );
  }

  // GMGN risk block — bundler/sniper/rug/wash-trade/honeypot. Opt-in
  // (needs GMGN_API_KEY); omitted entirely rather than printed as "n/a"
  // when not configured, so the AI isn't tempted to reason from a wall of
  // missing data.
  if (c.gmgn) {
    const g = c.gmgn;
    lines.push(
      `   Risiko GMGN: rug ratio ${g.rugRatioPercent != null ? g.rugRatioPercent.toFixed(1) + "%" : "n/a"}, bundler wallet ${g.bundlerPercent != null ? g.bundlerPercent.toFixed(1) + "%" : "n/a"} dari volume, sniper ${g.sniperCount != null ? g.sniperCount + " wallet" : "n/a"}, insider ${g.insiderPercent != null ? g.insiderPercent.toFixed(1) + "%" : "n/a"}, wash trading: ${g.isWashTrading === true ? "TERDETEKSI" : g.isWashTrading === false ? "tidak" : "n/a"}${g.isHoneypot === true ? ", PERINGATAN: terdeteksi HONEYPOT" : ""}`
    );
  }

  return lines.join("\n");
}

const SCOUT_JSON_SPEC = `Balas HANYA dengan satu objek JSON valid, tanpa teks lain, tanpa markdown fence, dengan bentuk persis:
{
  "picks": [
    {
      "symbol": string (harus sama persis dengan salah satu simbol di daftar kandidat),
      "skor_potensi_spekulatif": number (0-100, RELATIF terhadap kandidat lain di daftar ini SAJA — seberapa cocok profil token ini dengan setup yang secara historis punya ruang untuk swing besar (momentum kuat, market cap masih kecil, likuiditas cukup, volume naik tajam). BUKAN probabilitas, BUKAN prediksi persentase kenaikan spesifik),
      "alasan": string (3-4 kalimat bahasa Indonesia, ANALISIS MULTI-FAKTOR nyata — bahas likuiditas vs volume (sehat/tipis), arah tekanan beli/jual, dan KALAU data GMGN tersedia bahas juga bundler/sniper/rug ratio/wash trading (rendah/wajar/tinggi, dan kenapa itu penting). Simpulkan dengan kata sifat kualitatif (setup KUAT/SEDANG/LEMAH), BUKAN dengan mengarang angka persentase kenaikan baru. Kalau menyebut skenario MCap yang sudah dihitung di data, salin persis apa adanya, misal "kalau MCap capai $1,000,000 harga berpotensi +455% (skenario matematis)"),
      "faktor_risiko": string (1-2 kalimat bahasa Indonesia, risiko spesifik token ini — likuiditas relatif terhadap volume, umur pool, mint/freeze authority, konsentrasi holder, dll),
      "rekomendasi": string (WAJIB salah satu dari: "Layak dipertimbangkan", "Perlu riset lanjutan", "Sebaiknya dihindari" — kesimpulan keputusan berdasarkan SINTESIS SEMUA faktor di atas untuk token ini, bukan angka probabilitas)
    }
  ],
  "catatan_umum": string (1-2 kalimat bahasa Indonesia tentang kondisi pasar memecoin secara umum dari data yang terlihat)
}
ATURAN KETAT (WAJIB DIPATUHI):
- Fokusnya adalah token dengan SETUP yang secara historis punya ruang untuk kenaikan tajam — market cap yang masih kecil relatif ke volume, momentum beli yang kuat, likuiditas yang cukup, DAN indikator risiko (bundler/sniper/rug/wash trading) yang rendah/wajar kalau datanya tersedia. Ini adalah KRITERIA ANALISIS, bukan hal yang boleh dijanjikan akan terjadi.
- "alasan" HARUS berupa analisis kualitatif yang menyintesis SEMUA faktor yang tersedia di data (likuiditas, volume, tekanan beli/jual, on-chain mint/freeze authority, konsentrasi holder, dan risiko GMGN kalau ada) — bukan cuma menyalin satu-dua angka. Simpulkan kekuatan setup secara kualitatif (kuat/sedang/lemah beserta alasannya).
- "rekomendasi" HARUS salah satu dari 3 pilihan yang ditentukan, dipilih berdasarkan sintesis semua faktor — jangan buat kategori baru, jangan sisipkan angka di dalamnya.
- JANGAN PERNAH menyimpulkan atau mengarang angka probabilitas/persentase kenaikan baru dari faktor kualitatif (mis. "karena bundler rendah dan sniper sedikit, berpotensi naik 45%") — itu bukan hubungan matematis nyata, hanya karangan yang dibungkus terlihat ilmiah. Satu-satunya angka persentase kenaikan yang boleh disebut adalah skenario MCap yang SUDAH DIHITUNG di data kandidat, disalin persis apa adanya.
- "skor_potensi_spekulatif" hanya boleh dipakai untuk MERANGKING kandidat yang diberikan relatif satu sama lain, bukan sebagai probabilitas absolut atau target persentase.
- Maksimal ${FINAL_LIST_SIZE} pick, urutkan dari skor tertinggi ke terendah. Kalau tidak ada kandidat yang cukup meyakinkan (misal semua data lemah/berisiko sangat tinggi), boleh mengembalikan array "picks" yang lebih pendek atau kosong — jangan dipaksakan.`;

async function runMemecoinScout() {
  const raw = await discoverCandidatePools();
  if (raw.length === 0) {
    return {
      candidates_scanned: 0,
      candidates_qualified: 0,
      picks: [],
      catatan_umum: "Tidak ada pool baru di Solana yang lolos ambang volume/transaksi minimum saat ini — coba lagi nanti.",
      generated_at: new Date().toISOString(),
    };
  }

  const candidates = await enrichAndFilter(raw);
  if (candidates.length === 0) {
    return {
      candidates_scanned: raw.length,
      candidates_qualified: 0,
      picks: [],
      catatan_umum: `${raw.length} pool baru terdeteksi tapi tidak ada yang lolos ambang likuiditas minimum ($${MIN_LIQUIDITY_USD.toLocaleString("en-US")}) atau umur minimum (${MIN_PAIR_AGE_MINUTES} menit) — semuanya masih terlalu tipis/baru untuk direkomendasikan.`,
      generated_at: new Date().toISOString(),
    };
  }

  // Sort by a simple momentum proxy (volume x recent price change) before
  // handing to the AI, just to keep the prompt focused on the liveliest
  // subset if discovery returned more than we want to spend tokens on.
  candidates.sort((a, b) => b.volume.h24 * (1 + Math.abs(b.priceChange.h1) / 100) - a.volume.h24 * (1 + Math.abs(a.priceChange.h1) / 100));
  // Narrower than before (10 instead of 15): each of these now gets 2 extra
  // lookups (GMGN risk + DexPaprika flow) so the AI has real risk/momentum
  // factors to reason with, not just DexScreener's surface-level numbers.
  const shortlist = candidates.slice(0, 10);
  await enrichWithRiskAndFlow(shortlist);

  const system = `Kamu adalah asisten screening memecoin Solana untuk aplikasi Signalynx. Kamu diberi daftar kandidat token yang SUDAH lolos filter likuiditas dan umur minimum otomatis (bukan token baru terbit dalam hitungan menit), termasuk skenario MCap yang SUDAH DIHITUNG secara matematis untuk tiap token. Tugasmu mencari token dengan SETUP yang secara historis punya ruang untuk kenaikan besar — kamu HANYA merangking dan memberi alasan berbasis data yang diberikan. Kalau menyebut angka persentase kenaikan, WAJIB pakai persis angka skenario MCap yang sudah dihitung di data (jangan bulatkan ulang, jangan bikin angka baru). JANGAN PERNAH membuat, menghitung sendiri, atau mengarang angka probabilitas/persentase kenaikan di luar yang sudah diberikan. ${SCOUT_JSON_SPEC}`;

  const userText = `Kandidat (${shortlist.length} token, semua sudah lolos likuiditas minimum $${MIN_LIQUIDITY_USD.toLocaleString("en-US")} dan umur minimum ${MIN_PAIR_AGE_MINUTES} menit):\n\n${shortlist
    .map((c, i) => buildCandidateText(c, i))
    .join("\n\n")}\n\nPilih dan rangking kandidat paling menarik sesuai spesifikasi JSON.`;

  const aiResult = await callGroq({ system, userText });

  const bySymbol = Object.fromEntries(shortlist.map((c) => [c.symbol.toUpperCase(), c]));
  const picks = (Array.isArray(aiResult.picks) ? aiResult.picks : [])
    .slice(0, FINAL_LIST_SIZE)
    .map((p) => {
      const c = bySymbol[String(p.symbol || "").toUpperCase()];
      return {
        symbol: p.symbol,
        skor_potensi_spekulatif: Math.max(0, Math.min(100, Number(p.skor_potensi_spekulatif) || 0)),
        alasan: p.alasan || "",
        faktor_risiko: p.faktor_risiko || "",
        rekomendasi: ["Layak dipertimbangkan", "Perlu riset lanjutan", "Sebaiknya dihindari"].includes(p.rekomendasi)
          ? p.rekomendasi
          : "Perlu riset lanjutan",
        // Computed server-side from real market-cap math, NOT sourced from
        // the AI's output — this is what the frontend should render as the
        // authoritative "%" figure, since it's independently verifiable
        // (mcap target / current mcap) rather than something the model
        // could get wrong or embellish when echoing it into "alasan".
        mcap_scenarios: c ? computeMcapScenarios(c.marketCapUsd) : [],
        data: c || null,
      };
    })
    .filter((p) => p.data); // drop anything the model hallucinated outside the given list

  return {
    candidates_scanned: raw.length,
    candidates_qualified: candidates.length,
    picks,
    catatan_umum: aiResult.catatan_umum || "",
    disclaimer:
      "Skor adalah perangkingan relatif berbasis data on-chain saat ini (likuiditas, market cap, volume, momentum) — BUKAN prediksi harga dan BUKAN nasihat keuangan. Angka persentase pada 'skenario MCap' adalah PERHITUNGAN MATEMATIKA MURNI (target market cap ÷ market cap sekarang), BUKAN prediksi bahwa harga akan benar-benar mencapai market cap tersebut — itu cuma ilustrasi 'kalau X terjadi, maka Y'. Token memecoin sangat berisiko tinggi, termasuk risiko rug/kehilangan seluruh modal. Selalu riset sendiri (DYOR) dan hanya gunakan dana yang siap hilang sepenuhnya.",
    generated_at: new Date().toISOString(),
  };
}

module.exports = { runMemecoinScout };
