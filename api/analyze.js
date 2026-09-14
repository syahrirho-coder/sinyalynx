// api/analyze.js — POST /api/analyze  (tab "Analisa Sendiri")
const { generateSignal } = require("../lib/generate");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method !== "POST") {
    return json(res, 405, { error: "Gunakan POST." });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!body.symbol) return json(res, 400, { error: "Parameter 'symbol' wajib diisi." });

    const result = await generateSignal({
      symbol: body.symbol,
      market: (body.market || "crypto").toLowerCase(),
      style: (body.style || "scalping").toLowerCase(),
    });

    return json(res, 200, result);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
};

function json(res, statusCode, body) {
  res.status(statusCode).setHeader("content-type", "application/json").send(JSON.stringify(body));
}
