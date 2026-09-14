# Signalynx (Vercel edition)

Analisa teknikal otomatis untuk crypto, forex, emas (+ saham AS), dan memecoin Solana. TwelveData + Binance/Bybit/OKX Futures + DexScreener/GeckoTerminal/DexPaprika, sinyal digenerate oleh Groq AI.

Ini adalah hasil migrasi dari Netlify. Ringkasan perubahan dari versi Netlify:

| Bagian | Netlify (lama) | Vercel (sekarang) |
|---|---|---|
| Functions | `netlify/functions/*.js`, `exports.handler` | `api/*.js`, `module.exports = async (req,res)=>{}` |
| Storage (cache signal harian) | Netlify Blobs | Vercel KV (`lib/kvStore.js`) |
| Cron (signal harian otomatis) | Netlify scheduled function | Vercel Cron Job → `api/cron/daily-signal.js` |
| Wallet flow SOL/memecoin | Birdeye (`BIRDEYE_API_KEY`, berbayar) | **DexPaprika** (`lib/dexpaprika.js`, keyless) |
| Token security Birdeye | Birdeye `token_security` | Dihapus — tidak ada padanan keyless. Risiko memecoin sekarang dari filter likuiditas/umur pool + GMGN opsional |
| Candle memecoin | GMGN CLI (butuh `GMGN_API_KEY` + child_process) | **GeckoTerminal OHLCV** (keyless, publik) |
| Fitur baru | — | **AI Scout** (`/api/memecoin-scout`) — AI otomatis scan & rangking token Solana |

## Kenapa "Wallet Flow" sekarang disebut "Tekanan Beli/Jual"

Birdeye punya data level-wallet individual (siapa beli berapa). DexPaprika **tidak** punya endpoint itu di tier gratisnya — yang ada cuma agregat beli/jual per pool per timeframe. Jadi datanya diganti jujur: "Tekanan Beli/Jual Pool" (buy/sell pressure), bukan "Wallet Flow". Tetap berguna sebagai indikator arah minat pasar, tapi bukan data per-wallet seperti sebelumnya.

## Kenapa AI Scout tidak kasih "confidence naik 50x–1000x"

Diminta, tapi sengaja tidak dibuat seperti itu: menjanjikan angka keyakinan pasti untuk kelipatan harga 50x–1000x ke pengguna (apalagi produk berlangganan) adalah klaim yang tidak realistis — tidak ada model yang bisa benar-benar memprediksi itu, dan menyajikannya sebagai angka nyata berisiko bikin orang salah ambil keputusan finansial berdasarkan janji palsu. Sebagai gantinya, AI Scout memberi **skor potensi spekulatif 0–100** yang sifatnya **rangking relatif antar kandidat di scan yang sama** (bukan probabilitas absolut, bukan prediksi harga), plus alasan berbasis data on-chain nyata (likuiditas, volume, momentum, rasio transaksi beli/jual) dan disclaimer wajib di setiap hasil. Prompt AI di `lib/memecoinScout.js` secara eksplisit melarang model menyebut probabilitas atau kelipatan harga spesifik.

Kalau nanti ingin tetap eksplorasi arah "target harga", cara yang lebih bertanggung jawab adalah menampilkan skenario (mis. "kalau market cap menyamai token X, harga jadi Y") sebagai ilustrasi historis — bukan sebagai jaminan atau probabilitas.

## Deploy ke Vercel dari GitHub

1. **Push project ini ke repo GitHub baru** (folder ini apa adanya, termasuk `api/`, `lib/`, `public/`, `vercel.json`, `package.json`).
2. Di [vercel.com](https://vercel.com) → **Add New Project** → import repo GitHub tadi. Vercel otomatis mendeteksi `api/*.js` sebagai serverless functions dan men-serve `public/` sebagai static site — tidak perlu build command khusus.
3. **Storage (wajib untuk Signal Harian):** Project → **Storage** → **Create Database** → pilih **KV** (Upstash Redis) → connect ke project ini. Vercel otomatis mengisi env var `KV_REST_API_URL` dan `KV_REST_API_TOKEN`.
4. **Environment Variables** (Project → Settings → Environment Variables):

   | Key | Wajib? | Keterangan |
   |---|---|---|
   | `TWELVEDATA_API_KEYS` | ✅ | Sama seperti sebelumnya, pisah koma untuk rotasi banyak key |
   | `GROQ_API_KEYS` (atau `GROQ_KEYS`) | ✅ | Sama seperti sebelumnya, pisah koma |
   | `CRON_SECRET` | Disarankan | String acak bebas — mengunci endpoint `/api/cron/daily-signal` supaya tidak bisa dipanggil sembarang orang. Vercel otomatis mengirim header ini saat cron jalan |
   | `GMGN_API_KEY` | Opsional | Kalau mau tetap pakai panel risiko GMGN (bundler/sniper/rug ratio) di tab Memecoin & AI Scout |
   | `SOLANA_RPC_URL` | Disarankan | RPC publik `api.mainnet-beta.solana.com` (default) rate-limited & kurang stabil buat produksi. Isi dengan RPC gratis (mis. Helius, QuickNode) buat cek mint/freeze authority & konsentrasi holder di AI Scout |
   | `DEXPAPRIKA_SOL_POOL` | Opsional | Override pool SOL/USDC referensi untuk tekanan beli/jual SOL native. Default sudah diisi pool Raydium yang dalam |
   | `MEMECOIN_MIN_LIQUIDITY_USD` | Opsional | Default `15000` |
   | `MEMECOIN_MIN_AGE_MINUTES` | Opsional | Default `60` |
   | `SCOUT_MAX_AGE_DAYS` / `SCOUT_MIN_VOLUME_24H` / `SCOUT_MIN_TXNS_24H` | Opsional | Parameter discovery AI Scout |

   **CATATAN:** `BIRDEYE_API_KEY` sudah tidak dipakai sama sekali — boleh dihapus dari env var kalau masih ada dari setup lama.

5. Deploy. Cron job (`api/cron/daily-signal.js`, tiap 2 jam) otomatis aktif begitu `vercel.json` ter-deploy — tidak perlu setup manual tambahan di dashboard.

## Menjalankan lokal

```bash
npm install
npx vercel dev
```

`vercel dev` menjalankan `api/*.js` dan `public/` persis seperti di production, termasuk env var dari `.env.local`.

## Catatan soal `lib/gmgn.js`

File ini tidak diubah dari versi Netlify — masih memanggil CLI `gmgn-cli` lewat `child_process`, dan tetap opsional (langsung return `null` kalau `GMGN_API_KEY` tidak diset, tidak mengganggu fitur lain). Kalau mau tetap dipakai di Vercel, tambahkan `gmgn-cli` ke `dependencies` di `package.json` — belum ditest bundling-nya di Vercel Node runtime (beda dari Netlify's esbuild bundler), jadi cek log function setelah deploy.
