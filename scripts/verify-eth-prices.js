#!/usr/bin/env node
/**
 * Compare data/eth-prices.json to live CoinGecko /coins/ethereum/history for the same UTC date
 * and for the previous UTC date — detects a systematic "off by one calendar day" mis-keying.
 *
 * Usage (from repo root):
 *   export COINGECKO_API_KEY="..."   # or VITE_COINGECKO_API_KEY
 *   node scripts/verify-eth-prices.js
 *
 * Optional env:
 *   VERIFY_START_DATE=2026-04-16   (default 2026-04-16)
 *   VERIFY_END_DATE=2026-05-03     (default: today UTC)
 *   VERIFY_SLEEP_MS=2100           (delay between CoinGecko calls; default 2100)
 *
 * CoinGecko free/demo tier is rate-limited; expect ~2s per request.
 */

const fs = require("fs");
const path = require("path");

const ETH_PRICES_FILE = path.join(__dirname, "..", "data", "eth-prices.json");
const TOLERANCE_REL = 0.008; // 0.8% — small API / rounding drift vs stored snapshot
const TOLERANCE_ABS = 1.0;

const START = process.env.VERIFY_START_DATE || "2026-04-16";
const SLEEP_MS = Math.max(500, Number(process.env.VERIFY_SLEEP_MS || "2100"));

function todayUtcDateKey() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

const END = process.env.VERIFY_END_DATE || todayUtcDateKey();

function dateKeyToDdMmYyyy(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y}`;
}

function addDaysUtc(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const n = new Date(t + deltaDays * 86400000);
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function close(a, b) {
  if (a == null || b == null) return false;
  if (Math.abs(a - b) <= TOLERANCE_ABS) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom <= TOLERANCE_REL;
}

function matchPair(stored, api) {
  if (!stored || api.eur == null || api.usd == null) return false;
  return close(stored.eur, api.eur) && close(stored.usd, api.usd);
}

async function fetchCoinGeckoHistory(dateKey, apiKey) {
  const dateString = dateKeyToDdMmYyyy(dateKey);
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  const headers = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${dateKey} (${dateString}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const eur = data.market_data?.current_price?.eur;
  const usd = data.market_data?.current_price?.usd;
  return { eur, usd };
}

async function main() {
  const apiKey = process.env.COINGECKO_API_KEY || process.env.VITE_COINGECKO_API_KEY || "";
  if (!apiKey) {
    console.error("Set COINGECKO_API_KEY or VITE_COINGECKO_API_KEY to call CoinGecko.");
    process.exit(1);
  }

  const raw = fs.readFileSync(ETH_PRICES_FILE, "utf8");
  const prices = JSON.parse(raw);

  const keys = Object.keys(prices)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k >= START && k <= END)
    .sort();

  console.log(`File: ${ETH_PRICES_FILE}`);
  console.log(`Range: ${START} .. ${END} (${keys.length} keys)\n`);

  let sameOnly = 0;
  let prevOnly = 0;
  let both = 0;
  let neither = 0;
  const prevBetter = [];
  const ambiguous = [];
  const failed = [];

  for (const dateKey of keys) {
    const stored = prices[dateKey];
    const prevKey = addDaysUtc(dateKey, -1);

    try {
      const apiSame = await fetchCoinGeckoHistory(dateKey, apiKey);
      await sleep(SLEEP_MS);
      const apiPrev = await fetchCoinGeckoHistory(prevKey, apiKey);
      await sleep(SLEEP_MS);

      const mSame = matchPair(stored, apiSame);
      const mPrev = matchPair(stored, apiPrev);

      if (mSame && mPrev) both++;
      else if (mSame && !mPrev) sameOnly++;
      else if (!mSame && mPrev) {
        prevOnly++;
        prevBetter.push({
          dateKey,
          stored,
          coinGeckoSameDay: apiSame,
          coinGeckoPreviousDay: apiPrev,
        });
      } else {
        neither++;
        ambiguous.push({
          dateKey,
          stored,
          coinGeckoSameDay: apiSame,
          coinGeckoPreviousDay: apiPrev,
        });
      }

      const tag = mSame && !mPrev ? "OK same-day" : !mSame && mPrev ? "SHIFT? prev-day" : mSame && mPrev ? "both?" : "mismatch";
      console.log(`${dateKey}  ${tag}`);
    } catch (e) {
      failed.push({ dateKey, error: e.message });
      console.log(`${dateKey}  ERROR: ${e.message}`);
      await sleep(SLEEP_MS);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Matches CoinGecko for SAME key date only:     ${sameOnly}`);
  console.log(`Matches CoinGecko for PREVIOUS day only:      ${prevOnly}`);
  console.log(`Matches BOTH same and previous (ambiguous):   ${both}`);
  console.log(`Matches neither within tolerance:           ${neither}`);
  console.log(`Fetch errors:                                 ${failed.length}`);

  if (prevBetter.length) {
    console.log(
      "\nInterpretation: rows where stored values align with CoinGecko's *previous* calendar day " +
        "more than the key date — consistent with a one-day mis-keying for those rows.\n"
    );
    console.log(JSON.stringify(prevBetter, null, 2));
  }

  if (ambiguous.length && !prevBetter.length) {
    console.log("\nRows that did not match either day within tolerance (review manually):");
    console.log(JSON.stringify(ambiguous, null, 2));
  }

  if (failed.length) {
    console.log("\nErrors:");
    console.log(JSON.stringify(failed, null, 2));
  }

  process.exit(prevBetter.length || neither || failed.length ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
