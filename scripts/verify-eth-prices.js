#!/usr/bin/env node
/**
 * Compare data/eth-prices.json to CoinGecko /coins/ethereum/history for the **website Close**
 * for each UTC calendar key D: the API must be called with `date` = D+1 (UTC). See coinGeckoHistoryQueryDate.
 *
 * Usage (from repo root):
 *   export COINGECKO_API_KEY="..."   # or VITE_COINGECKO_API_KEY
 *   node scripts/verify-eth-prices.js
 *
 * Optional env:
 *   VERIFY_START_DATE=2026-04-16
 *   VERIFY_END_DATE=2026-05-03     (default: today UTC)
 *   VERIFY_SLEEP_MS=2100
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETH_PRICES_FILE = path.join(__dirname, "..", "data", "eth-prices.json");
const TOLERANCE_REL = 0.008;
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

/** Website Close for UTC day `dateKey` → CoinGecko `date` query string (D+1). */
async function fetchCoinGeckoCloseForUtcDay(dateKey, apiKey) {
  const apiDayKey = addDaysUtc(dateKey, 1);
  const dateString = dateKeyToDdMmYyyy(apiDayKey);
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  const headers = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${dateKey} (API date ${dateString}): ${body.slice(0, 200)}`);
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

  let ok = 0;
  const failed = [];

  for (const dateKey of keys) {
    const stored = prices[dateKey];
    try {
      const api = await fetchCoinGeckoCloseForUtcDay(dateKey, apiKey);
      await sleep(SLEEP_MS);
      if (matchPair(stored, api)) {
        ok++;
        console.log(`${dateKey}  OK (CoinGecko API date = next UTC day)`);
      } else {
        failed.push({ dateKey, stored, api });
        console.log(`${dateKey}  MISMATCH`);
      }
    } catch (e) {
      failed.push({ dateKey, error: e.message });
      console.log(`${dateKey}  ERROR: ${e.message}`);
      await sleep(SLEEP_MS);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`OK:     ${ok}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length) {
    console.log("\nDetails:");
    console.log(JSON.stringify(failed, null, 2));
  }

  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
