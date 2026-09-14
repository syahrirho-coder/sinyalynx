// lib/groq.js
// Thin wrapper around Groq's OpenAI-compatible chat completions API that
// asks the model to return strict JSON describing a trading signal, then
// parses it safely. Supports many keys via a single comma-separated
// GROQ_KEYS var, or GROQ_API_KEY_1..GROQ_API_KEY_10, or a single
// GROQ_API_KEY — same rotation pattern as lib/twelvedata.js and the old
// lib/gemini.js.
//
// Key attempts are staggered (not one-by-one, not all-at-once) and the
// first key to return a usable signal wins; the rest are aborted. See
// lib/gemini.js history for why: fully sequential chains too many
// round-trips when early keys are rate-limited, fully parallel burns every
// key's quota on every request even when key #1 is healthy.
//
// Exposes the SAME shape as the old lib/gemini.js (callGroq({system,
// userText, image}) -> parsed signal object) so generate.js and
// analyze-chart.js only need a one-line import swap.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// openai/gpt-oss-120b: OpenAI's open-weight reasoning model, hosted on
// Groq's fast inference hardware. Best "intelligence" available on Groq
// for a structured-JSON reasoning task like this one. Override via
// GROQ_MODEL env var without touching code.
const TEXT_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// qwen/qwen3.6-27b: satu-satunya model vision (multimodal) yang masih
// aktif di Groq per pertengahan 2026 — meta-llama/llama-4-scout dan
// qwen/qwen3-32b sudah di-deprecated Groq (17 Juni 2026). Catatan: Groq
// menandai qwen3.6-27b sebagai model "preview" (untuk evaluasi, bisa
// berubah/dihentikan sewaktu-waktu tanpa pemberitahuan panjang) — bukan
// "production" seperti GPT-OSS. Kalau di kemudian hari Groq
// men-deprecated ini juga, cek console.groq.com/docs/models untuk model
// vision pengganti. Override via GROQ_VISION_MODEL.
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";

// reasoning_effort only applies to openai/gpt-oss-* models on Groq (low /
// medium / high). Ignored by other models (Llama, Qwen, etc). Default
// "low" keeps latency down for a plain JSON-extraction task — bump via
// GROQ_REASONING_EFFORT if you want deeper reasoning at the cost of speed.
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT || "low";

const SIGNAL_JSON_SPEC = `Balas HANYA dengan satu objek JSON valid, tanpa teks lain, tanpa markdown fence, dengan bentuk persis:
{
  "direction": "BUY" | "SELL",
  "headline": string (maks 18 kata, ringkasan alasan sinyal, bahasa Indonesia),
  "entry": number,
  "stop_loss": number,
  "take_profit_1": number,
  "take_profit_2": number,
  "take_profit_3": number,
  "risk_reward": string (contoh "1:2.0"),
  "confidence": number (0-100),
  "technical_summary": string (3-5 kalimat bahasa Indonesia, jelaskan alasan teknikal secara spesifik menggunakan angka indikator yang diberikan, dan sebut data komposit seperti funding rate/long-short/orderbook/dominansi kalau tersedia),
  "invalidation": string (1-2 kalimat bahasa Indonesia, kondisi harga yang membatalkan sinyal ini),
  "data_considered": array of string (daftar singkat nama data/indikator yang BENAR-BENAR kamu pakai untuk sinyal ini, ambil hanya dari yang datanya diberikan dan bernilai valid — jangan sebut data yang tidak diberikan atau bernilai n/a)
}
Aturan angka: entry, stop_loss, take_profit_1/2/3 harus konsisten dengan arah sinyal (untuk BUY: SL di bawah entry, TP1<TP2<TP3 di atas entry; untuk SELL kebalikannya), dan realistis terhadap harga & ATR yang diberikan. Balas dalam format JSON.`;

function getKeys() {
  const keys = [];
  if (process.env.GROQ_KEYS) {
    process.env.GROQ_KEYS.split(",").forEach((k) => {
      if (k.trim()) keys.push(k.trim());
    });
  }
  if (keys.length === 0) {
    for (let i = 1; i <= 10; i++) {
      const k = process.env[`GROQ_API_KEY_${i}`];
      if (k && k.trim()) keys.push(k.trim());
    }
  }
  if (keys.length === 0 && process.env.GROQ_API_KEY) {
    keys.push(process.env.GROQ_API_KEY.trim());
  }
  return keys;
}

// Groq/OpenAI-shaped errors come back as { error: { message, type, code } }.
// 429 = rate limit / quota, 401 = bad/revoked key.
function describeFailure(httpStatus, errType, message) {
  if (httpStatus === 429) return `rate limit (${message})`;
  if (httpStatus === 401 || errType === "invalid_api_key" || errType === "authentication_error")
    return `key invalid/revoked (${message})`;
  return message;
}

// One attempt against a single key. Rejects on any failure (bad key, rate
// limit, malformed JSON) so Promise.any() below just moves on to whichever
// other key wins first.
async function attemptKey(key, keyIndex, body, signal) {
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err; // another key won, this one was cancelled
    throw new Error(`key #${keyIndex + 1} network error: ${err.message}`);
  }

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const errType = json?.error?.type || json?.error?.code;
    const message = json?.error?.message || res.statusText;
    throw new Error(`key #${keyIndex + 1}: ${describeFailure(res.status, errType, message)}`);
  }

  const choice = json?.choices?.[0];
  // Distinct from an empty response: Groq/OpenAI-shaped models sometimes
  // stop early with finish_reason "length" or "content_filter".
  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    throw new Error(`key #${keyIndex + 1}: model menghentikan respons lebih awal (finish_reason: ${choice.finish_reason}).`);
  }

  const text = choice?.message?.content;
  if (!text) throw new Error(`key #${keyIndex + 1}: model tidak mengembalikan teks.`);

  return parseSignalJson(text); // throws (and thus rejects) if not valid signal JSON
}

async function callGroq({ system, userText, image, keyOffset = 0 }) {
  const keys = getKeys();
  if (keys.length === 0) {
    throw new Error(
      "Tidak ada Groq API key yang dikonfigurasi (GROQ_KEYS, GROQ_API_KEY_1..GROQ_API_KEY_10, atau GROQ_API_KEY)."
    );
  }

  const model = image ? VISION_MODEL : TEXT_MODEL;
  const isGptOss = /^openai\//.test(model);
  // qwen/* ships with "thinking mode" on by default, which prefixes the raw
  // output with a <think>...</think> reasoning block before the actual JSON.
  // That breaks Groq's strict json_object validator ("Gagal memproses
  // permintaan." on the frontend) — this is what was happening on every
  // "Analisa Chart" call since VISION_MODEL defaults to a qwen model. Force
  // thinking off so the response is pure JSON.
  const isQwen = /^qwen\//.test(model);

  const userContent = image
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
      ]
    : userText;

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    max_completion_tokens: 1200,
    response_format: { type: "json_object" },
    // reasoning_effort is only understood by openai/gpt-oss-* models;
    // other Groq models ignore/reject unknown params silently in some
    // cases but to be safe we only send it when relevant.
    ...(isGptOss ? { reasoning_effort: REASONING_EFFORT } : {}),
    // qwen/* uses reasoning_effort: "none" to fully disable thinking mode.
    ...(isQwen ? { reasoning_effort: "none" } : {}),
    // Safety net for any other reasoning-capable model that can't fully
    // disable thinking via reasoning_effort: at least strip reasoning
    // tokens from the visible output.
    ...(!isGptOss && !isQwen ? { reasoning_format: "hidden" } : {}),
  };

  // Hard cap for the WHOLE call (all keys combined), so we never blow past
  // Netlify's function timeout no matter how many keys we end up trying.
  // Netlify Free sync functions get killed at 10s (Pro gets 26s) — this
  // MUST stay comfortably under whichever one applies, or Netlify kills
  // the function itself and the frontend gets an HTML error page back
  // instead of the JSON error this abort path is meant to produce.
  const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS) || 8000;
  // Gap between staggered key launches: fire key 1, only bring in the next
  // key if the ones already in flight haven't produced a winner yet.
  // Healthy first key -> only 1 key's quota spent, same latency as before.
  // Bad/slow first key -> falls through to the next one, still bounded by
  // GROQ_TIMEOUT_MS overall.
  // Fixed at 2500ms this would only fit ~4 keys inside an 8s budget before
  // the overall abort fires (last key launched at 2500*(n-1) needs time to
  // respond too) — with 6+ keys configured, keys 5/6 would never even get
  // launched. Scale the gap down as more keys are configured so the full
  // rotation always fits, reserving 2s at the end for the last-launched
  // key to actually get a response back.
  const STAGGER_MS = Math.max(600, Math.min(2500, Math.floor((GROQ_TIMEOUT_MS - 2000) / Math.max(1, keys.length - 1))));
  const controller = new AbortController();
  let timedOutFlag = false;
  const overallTimer = setTimeout(() => {
    timedOutFlag = true;
    controller.abort();
  }, GROQ_TIMEOUT_MS);

  // When many combos are generated concurrently (see dailySignal.js batch),
  // every call used to start with key #1, so a batch of N concurrent calls
  // slammed key #1 with N requests at once (and then key #2, staggered the
  // same way) — that's what was blowing past Groq's per-key TPM limit even
  // with multiple keys configured. keyOffset lets the caller rotate which
  // key each concurrent call tries FIRST, so a batch spreads its load
  // across all configured keys instead of piling onto one.
  const rotate = (i) => (i + keyOffset) % keys.length;

  const attempts = [];
  const staggerTimers = [];
  let settled = false;

  function launch(i) {
    if (settled || i >= keys.length) return;
    const k = rotate(i);
    const p = attemptKey(keys[k], k, body, controller.signal);
    // Attach a no-op handler IMMEDIATELY so Node never sees this promise as
    // unhandled. Without this, a key that fails fast (e.g. an instant 429)
    // can reject before Promise.any() below gets a chance to attach its own
    // handler — since we only call Promise.any() after waiting (via the
    // setInterval below) for every staggered key to finish launching, which
    // can take seconds. An unhandled rejection in that gap crashes the
    // WHOLE function immediately (visible in logs as a raw "Error: key #N:
    // rate limit" followed by "Node.js vX.Y.Z" — a hard process exit) —
    // which is why rotation appeared to stop after only 2 of 6 keys instead
    // of trying the rest. The real Promise.any(attempts) call further down
    // still sees every rejection normally; this only stops the premature
    // crash.
    p.catch(() => {});
    attempts.push(p);
    if (i + 1 < keys.length) {
      staggerTimers.push(setTimeout(() => launch(i + 1), STAGGER_MS));
    }
  }
  launch(0);

  // Wait until every key has either been launched or we aborted early,
  // then Promise.any over the full attempts array.
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (attempts.length === keys.length) {
        clearInterval(check);
        resolve();
      }
    }, 50);
    controller.signal.addEventListener("abort", () => {
      clearInterval(check);
      resolve();
    });
  });

  try {
    const result = await Promise.any(attempts);
    settled = true;
    clearTimeout(overallTimer);
    staggerTimers.forEach(clearTimeout);
    controller.abort(); // cancel whichever other key requests are still in flight
    return result;
  } catch (aggregateErr) {
    settled = true;
    clearTimeout(overallTimer);
    staggerTimers.forEach(clearTimeout);
    const timedOut = timedOutFlag;
    const errList = aggregateErr.errors || [aggregateErr];
    const messages = errList.map((e) => e?.message).filter(Boolean).join(" | ");
    const allExhausted =
      attempts.length > 0 && errList.every((e) => /rate limit/i.test(e?.message || ""));
    if (allExhausted) {
      throw new Error(
        `Semua ${attempts.length} Groq API key yang dicoba kena rate limit (kuota habis). Detail: ${messages}`
      );
    }
    if (timedOut) {
      throw new Error(
        `Semua key yang dicoba melebihi batas waktu ${GROQ_TIMEOUT_MS / 1000}s. Detail: ${messages}`
      );
    }
    throw new Error(`Semua ${attempts.length} Groq API key gagal / kena limit. Detail: ${messages}`);
  }
}

function parseSignalJson(text) {
  // Strip accidental ```json fences and grab the outermost {...} block.
  // (response_format: json_object should already guarantee pure JSON, but
  // this stays as a safety net the same way lib/gemini.js had one.)
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Respons Groq bukan JSON yang valid.");
  }
  const jsonStr = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(jsonStr);

  const required = [
    "direction",
    "headline",
    "entry",
    "stop_loss",
    "take_profit_1",
    "take_profit_2",
    "take_profit_3",
    "risk_reward",
    "confidence",
    "technical_summary",
    "invalidation",
    "data_considered",
  ];
  for (const key of required) {
    if (!(key in parsed)) throw new Error(`Field "${key}" hilang dari respons Groq.`);
  }
  return parsed;
}

module.exports = { callGroq, SIGNAL_JSON_SPEC, TEXT_MODEL, VISION_MODEL, getKeys };
