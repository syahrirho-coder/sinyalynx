// lib/kvStore.js
// Netlify Blobs -> Vercel replacement. Netlify Blobs was a simple
// key/value JSON store; Vercel's closest equivalent is Vercel KV
// (Upstash Redis under the hood, via @vercel/kv). This wraps @vercel/kv
// behind the SAME tiny interface lib/dailySignal.js already expects
// (store.get(key, {type:'json'}) / store.setJSON(key, value)), so
// dailySignal.js itself needed ZERO changes when moving off Netlify.
//
// SETUP REQUIRED: in the Vercel dashboard, go to your project -> Storage ->
// Create Database -> KV (Upstash), then connect it to this project. Vercel
// auto-injects KV_REST_API_URL / KV_REST_API_TOKEN as env vars once
// connected — no manual key copying needed.

const { kv } = require("@vercel/kv");

function openStore() {
  return {
    async get(key, opts = {}) {
      const val = await kv.get(key);
      if (val === null || val === undefined) return null;
      // @vercel/kv already returns parsed JSON for JSON-serializable values
      // (it stores as JSON under the hood), so opts.type === 'json' is a
      // no-op here — kept as a parameter only for interface compatibility.
      return val;
    },
    async setJSON(key, value) {
      await kv.set(key, value);
      return value;
    },
  };
}

module.exports = { openStore };
