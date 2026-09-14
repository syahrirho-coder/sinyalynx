// lib/kvStore.js
// Netlify Blobs -> Vercel replacement. Netlify Blobs was a simple
// key/value JSON store. "Vercel KV" (the old @vercel/kv package) has been
// fully sunset — Vercel now points everyone to the Marketplace, where the
// equivalent product is Upstash Redis via the @upstash/redis package.
// This wraps @upstash/redis behind the SAME tiny interface
// lib/dailySignal.js already expects (store.get(key, {type:'json'}) /
// store.setJSON(key, value)), so dailySignal.js itself needs ZERO changes.
//
// SETUP REQUIRED: in the Vercel dashboard, go to your project -> Storage ->
// Marketplace -> Upstash Redis (or "Redis"), create a database, then
// connect it to this project. Vercel auto-injects
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN as env vars once
// connected — no manual key copying needed. Redeploy after connecting so
// the new env vars actually reach the running deployment.

const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv();

function openStore() {
  return {
    async get(key, opts = {}) {
      const val = await redis.get(key);
      if (val === null || val === undefined) return null;
      // @upstash/redis already returns parsed JSON for JSON-serializable
      // values stored via .set(), so opts.type === 'json' is a no-op here —
      // kept as a parameter only for interface compatibility.
      return val;
    },
    async setJSON(key, value) {
      await redis.set(key, value);
      return value;
    },
  };
}

module.exports = { openStore };
