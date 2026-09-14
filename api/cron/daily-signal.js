// api/cron/daily-signal.js
// Vercel Cron target (see vercel.json "crons") — replaces Netlify's
// scheduled-function daily-signal-cron.js. Pre-warms today's daily signals
// so users never wait for live generation. Runs every 2 hours; each call
// only chews through one batch (DAILY_SIGNAL_BATCH_SIZE in lib/dailySignal.js)
// so the full 27-combo pool gets covered gradually across the day.
//
// SECURITY: Vercel signs cron-triggered requests with an
// `Authorization: Bearer <CRON_SECRET>` header IF you set a CRON_SECRET env
// var in your project. Set one and this checks it, so randoms on the
// internet can't repeatedly trigger (and burn your Groq/TwelveData quota
// on) this endpoint. If CRON_SECRET isn't set, the check is skipped (fine
// for local dev, not recommended for production).
const { openStore } = require("../../lib/kvStore");
const { ensureTodaySignals, TOTAL_COMBOS } = require("../../lib/dailySignal");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "Unauthorized." });
    }
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const store = openStore();

    const result = await ensureTodaySignals(store, today);
    const analyzed = (result.done || []).length;
    const pending = (result.pending || []).length;
    const accepted = Object.values(result.results || {}).reduce((sum, arr) => sum + arr.length, 0);

    if (!result.generated) {
      console.log(`[daily-signal-cron] ${today}: sudah selesai semua ${TOTAL_COMBOS} combo untuk hari ini, skip.`);
    } else {
      console.log(`[daily-signal-cron] ${today}: ${analyzed}/${TOTAL_COMBOS} combo dianalisa (${pending} tersisa), ${accepted} sinyal lolos confidence filter sejauh ini.`);
    }

    return res.status(200).json({ ok: true, analyzed, pending, accepted, total_combos: TOTAL_COMBOS });
  } catch (err) {
    console.error("[daily-signal-cron] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
