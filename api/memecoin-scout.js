// api/memecoin-scout.js — GET /api/memecoin-scout
// Auto-discovers & ranks Solana memecoin candidates via Groq — see
// lib/memecoinScout.js for the full explanation of why this returns a
// relative "skor_potensi_spekulatif" instead of a fake success probability
// or a promised price multiplier.
const { runMemecoinScout } = require("../lib/memecoinScout");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  try {
    const result = await runMemecoinScout();
    return json(res, 200, result);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
};

function json(res, statusCode, body) {
  res.status(statusCode).setHeader("content-type", "application/json").send(JSON.stringify(body));
}
