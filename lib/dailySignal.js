// netlify/functions/lib/dailySignal.js
// Shared logic for generating "today's" daily signals. Used by BOTH:
//   - daily-signal.js (HTTP endpoint the frontend polls)
//   - daily-signal-cron.js (scheduled job that pre-warms the cache)
// so the two never drift out of sync.
//
// Design: every pair in the pool gets checked against EVERY timeframe
// (scalping/daytrade/swing) — 9 pairs x 3 styles = 27 combos/day — and ANY
// combo that clears the confidence bar is kept (not just a fixed count of
// 2). That's too much work for one function invocation to do live (each
// combo is a TwelveData fetch + indicator crunch + Groq call), so it's
// processed incrementally: each call to ensureTodaySignals() chews through
// one bounded batch of the day's still-pending combos and persists
// progress, so the cron (which fires every few hours) gradually finishes
// the full pool over the day without ever risking a function timeout.
const { generateSignal } = require("./generate");

const POOL = [
  { symbol: "BTCUSDT", market: "crypto" },
  { symbol: "ETHUSDT", market: "crypto" },
  { symbol: "SOLUSDT", market: "crypto" },
  { symbol: "XRPUSDT", market: "crypto" },
  { symbol: "EURUSD", market: "forex" },
  { symbol: "GBPUSD", market: "forex" },
  { symbol: "USDJPY", market: "forex" },
  { symbol: "XAUUSD", market: "emas" },
  { symbol: "XAGUSD", market: "emas" },
];

const STYLES = ["scalping", "daytrade", "swing"];
const TOTAL_COMBOS = POOL.length * STYLES.length;

// A generated signal is only ACCEPTED if the model's own reported confidence
// clears this bar. Below it, the pick is discarded — not shown, not cached
// — instead of filling a slot with a low-conviction call just to have
// something to display. Override via env var if 70 is too strict/loose.
const MIN_CONFIDENCE = Number(process.env.DAILY_SIGNAL_MIN_CONFIDENCE || 70);

// How many of the day's still-pending pair+timeframe combos to process per
// call. Keep this low enough that a batch reliably finishes inside a single
// Netlify function invocation (each combo = TwelveData + indicators + Groq,
// a few seconds apiece) — the cron just keeps calling in and chipping away
// at the rest over the following runs.
const BATCH_SIZE = Number(process.env.DAILY_SIGNAL_BATCH_SIZE || 5);

// Transient failures (a flaky TwelveData/Groq call, not a "confidence too
// low" rejection) get requeued instead of being given up on permanently,
// but only up to this many extra tries so one bad symbol can't stall the
// whole day's pending queue forever.
const MAX_ATTEMPTS = 3;

// How many past days to keep in each timeframe's history log.
const HISTORY_MAX_DAYS = Number(process.env.DAILY_SIGNAL_HISTORY_DAYS || 30);

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromDate(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) | 0;
  return h;
}

// Deterministic shuffle of ALL pair x timeframe combos for a given date, so
// repeated calls the same day (and the cron re-running) agree on order, but
// which symbol gets analyzed first still varies day to day.
function allCombosForToday(dateStr) {
  const rand = mulberry32(seedFromDate(dateStr));
  const combos = [];
  for (const p of POOL) for (const style of STYLES) combos.push({ ...p, style, attempts: 0 });
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  return combos;
}

const PROGRESS_KEY_PREFIX = "progress-";
const HISTORY_KEY_PREFIX = "history-";

function emptyResults() {
  return { scalping: [], daytrade: [], swing: [] };
}

/**
 * Returns today's progress, processing one more batch of pending combos if
 * there's anything left to do. Safe to call repeatedly — once `pending` is
 * empty for the day, it's just a cache read.
 */
async function ensureTodaySignals(store, today, { forceRefresh = false } = {}) {
  const progressKey = `${PROGRESS_KEY_PREFIX}${today}`;

  let progress = forceRefresh ? null : await store.get(progressKey, { type: "json" });
  if (!progress || !Array.isArray(progress.pending) || !progress.results) {
    progress = {
      date: today,
      pending: allCombosForToday(today),
      done: [], // [{symbol, market, style, status: 'accepted'|'rejected'|'error'}]
      results: emptyResults(), // { scalping: [signal,...], daytrade: [...], swing: [...] }
      errors: [], // [{symbol, style, reason}]
    };
  }

  if (progress.pending.length === 0) {
    return { ...progress, total_combos: TOTAL_COMBOS, generated: false };
  }

  const batch = progress.pending.slice(0, BATCH_SIZE);
  const rest = progress.pending.slice(BATCH_SIZE);

  const outcomes = await Promise.all(
    batch.map(async (pick, i) => {
      try {
        // Spread this batch's concurrent Groq calls across the configured
        // keys (call #0 tries key #1 first, call #1 tries key #2 first,
        // etc.) instead of every one piling onto key #1 first — see the
        // comment in lib/groq.js for why that was blowing the per-key TPM
        // limit even with multiple keys on the account.
        const r = await generateSignal({ ...pick, keyOffset: i });
        const confidence = Number(r?.signal?.confidence);
        if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
          return {
            pick,
            status: "rejected",
            reason: `confidence ${Number.isFinite(confidence) ? confidence : "n/a"} di bawah minimum ${MIN_CONFIDENCE}`,
          };
        }
        return { pick, status: "accepted", result: r };
      } catch (e) {
        return { pick, status: "error", reason: e.message };
      }
    })
  );

  const requeued = [];
  const newlyAcceptedByStyle = { scalping: [], daytrade: [], swing: [] };

  for (const o of outcomes) {
    if (o.status === "error" && o.pick.attempts + 1 < MAX_ATTEMPTS) {
      requeued.push({ ...o.pick, attempts: o.pick.attempts + 1 });
      continue; // don't record as done yet — will retry in a later batch
    }
    progress.done.push({ symbol: o.pick.symbol, market: o.pick.market, style: o.pick.style, status: o.status });
    if (o.status === "accepted") {
      progress.results[o.pick.style].push(o.result);
      newlyAcceptedByStyle[o.pick.style].push(o.result);
    } else {
      progress.errors.push({ symbol: o.pick.symbol, style: o.pick.style, reason: o.reason });
    }
  }

  progress.pending = [...rest, ...requeued];

  await store.setJSON(progressKey, progress);

  for (const style of STYLES) {
    if (newlyAcceptedByStyle[style].length > 0) {
      await upsertHistory(store, style, today, newlyAcceptedByStyle[style]);
    }
  }

  return { ...progress, total_combos: TOTAL_COMBOS, generated: true };
}

async function upsertHistory(store, style, date, newSignals) {
  const key = `${HISTORY_KEY_PREFIX}${style}`;
  let hist = await store.get(key, { type: "json" });
  if (!hist || !Array.isArray(hist.entries)) hist = { style, entries: [] };

  let entry = hist.entries.find((e) => e.date === date);
  if (!entry) {
    entry = { date, signals: [] };
    hist.entries.push(entry);
  }
  entry.signals.push(...newSignals);

  hist.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  if (hist.entries.length > HISTORY_MAX_DAYS) hist.entries = hist.entries.slice(0, HISTORY_MAX_DAYS);

  await store.setJSON(key, hist);
}

/** Read-only: past days' accepted signals for one timeframe, newest first. */
async function getHistory(store, style, limit = 14) {
  const key = `${HISTORY_KEY_PREFIX}${style}`;
  const hist = await store.get(key, { type: "json" });
  const entries = hist && Array.isArray(hist.entries) ? hist.entries : [];
  return { style, entries: entries.slice(0, limit) };
}

module.exports = {
  ensureTodaySignals,
  getHistory,
  POOL,
  STYLES,
  TOTAL_COMBOS,
  MIN_CONFIDENCE,
};
