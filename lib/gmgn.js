// lib/gmgn.js
// GMGN's official Agent API (docs.gmgn.ai) — the "gmgn-token" skill exposes
// exactly the risk metrics shown on the GMGN app itself: bundler wallet %,
// sniper count, insider/"rat trader" %, rug ratio, wash-trading flag,
// mint/freeze authority renounced status, LP burn status.
//
// UNLIKE lib/marketdata.js and lib/memecoin.js, this is NOT a plain REST
// fetch() — GMGN ships this as a CLI (`gmgn-cli`), meant to be driven by an
// AI agent shelling out to it. We invoke it as a child process and parse
// its --raw (JSON) stdout.
//
// SETUP REQUIRED (this will return null / "not configured" until done):
//   1. Generate a local keypair (see https://docs.gmgn.ai/index/generate-public-key)
//   2. Create a real API key at https://gmgn.ai/ai (upload the public key) —
//      the public demo key `gmgn_solbscbaseethmonadtron` from their docs is
//      for testing only, do not rely on it for production traffic.
//   3. Set GMGN_API_KEY in Netlify env vars.
//   4. netlify.toml already has `external_node_modules = ["gmgn-cli"]` so
//      esbuild ships the CLI binary with the function — don't remove that.
//
// FIELD NAMES: `rug_ratio`, `top_10_holder_rate`, `rat_trader_amount_rate`,
// `bundler_trader_amount_rate`, `sniper_count`, `is_wash_trading`,
// `renounced_mint`, `renounced_freeze_account`, `burn_status` are confirmed
// from GMGN's own `gmgn-market` SKILL.md (trenches response). The `token
// security` command used below is documented as returning "holder
// concentration, contract risks" for an arbitrary address, which should be
// the same/overlapping field set — but that exact mapping (command ->
// fields) was NOT independently confirmed against a live --raw response.
// Run `GMGN_API_KEY=<key> npx gmgn-cli token security --chain sol --address <mint> --raw`
// once you have a real key and diff the actual JSON against parseSecurity()
// below before trusting this in production. safeNum/pick fallbacks exist so
// small naming variants don't hard-fail, but they can't invent fields that
// aren't there.

const { execFile } = require("node:child_process");
const path = require("node:path");

const TIMEOUT_MS = Number(process.env.GMGN_TIMEOUT_MS) || 7000;

function resolveCliBin() {
  // node_modules/.bin/gmgn-cli — resolved relative to this file so it works
  // both locally (`netlify dev`) and in the deployed function bundle, where
  // external_node_modules keeps node_modules physically alongside the
  // function instead of trying to inline it.
  try {
    return require.resolve("gmgn-cli/package.json").replace(/package\.json$/, "bin/gmgn-cli.js");
  } catch {
    return null;
  }
}

function runGmgnCli(args) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GMGN_API_KEY;
    if (!apiKey) return reject(new Error("GMGN_API_KEY belum dikonfigurasi."));

    const bin = resolveCliBin();
    if (!bin) return reject(new Error("Package gmgn-cli tidak ditemukan (cek external_node_modules di netlify.toml)."));

    execFile(
      process.execPath, // run via `node <bin>`, not a shell — avoids relying on PATH/npx at runtime
      [bin, ...args, "--raw"],
      {
        timeout: TIMEOUT_MS,
        env: { ...process.env, GMGN_API_KEY: apiKey },
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`gmgn-cli ${args.join(" ")} gagal: ${stderr || err.message}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`gmgn-cli ${args.join(" ")}: output bukan JSON valid.`));
        }
      }
    );
  });
}

// FIELD NAMES FOR KLINE: NOT independently confirmed against a live --raw
// response (same caveat as parseSecurity() above). GMGN's docs describe
// `market kline` as returning candlestick data but don't publish the exact
// per-candle field names. parseKline() below tries the common variants
// (snake_case timestamp/open_time/time, o/h/l/c/v vs open/high/low/close/
// volume) so small naming differences don't hard-fail, but run
// `GMGN_API_KEY=<key> npx gmgn-cli market kline --chain sol --address <mint> --resolution 5m --raw`
// once you have a real key and diff the actual JSON against this before
// trusting it in production — same as the token-security TODO above.
function pickNum(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseKline(raw) {
  const list = raw?.data?.list ?? raw?.data ?? raw?.list ?? raw ?? [];
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((row) => {
      const tsRaw = pickNum(row.time, row.timestamp, row.t, row.open_time, row.ts);
      if (tsRaw === null) return null;
      // GMGN, like most of these APIs, could hand back seconds or ms —
      // normalize by magnitude (>= 10^12 is almost certainly ms).
      const ms = tsRaw >= 1e12 ? tsRaw : tsRaw * 1000;
      const open = pickNum(row.open, row.o);
      const high = pickNum(row.high, row.h);
      const low = pickNum(row.low, row.l);
      const close = pickNum(row.close, row.c);
      const volume = pickNum(row.volume, row.v, row.vol);
      if (open === null || high === null || low === null || close === null) return null;
      return { time: new Date(ms).toISOString(), open, high, low, close, volume: volume ?? undefined };
    })
    .filter(Boolean);
}

// resolution: one of GMGN's supported buckets — "1m" | "5m" | "15m" | "1h" | "4h" | "1d".
// fromTs/toTs: unix seconds. chain: "sol" for everything this project deals with.
async function fetchGmgnKline(mintAddress, resolution, fromTs, toTs, chain = "sol") {
  if (!mintAddress) return [];
  if (!process.env.GMGN_API_KEY) return []; // silently n/a, same pattern as the rest of this file
  try {
    const raw = await runGmgnCli([
      "market",
      "kline",
      "--chain",
      chain,
      "--address",
      mintAddress,
      "--resolution",
      resolution,
      "--from",
      String(fromTs),
      "--to",
      String(toTs),
    ]);
    const candles = parseKline(raw);
    // GMGN's own ordering isn't documented either — enforce ascending like
    // every other candle source in this app so indicators.js is safe.
    candles.sort((a, b) => new Date(a.time) - new Date(b.time));
    return candles;
  } catch (err) {
    console.error("[gmgn] market kline failed:", err.message);
    return [];
  }
}

function pct(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n; // handles both 0-1 ratio and already-percent shapes
}

function parseSecurity(raw) {
  const d = raw?.data ?? raw ?? {};
  return {
    source: "GMGN Token Security",
    rugRatioPercent: pct(d.rug_ratio),
    top10HolderPercent: pct(d.top_10_holder_rate),
    insiderPercent: pct(d.rat_trader_amount_rate ?? d.suspected_insider_hold_rate),
    bundlerPercent: pct(d.bundler_trader_amount_rate),
    sniperCount: d.sniper_count ?? null,
    freshWalletPercent: pct(d.fresh_wallet_rate),
    isWashTrading: typeof d.is_wash_trading === "boolean" ? d.is_wash_trading : null,
    mintRenounced: typeof d.renounced_mint === "boolean" ? d.renounced_mint : null,
    freezeRenounced: typeof d.renounced_freeze_account === "boolean" ? d.renounced_freeze_account : null,
    lpBurnStatus: d.burn_status ?? null,
    isHoneypot: typeof d.is_honeypot === "boolean" ? d.is_honeypot : null,
  };
}

// chain: "sol" for everything this project deals with (Solana memecoins).
async function fetchGmgnTokenSecurity(mintAddress, chain = "sol") {
  if (!mintAddress) return null;
  if (!process.env.GMGN_API_KEY) return null; // silently n/a, same pattern as fetchTokenSecurity in marketdata.js
  try {
    const raw = await runGmgnCli(["token", "security", "--chain", chain, "--address", mintAddress]);
    return parseSecurity(raw);
  } catch (err) {
    console.error("[gmgn] token security failed:", err.message);
    return null;
  }
}

module.exports = { fetchGmgnTokenSecurity, fetchGmgnKline };
