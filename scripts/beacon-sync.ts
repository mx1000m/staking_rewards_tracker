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
/** When true (default), POST execute then read execution results so data is fresh without a Dune UI schedule. */
const DUNE_EXECUTE_BEFORE_FETCH = !["0", "false", "no"].includes(
  (process.env.DUNE_EXECUTE_BEFORE_FETCH ?? "true").trim().toLowerCase()
);
const DUNE_EXECUTION_PERF_RAW = (process.env.DUNE_EXECUTION_PERFORMANCE || "medium").trim().toLowerCase();
const DUNE_EXECUTION_PERFORMANCE = ["small", "medium", "large"].includes(DUNE_EXECUTION_PERF_RAW)
  ? DUNE_EXECUTION_PERF_RAW
  : "medium";
const DUNE_EXECUTE_POLL_MS = Math.max(2000, Number(process.env.DUNE_EXECUTE_POLL_MS || "4000"));
const DUNE_EXECUTE_TIMEOUT_MS = Math.max(60_000, Number(process.env.DUNE_EXECUTE_TIMEOUT_MS || "900000"));
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
    next_uri?: string;
    next_offset?: number;
  };
  /** Some API versions expose pagination at the top level */
  next_uri?: string;
  rows?: DuneResultRow[];
}

interface DailyClData {
  rewardEth: number;
  endBalanceEth?: number;
  topUpEth: number;
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

function resolveDuneUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  const base = DUNE_API_BASE.replace(/\/$/, "");
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}

function duneHeaders(): Record<string, string> {
  return {
    "X-Dune-Api-Key": DUNE_API_KEY,
    "Content-Type": "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowsFromDuneJson(json: DuneResultResponse): DuneResultRow[] {
  return json.result?.rows ?? json.rows ?? [];
}

function nextUriFromDuneJson(json: DuneResultResponse): string | null {
  const next = json.next_uri ?? json.result?.next_uri;
  return typeof next === "string" && next.length > 0 ? resolveDuneUrl(next) : null;
}

/** Paginate any Dune JSON result URL (saved-query results or execution results). */
async function duneFetchAllPages(firstUrl: string, errorContext: string): Promise<DuneResultRow[]> {
  const rows: DuneResultRow[] = [];
  let url: string | null = firstUrl;

  while (url) {
    const res = await fetch(url, { headers: duneHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Dune ${errorContext} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as DuneResultResponse;
    rows.push(...rowsFromDuneJson(json));
    url = nextUriFromDuneJson(json);
  }

  return rows;
}

/** Latest stored results for a saved query (no new execution; stale if the query was never re-run). */
async function duneLatestRows(queryId: string): Promise<DuneResultRow[]> {
  if (!queryId) return [];
  return duneFetchAllPages(
    `${DUNE_API_BASE}/query/${queryId}/results?limit=10000`,
    `query ${queryId} results`
  );
}

interface ExecuteQueryResponse {
  execution_id?: string;
  state?: string;
}

interface ExecutionStatusResponse {
  state?: string;
  is_execution_finished?: boolean;
  error?: { message?: string };
}

async function duneExecuteQuery(queryId: string): Promise<string> {
  const perf = encodeURIComponent(DUNE_EXECUTION_PERFORMANCE);
  const url = `${DUNE_API_BASE}/query/${queryId}/execute?performance=${perf}`;
  const res = await fetch(url, {
    method: "POST",
    headers: duneHeaders(),
    body: "{}",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dune execute query ${queryId} failed (${res.status}): ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as ExecuteQueryResponse;
  const id = json.execution_id;
  if (!id) {
    throw new Error(`Dune execute query ${queryId} returned no execution_id: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return id;
}

async function duneWaitForExecution(executionId: string): Promise<void> {
  const started = Date.now();
  const failStates = new Set([
    "QUERY_STATE_FAILED",
    "QUERY_STATE_CANCELED",
    "QUERY_STATE_CANCELLED",
    "QUERY_STATE_EXPIRED",
  ]);
  const okStates = new Set(["QUERY_STATE_COMPLETED", "QUERY_STATE_COMPLETED_PARTIAL"]);

  while (Date.now() - started < DUNE_EXECUTE_TIMEOUT_MS) {
    const res = await fetch(`${DUNE_API_BASE}/execution/${executionId}/status`, {
      headers: { "X-Dune-Api-Key": DUNE_API_KEY },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Dune execution status ${executionId} (${res.status}): ${body.slice(0, 400)}`);
    }
    const json = (await res.json()) as ExecutionStatusResponse;
    const state = json.state || "";

    if (failStates.has(state)) {
      const msg = json.error?.message || state;
      throw new Error(`Dune execution ${executionId} failed: ${msg}`);
    }
    if (okStates.has(state)) {
      return;
    }
    if (json.is_execution_finished) {
      throw new Error(`Dune execution ${executionId} finished in unexpected state: ${state || "(empty)"}`);
    }

    await sleep(DUNE_EXECUTE_POLL_MS);
  }

  throw new Error(`Dune execution ${executionId} timed out after ${DUNE_EXECUTE_TIMEOUT_MS}ms`);
}

async function duneRowsAfterExecute(queryId: string, label: string): Promise<DuneResultRow[]> {
  console.log(`Dune execute: ${label} query ${queryId} (performance=${DUNE_EXECUTION_PERFORMANCE})`);
  const executionId = await duneExecuteQuery(queryId);
  console.log(`Dune execute: ${label} execution_id=${executionId} — polling status…`);
  await duneWaitForExecution(executionId);
  const rows = await duneFetchAllPages(
    `${DUNE_API_BASE}/execution/${executionId}/results?limit=10000`,
    `execution ${executionId} results`
  );
  console.log(`Dune execute: ${label} done, ${rows.length} row(s)`);
  return rows;
}

/** Load query rows: optionally run a fresh execution first (recommended; avoids Dune UI schedule). */
async function loadDuneQueryRows(queryId: string, label: string): Promise<DuneResultRow[]> {
  if (!queryId) return [];
  if (DUNE_EXECUTE_BEFORE_FETCH) {
    return duneRowsAfterExecute(queryId, label);
  }
  return duneLatestRows(queryId);
}

async function loadEthPrices(): Promise<Record<string, { eur?: number; usd?: number }>> {
  const res = await fetch(ETH_PRICES_URL);
  if (!res.ok) return {};
  return (await res.json()) as Record<string, { eur?: number; usd?: number }>;
}

function buildClByDate(rows: DuneResultRow[]): Record<string, DailyClData> {
  const out: Record<string, DailyClData> = {};
  for (const row of rows) {
    const dateKey = toDateKey(row.block_date);
    if (!dateKey) continue;
    const rewardEth = asNumber(row.cl_reward_eth);
    const endBalanceEth = asNumber(row.end_balance_eth);
    const capitalChangeEth = asNumber(row.capital_change_eth);
    const topUpEth = capitalChangeEth > 0 ? capitalChangeEth : 0;
    out[dateKey] = {
      rewardEth,
      endBalanceEth: Number.isFinite(endBalanceEth) ? endBalanceEth : undefined,
      topUpEth,
    };
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

function maxIsoDateKey(a: string | null, b: string): string {
  if (!a) return b;
  return a >= b ? a : b;
}

async function processTracker(
  uid: string,
  tracker: TrackerDoc,
  prices: Record<string, { eur?: number; usd?: number }>,
  clByDate: Record<string, DailyClData>,
  elByDate: Record<string, number>
): Promise<number> {
  const { id: trackerId, taxRate = 24, mevMode } = tracker;
  const trackerRef = db.collection("users").doc(uid).collection("trackers").doc(trackerId);
  const txsRef = trackerRef.collection("transactions");
  let written = 0;
  let backfilled = 0;
  /** Immutable high-water mark from Firestore — must not be overwritten while iterating dates. */
  const savedLastClSyncDateKey = tracker.lastClSyncDateKey ?? null;
  /** Latest calendar day we wrote CL or EL reward data for (advances the tracker watermark). */
  let rewardWatermark = savedLastClSyncDateKey;
  let latestValidatorBalanceEth: number | null = null;
  let topUpsCount = 0;
  let topUpsEthTotal = 0;

  const latestClDate = Object.keys(clByDate).sort().at(-1);
  if (latestClDate) {
    const latestClData = clByDate[latestClDate];
    if (
      latestClData &&
      typeof latestClData.endBalanceEth === "number" &&
      Number.isFinite(latestClData.endBalanceEth)
    ) {
      latestValidatorBalanceEth = latestClData.endBalanceEth;
    }
  }
  for (const dateKey of Object.keys(clByDate)) {
    const topUpEth = clByDate[dateKey]?.topUpEth ?? 0;
    if (topUpEth > 0) {
      topUpsCount += 1;
      topUpsEthTotal += topUpEth;
    }
  }

  const dateKeys = Array.from(new Set([...Object.keys(clByDate), ...Object.keys(elByDate)])).sort();
  for (const dateKey of dateKeys) {
    const isAlreadySyncedDate = Boolean(savedLastClSyncDateKey && dateKey <= savedLastClSyncDateKey);

    const endTs = Math.floor(new Date(`${dateKey}T12:00:00Z`).getTime() / 1000);
    const priceEntry = prices[dateKey];
    const ethPriceEUR = priceEntry?.eur ?? 0;
    const ethPriceUSD = priceEntry?.usd ?? 0;

    const clData = clByDate[dateKey];
    const clAmount = clData?.rewardEth ?? 0;
    const topUpEth = clData?.topUpEth ?? 0;
    if (clData && typeof clData.endBalanceEth === "number" && Number.isFinite(clData.endBalanceEth)) {
      latestValidatorBalanceEth = clData.endBalanceEth;
    }
    if (clAmount > 0) {
      const clHash = `cl_${trackerId}_${dateKey}`;
      const clDoc: Record<string, unknown> = isAlreadySyncedDate
        ? {
            validatorBalanceEth: latestValidatorBalanceEth ?? undefined,
            topUpEth,
            ethPrice: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          }
        : {
            date: dateKey,
            time: "12:00:00",
            ethAmount: clAmount,
            ethPriceEUR,
            ethPriceUSD,
            ethPrice: FieldValue.delete(),
            taxRate,
            taxesInEth: clAmount * (taxRate / 100),
            transactionHash: clHash,
            status: "Unpaid",
            timestamp: endTs,
            rewardType: "CL",
            validatorBalanceEth: latestValidatorBalanceEth ?? undefined,
            topUpEth,
            updatedAt: FieldValue.serverTimestamp(),
          };
      await txsRef.doc(clHash).set(clDoc, { merge: true });
      if (isAlreadySyncedDate) backfilled += 1;
      else written += 1;
    }

    const elAmount = elByDate[dateKey] ?? 0;
    if (!isAlreadySyncedDate && elAmount > 0 && mevMode === "direct") {
      const elHash = `el_${trackerId}_${dateKey}`;
      const elDoc: Record<string, unknown> = {
        date: dateKey,
        time: "12:00:00",
        ethAmount: elAmount,
        ethPriceEUR,
        ethPriceUSD,
        ethPrice: FieldValue.delete(),
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
      rewardWatermark = maxIsoDateKey(rewardWatermark, dateKey);
    }
  }

  await trackerRef.update({
    lastClSyncDateKey: rewardWatermark,
    ...(latestValidatorBalanceEth != null ? { validatorBalanceEth: latestValidatorBalanceEth } : {}),
    topUpsCount,
    topUpsEthTotal,
    beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
  });

  if (backfilled > 0) {
    console.log(`Backfilled ${backfilled} historical CL rows for tracker ${trackerId}.`);
  }
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
  console.log(
    `Dune fetch mode: ${DUNE_EXECUTE_BEFORE_FETCH ? "execute then read results (no UI schedule needed)" : "read latest saved results only"}`
  );
  await ensureBootstrapTracker();
  const prices = await loadEthPrices();
  console.log(`Loaded ${Object.keys(prices).length} date keys from ETH prices.`);

  const clRows = await loadDuneQueryRows(DUNE_QUERY_ID_CL, "CL");
  const elRows = DUNE_QUERY_ID_EL ? await loadDuneQueryRows(DUNE_QUERY_ID_EL, "EL") : [];
  const fallbackElRows =
    elRows.length === 0 && DUNE_QUERY_ID_EL_FALLBACK
      ? await loadDuneQueryRows(DUNE_QUERY_ID_EL_FALLBACK, "EL-fallback")
      : [];

  const clByDate = buildClByDate(clRows);
  const elByDate = buildElByDate(elRows.length > 0 ? elRows : fallbackElRows);
  const clDateKeys = Object.keys(clByDate).sort();
  const clMin = clDateKeys[0] ?? "(none)";
  const clMax = clDateKeys.at(-1) ?? "(none)";
  console.log(
    `Dune rows loaded: CL=${clRows.length} (dates ${clMin}..${clMax}), EL=${elRows.length}, EL fallback=${fallbackElRows.length}`
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
