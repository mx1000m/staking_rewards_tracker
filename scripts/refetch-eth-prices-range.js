#!/usr/bin/env node
/**
 * One-time: refetch CoinGecko ETH EUR/USD for each UTC calendar day in a range and merge into data/eth-prices.json.
 *
 * Uses the same mapping as daily-sync.js: CoinGecko /history?date= matches the **previous** calendar day's
 * website Close, so for stored UTC day D we request `date` = D+1 (UTC). No missing-price fallback.
 *
 * Usage (from repo root):
 *   export COINGECKO_API_KEY="..."
 *   node scripts/refetch-eth-prices-range.js
 *
 * Optional env:
 *   REFETCH_START=2026-04-16
 *   REFETCH_END=2026-05-02
 *   REFETCH_DRY_RUN=1   — log only, do not write the file
 *   ETH_PRICES_MIN_DATE=2026-04-16 — before write, delete stored keys strictly before this date (default 2026-04-16)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { coinGeckoHistoryDdMmYyyyFromUtcRewardDay } from "./lib/coinGeckoHistoryQueryDate.mjs";

/** Drop stored keys before this YYYY-MM-DD (inclusive history starts here). */
const MIN_STORED_DATE = process.env.ETH_PRICES_MIN_DATE || "2026-04-16";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETH_PRICES_FILE = path.join(__dirname, "..", "data", "eth-prices.json");
const MIN_REQUEST_INTERVAL = 2100;
let lastRequestTime = 0;

const START = process.env.REFETCH_START || "2026-04-16";
const END = process.env.REFETCH_END || "2026-05-02";
const DRY = ["1", "true", "yes"].includes(String(process.env.REFETCH_DRY_RUN || "").toLowerCase());

function utcMidnightTimestampSeconds(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Bad date key: ${dateKey}`);
  return Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000);
}

function addDaysUtc(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const n = new Date(t + deltaDays * 86400000);
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

function* iterateDateKeysInclusive(start, end) {
  let cur = start;
  if (cur > end) throw new Error(`Start ${start} after end ${end}`);
  while (cur <= end) {
    yield cur;
    cur = addDaysUtc(cur, 1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHistoryStrict(dateKey, currency, apiKey) {
  const ts = utcMidnightTimestampSeconds(dateKey);
  const dateString = coinGeckoHistoryDdMmYyyyFromUtcRewardDay(ts);

  const baseUrl = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  const headers = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  const now = Date.now();
  const wait = MIN_REQUEST_INTERVAL - (now - lastRequestTime);
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();

  const res = await fetch(baseUrl, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${dateKey} ${currency} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const v = data.market_data?.current_price?.[currency.toLowerCase()];
  if (v == null || Number.isNaN(v)) {
    throw new Error(`${dateKey} ${currency}: no market_data.current_price in response`);
  }
  return Number(v);
}

async function main() {
  const apiKey = process.env.COINGECKO_API_KEY || process.env.VITE_COINGECKO_API_KEY || "";
  if (!apiKey) {
    console.error("Set COINGECKO_API_KEY or VITE_COINGECKO_API_KEY.");
    process.exit(1);
  }

  const keys = [...iterateDateKeysInclusive(START, END)];
  console.log(`Refetch CoinGecko for ${keys.length} UTC day(s): ${START} .. ${END}`);
  console.log(DRY ? "DRY RUN — file will not be written.\n" : `Writing merge into ${ETH_PRICES_FILE}\n`);

  let raw = "{}";
  if (fs.existsSync(ETH_PRICES_FILE)) {
    raw = fs.readFileSync(ETH_PRICES_FILE, "utf8");
  }
  const prices = JSON.parse(raw);

  for (const dateKey of keys) {
    try {
      const eur = await fetchHistoryStrict(dateKey, "EUR", apiKey);
      const usd = await fetchHistoryStrict(dateKey, "USD", apiKey);
      const prev = prices[dateKey];
      console.log(
        `${dateKey}  EUR ${eur.toFixed(4)}  USD ${usd.toFixed(4)}` +
          (prev ? `  (was EUR ${prev.eur} USD ${prev.usd})` : "  (new)")
      );
      if (!DRY) prices[dateKey] = { eur, usd };
    } catch (e) {
      console.error(`${dateKey}  FAILED: ${e.message}`);
      process.exitCode = 1;
    }
  }

  if (DRY) {
    console.log("\nDry run complete. Unset REFETCH_DRY_RUN to write file.");
    return;
  }

  for (const k of Object.keys(prices)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k < MIN_STORED_DATE) {
      delete prices[k];
    }
  }

  const sortedKeys = Object.keys(prices).sort();
  const ordered = {};
  for (const k of sortedKeys) {
    ordered[k] = prices[k];
  }
  fs.writeFileSync(ETH_PRICES_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${ETH_PRICES_FILE} (${sortedKeys.length} total keys).`);
  console.log("Next: git add data/eth-prices.json && git commit && push (so beacon-sync raw URL sees new prices).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
