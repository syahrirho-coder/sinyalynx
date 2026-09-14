// lib/solanaOnchain.js
// Direct, keyless on-chain checks via a public Solana JSON-RPC endpoint —
// no third-party indexer, no API key. Two things GMGN/4Stock-style tools
// show that we can verify ourselves, more authoritatively than any
// aggregator (this reads the actual mint account, not someone's cache of it):
//   1. Mint/freeze authority status (renounced or not)
//   2. Top-holder concentration (top 10 largest token accounts vs supply)
//
// NOT available this way (would need a paid indexer like Helius/Solscan):
// total holder COUNT (RPC only exposes the top 20 largest accounts, not a
// full holder list), KOL call/mention counts, "phishing wallet %". These
// are left out rather than faked.
//
// Public RPC (api.mainnet-beta.solana.com) is rate-limited and not meant
// for production traffic. Set SOLANA_RPC_URL to a free-tier RPC (Helius,
// QuickNode, etc.) for reliability — see README.

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const FETCH_TIMEOUT_MS = 6000;

async function rpcCall(method, params) {
  const url = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j.error) return null;
    return j.result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reads the SPL token mint account directly and checks its authority
// fields. mintAuthorityRevoked/freezeAuthorityRevoked === true means the
// dev can no longer mint more supply / freeze holders' wallets — a
// standard rug-risk check, done here from the actual on-chain account
// instead of trusting a third party's report of it.
async function fetchMintAuthorityStatus(mintAddress) {
  if (!mintAddress) return null;
  const result = await rpcCall("getAccountInfo", [mintAddress, { encoding: "jsonParsed" }]);
  const parsed = result?.value?.data?.parsed?.info;
  if (!parsed) return null;
  return {
    mintAuthorityRevoked: parsed.mintAuthority === null,
    freezeAuthorityRevoked: parsed.freezeAuthority === null,
    decimals: parsed.decimals ?? null,
    supply: parsed.supply ?? null,
  };
}

// Top-10 largest token-account concentration as a % of total supply.
// This is NOT the same as "top 10 holders" from an indexer that has
// already merged multiple accounts per wallet or excluded LP/burn
// addresses — it's the raw top 10 SPL token ACCOUNTS, which usually
// includes the liquidity pool's own account (often the single largest).
// That's disclosed explicitly in the returned shape so the AI/prompt
// doesn't misread "pool liquidity" as "one whale holds 40%".
async function fetchTopHolderConcentration(mintAddress) {
  if (!mintAddress) return null;
  const [largest, supplyResult] = await Promise.all([
    rpcCall("getTokenLargestAccounts", [mintAddress]),
    rpcCall("getTokenSupply", [mintAddress]),
  ]);
  const accounts = largest?.value;
  const totalSupply = Number(supplyResult?.value?.amount);
  if (!Array.isArray(accounts) || accounts.length === 0 || !Number.isFinite(totalSupply) || totalSupply <= 0) return null;

  const top10Sum = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount || 0), 0);
  return {
    top10Percent: (top10Sum / totalSupply) * 100,
    accountsChecked: Math.min(accounts.length, 10),
    note: "Termasuk kemungkinan akun pool likuiditas itu sendiri (bukan cuma wallet individu) — bukan angka 'holder' murni.",
  };
}

module.exports = { fetchMintAuthorityStatus, fetchTopHolderConcentration };
