// api/daily-signal-history.js — GET /api/daily-signal-history?style=scalping&limit=14
const { openStore } = require("../lib/kvStore");
const { getHistory, STYLES } = require("../lib/dailySignal");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  try {
    const params = req.query || {};
    const style = params.style;
    if (!STYLES.includes(style)) {
      return json(res, 400, { error: `Parameter style wajib salah satu dari: ${STYLES.join(", ")}` });
    }
    const limit = Math.max(1, Math.min(60, Number(params.limit) || 14));

    const store = openStore();
    const result = await getHistory(store, style, limit);

    return json(res, 200, result);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
};

function json(res, statusCode, body) {
  res.status(statusCode).setHeader("content-type", "application/json").send(JSON.stringify(body));
}
