// api/daily-signal.js — GET /api/daily-signal?date=YYYY-MM-DD (tab "Signal Harian")
const { openStore } = require("../lib/kvStore");
const { ensureTodaySignals, TOTAL_COMBOS } = require("../lib/dailySignal");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  try {
    const params = req.query || {};
    const today = new Date().toISOString().slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date || "") ? params.date : today;
    const isToday = date === today;
    const forceRefresh = isToday && (params.refresh === "1" || params.refresh === "true");

    const store = openStore();

    // Usually just a cache read (the Vercel Cron job in api/cron/daily-signal.js
    // pre-warms this incrementally through the day). For today, this also
    // processes one more batch of the pending pool if there's work left.
    const result = isToday ? await ensureTodaySignals(store, date, { forceRefresh }) : await store.get(`progress-${date}`, { type: "json" });

    if (!result) {
      return json(res, 200, {
        date,
        by_style: { scalping: [], daytrade: [], swing: [] },
        analyzed: 0,
        total_combos: TOTAL_COMBOS,
        pending: 0,
      });
    }

    return json(res, 200, {
      date,
      by_style: result.results || { scalping: [], daytrade: [], swing: [] },
      analyzed: (result.done || []).length,
      total_combos: TOTAL_COMBOS,
      pending: (result.pending || []).length,
      ...(result.errors && result.errors.length > 0 ? { generation_errors: result.errors } : {}),
    });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
};

function json(res, statusCode, body) {
  res.status(statusCode).setHeader("content-type", "application/json").send(JSON.stringify(body));
}
