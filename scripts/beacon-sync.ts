/**
 * Dune-based beacon sync: writes daily CL/EL rewards to Firestore.
 * Uses saved Dune queries and keeps transaction schema compatible with dashboard.
 */

import { initializeApp, getApps, getApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const ETH_PRICES_URL =
  "https://raw.githubusercontent.com/mx1000m/staking_rewards_tracker/main/data/eth-prices.json";

const DUNE_API_BASE = "https://api.dune.com/api/v1";
const DUNE_API_KEY = process.env.DUNE_API_KEY || "";
const DUNE_QUERY_ID_CL = process.env.DUNE_QUERY_ID_CL || "";
const DUNE_QUERY_ID_EL = process.env.DUNE_QUERY_ID_EL || "";
const DUNE_QUERY_ID_EL_FALLBACK = process.env.DUNE_QUERY_ID_EL_FALLBACK || "";
const BOOTSTRAP_UID = process.env.BOOTSTRAP_UID || "";
const BOOTSTRAP_TRACKER_ID = process.env.BOOTSTRAP_TRACKER_ID || "tracker-primary";
const BOOTSTRAP_TRACKER_NAME = process.env.BOOTSTRAP_TRACKER_NAME || "Validator";
const BOOTSTRAP_WALLET_ADDRESS = process.env.BOOTSTRAP_WALLET_ADDRESS || "";
const BOOTSTRAP_TAX_RATE = Number(process.env.BOOTSTRAP_TAX_RATE || "24");
const BOOTSTRAP_COUNTRY = process.env.BOOTSTRAP_COUNTRY || "Croatia";
const BOOTSTRAP_CURRENCY = (process.env.BOOTSTRAP_CURRENCY || "EUR").toUpperCase() === "USD" ? "USD" : "EUR";
const BOOTSTRAP_MEV_MODE = process.env.BOOTSTRAP_MEV_MODE || "direct";

interface TrackerDoc {
  id: string;
  name?: string;
  walletAddress?: string;
  currency?: "EUR" | "USD";
  country?: string;
  taxRate?: number;
  lastClSyncDateKey?: string | null;
  mevMode?: string;
}

interface DuneResultRow {
  [key: string]: unknown;
}

interface DuneResultResponse {
  result?: {
    rows?: DuneResultRow[];
  };
  rows?: DuneResultRow[];
}

function toDateKey(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    const maybeDate = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(maybeDate)) return maybeDate;
  }
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function duneLatestRows(queryId: string): Promise<DuneResultRow[]> {
  if (!queryId) return [];
  const res = await fetch(`${DUNE_API_BASE}/query/${queryId}/results`, {
    headers: {
      "X-Dune-Api-Key": DUNE_API_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dune query ${queryId} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as DuneResultResponse;
  return json.result?.rows ?? json.rows ?? [];
}

async function loadEthPrices(): Promise<Record<string, { eur?: number; usd?: number }>> {
  const res = await fetch(ETH_PRICES_URL);
  if (!res.ok) return {};
  return (await res.json()) as Record<string, { eur?: number; usd?: number }>;
}

function buildClByDate(rows: DuneResultRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const dateKey = toDateKey(row.block_date);
    if (!dateKey) continue;
    const amount = asNumber(row.cl_reward_eth);
    out[dateKey] = amount;
  }
  return out;
}

function buildElByDate(rows: DuneResultRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const dateKey = toDateKey(row.block_date);
    if (!dateKey) continue;
    const amount = asNumber(row.el_reward_confirmed_eth ?? row.el_incoming_eth);
    out[dateKey] = amount;
  }
  return out;
}

let app;
if (getApps().length === 0) {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT || "{}";
  try {
    const serviceAccount = JSON.parse(rawServiceAccount);
    const explicitProjectId =
      (serviceAccount && (serviceAccount as { project_id?: string }).project_id) ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      undefined;
    app = initializeApp({
      credential: cert(serviceAccount),
      projectId: explicitProjectId,
    });
    console.log("Initialized Firebase app from service account.");
  } catch (e) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON. Using default app config.", e);
    app = initializeApp();
  }
} else {
  app = getApp();
}

const db = getFirestore(app);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.log("Using Firebase project:", (app.options as any)?.projectId || "(unknown)");

async function processTracker(
  uid: string,
  tracker: TrackerDoc,
  prices: Record<string, { eur?: number; usd?: number }>,
  clByDate: Record<string, number>,
  elByDate: Record<string, number>
): Promise<number> {
  const { id: trackerId, taxRate = 24, mevMode } = tracker;
  const trackerRef = db.collection("users").doc(uid).collection("trackers").doc(trackerId);
  const txsRef = trackerRef.collection("transactions");
  let written = 0;
  let lastDate = tracker.lastClSyncDateKey ?? null;

  const dateKeys = Array.from(new Set([...Object.keys(clByDate), ...Object.keys(elByDate)])).sort();
  for (const dateKey of dateKeys) {
    if (lastDate && dateKey <= lastDate) {
      continue;
    }

    const endTs = Math.floor(new Date(`${dateKey}T12:00:00Z`).getTime() / 1000);
    const priceEntry = prices[dateKey];
    const ethPriceEUR = priceEntry?.eur ?? 0;
    const ethPriceUSD = priceEntry?.usd ?? 0;

    const clAmount = clByDate[dateKey] ?? 0;
    if (clAmount > 0) {
      const clHash = `cl_${trackerId}_${dateKey}`;
      const clDoc: Record<string, unknown> = {
        date: dateKey,
        time: "12:00:00",
        ethAmount: clAmount,
        ethPriceEUR,
        ethPriceUSD,
        ethPrice: ethPriceEUR || ethPriceUSD,
        taxRate,
        taxesInEth: clAmount * (taxRate / 100),
        transactionHash: clHash,
        status: "Unpaid",
        timestamp: endTs,
        rewardType: "CL",
        updatedAt: FieldValue.serverTimestamp(),
      };
      await txsRef.doc(clHash).set(clDoc, { merge: true });
      written += 1;
    }

    const elAmount = elByDate[dateKey] ?? 0;
    if (elAmount > 0 && mevMode === "direct") {
      const elHash = `el_${trackerId}_${dateKey}`;
      const elDoc: Record<string, unknown> = {
        date: dateKey,
        time: "12:00:00",
        ethAmount: elAmount,
        ethPriceEUR,
        ethPriceUSD,
        ethPrice: ethPriceEUR || ethPriceUSD,
        taxRate,
        taxesInEth: elAmount * (taxRate / 100),
        transactionHash: elHash,
        status: "Unpaid",
        timestamp: endTs,
        rewardType: "EVM",
        updatedAt: FieldValue.serverTimestamp(),
      };
      await txsRef.doc(elHash).set(elDoc, { merge: true });
      written += 1;
    }

    if (clAmount > 0 || (elAmount > 0 && mevMode === "direct")) {
      lastDate = dateKey;
    }
  }

  await trackerRef.update({
    lastClSyncDateKey: lastDate,
    beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
  });

  return written;
}

async function ensureBootstrapTracker(): Promise<void> {
  if (!BOOTSTRAP_UID || !BOOTSTRAP_WALLET_ADDRESS) {
    return;
  }

  const userRef = db.collection("users").doc(BOOTSTRAP_UID);
  const trackerRef = userRef.collection("trackers").doc(BOOTSTRAP_TRACKER_ID);

  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({ createdAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  const trackerSnap = await trackerRef.get();
  if (!trackerSnap.exists) {
    const createdAt = Date.now();
    await trackerRef.set(
      {
        name: BOOTSTRAP_TRACKER_NAME,
        walletAddress: BOOTSTRAP_WALLET_ADDRESS,
        feeRecipientAddress: BOOTSTRAP_WALLET_ADDRESS,
        currency: BOOTSTRAP_CURRENCY,
        country: BOOTSTRAP_COUNTRY,
        taxRate: Number.isFinite(BOOTSTRAP_TAX_RATE) ? BOOTSTRAP_TAX_RATE : 24,
        etherscanKey: "",
        createdAt,
        mevMode: BOOTSTRAP_MEV_MODE,
        lastClSyncDateKey: null,
        beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(
      `Bootstrapped tracker ${BOOTSTRAP_TRACKER_ID} for user ${BOOTSTRAP_UID}.`
    );
  }
}

async function main() {
  if (!DUNE_API_KEY || !DUNE_QUERY_ID_CL || (!DUNE_QUERY_ID_EL && !DUNE_QUERY_ID_EL_FALLBACK)) {
    throw new Error(
      "Missing Dune env vars. Required: DUNE_API_KEY, DUNE_QUERY_ID_CL, and DUNE_QUERY_ID_EL or DUNE_QUERY_ID_EL_FALLBACK."
    );
  }

  console.log("Dune sync starting...");
  await ensureBootstrapTracker();
  const prices = await loadEthPrices();
  console.log(`Loaded ${Object.keys(prices).length} date keys from ETH prices.`);

  const clRows = await duneLatestRows(DUNE_QUERY_ID_CL);
  const elRows = DUNE_QUERY_ID_EL ? await duneLatestRows(DUNE_QUERY_ID_EL) : [];
  const fallbackElRows =
    elRows.length === 0 && DUNE_QUERY_ID_EL_FALLBACK
      ? await duneLatestRows(DUNE_QUERY_ID_EL_FALLBACK)
      : [];

  const clByDate = buildClByDate(clRows);
  const elByDate = buildElByDate(elRows.length > 0 ? elRows : fallbackElRows);
  console.log(
    `Dune rows loaded: CL=${clRows.length}, EL=${elRows.length}, EL fallback=${fallbackElRows.length}`
  );

  const usersSnap = await db.collection("users").get();
  let totalWritten = 0;
  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const trackersSnap = await db.collection("users").doc(uid).collection("trackers").get();
    for (const doc of trackersSnap.docs) {
      const data = doc.data();
      if (data.deleted === true) continue;
      const tracker: TrackerDoc = {
        id: doc.id,
        taxRate: data.taxRate ?? 24,
        lastClSyncDateKey: data.lastClSyncDateKey ?? null,
        mevMode: data.mevMode,
      };
      const n = await processTracker(uid, tracker, prices, clByDate, elByDate);
      totalWritten += n;
    }
  }

  console.log(`Dune sync done. Wrote/updated ${totalWritten} reward entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
