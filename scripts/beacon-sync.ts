/**
 * Beacon-chain sync: forward-only CL rewards per validator.
 * Runs in GitHub Actions; reads validatorPublicKey + beaconApiKey from Firestore,
 * fetches daily aggregated rewards (24h window) from Beaconcha, writes one
 * CL transaction per day to Firestore.
 * Does not backfill; starts from the day the validator is added.
 */

import { initializeApp, getApps, getApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const ETH_PRICES_URL =
  "https://raw.githubusercontent.com/mx1000m/staking_rewards_tracker/main/data/eth-prices.json";

function getDateKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface TrackerDoc {
  id: string;
  validatorPublicKey?: string;
  beaconApiKey?: string;
  taxRate?: number;
  lastClSyncDateKey?: string | null;
  validatorStatus?: string;
  validatorBalanceEth?: number;
  validatorTotalRewardsEth?: number;
}

interface RewardsAggregateResponse {
  data?: {
    total?: string;
    total_reward?: string;
    total_penalty?: string;
    [k: string]: unknown;
  };
  range?: { timestamp?: { start?: number; end?: number } };
}

async function fetchDailyAggregate(
  apiKey: string,
  validatorPublicKey: string
): Promise<RewardsAggregateResponse> {
  const res = await fetch("https://beaconcha.in/api/v2/ethereum/validators/rewards-aggregate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      validator: { validator_identifiers: [validatorPublicKey] },
      chain: "mainnet",
      range: {
        evaluation_window: "24h",
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beaconcha rewards-aggregate ${res.status}: ${text}`);
  }
  return (await res.json()) as RewardsAggregateResponse;
}

async function fetchValidatorOverview(
  apiKey: string,
  validatorPublicKey: string
): Promise<{ status?: string; balanceWei?: string; totalRewardsWei?: string } | null> {
  try {
    const res = await fetch("https://beaconcha.in/api/v2/ethereum/validators", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        validator: { validator_identifiers: [validatorPublicKey] },
        chain: "mainnet",
        page_size: 1,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ status?: string; balances?: { current?: string }; validator?: unknown }> };
    const first = json.data?.[0];
    if (!first) return null;
    const currentWei = (first as { balances?: { current?: string } }).balances?.current;
    return {
      status: first.status,
      balanceWei: currentWei,
      totalRewardsWei: currentWei, // total rewards = balance - 32 ETH; we can compute if needed
    };
  } catch {
    return null;
  }
}

async function loadEthPrices(): Promise<Record<string, { eur?: number; usd?: number }>> {
  const res = await fetch(ETH_PRICES_URL);
  if (!res.ok) return {};
  return (await res.json()) as Record<string, { eur?: number; usd?: number }>;
}

// Initialize Firebase app and Firestore, and log which project we're using
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

    console.log(
      "Initialized Firebase app from service account.",
    );
  } catch (e) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON. Using default app config.", e);
    app = initializeApp();
  }
} else {
  app = getApp();
}

const db = getFirestore(app);
// This helps verify the GitHub Action is pointed at the same project as the frontend
// (compare with your frontend Firebase config's projectId)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.log("Using Firebase project:", (app.options as any)?.projectId || "(unknown)");

const RATE_LIMIT_MS = 1100; // 1 req/sec

async function processTracker(
  uid: string,
  tracker: TrackerDoc,
  prices: Record<string, { eur?: number; usd?: number }>
): Promise<number> {
  const { id: trackerId, validatorPublicKey, beaconApiKey, taxRate = 24 } = tracker;
  if (!validatorPublicKey || !beaconApiKey) {
    console.log(
      `  [${trackerId}] Skipping tracker (missing validatorPublicKey or beaconApiKey). validatorPublicKey present? ${
        !!validatorPublicKey
      }, beaconApiKey present? ${!!beaconApiKey}`
    );
    return 0;
  }

  const trackerRef = db.collection("users").doc(uid).collection("trackers").doc(trackerId);
  const trackerSnap = await trackerRef.get();
  const data = trackerSnap.data() || {};
  let lastClSyncDateKey: string | null = data.lastClSyncDateKey ?? null;

  const txsRef = db.collection("users").doc(uid).collection("trackers").doc(trackerId).collection("transactions");
  let written = 0;

  try {
    console.log(`  [${trackerId}] Calling Beaconcha rewards-aggregate for validator ${validatorPublicKey}...`);
    const agg = await fetchDailyAggregate(beaconApiKey, validatorPublicKey);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

    const totalWei = agg.data?.total_reward ?? agg.data?.total ?? "0";
    const ethAmount = Number(totalWei) / 1e18;
    const endTs = agg.range?.timestamp?.end ?? Math.floor(Date.now() / 1000);
    const dateKey = getDateKey(endTs - 1);

    // Forward-only: if we've already recorded this dateKey, skip.
    if (lastClSyncDateKey === dateKey) {
      console.log(`  [${trackerId}] CL already synced for ${dateKey}, skipping.`);
    } else if (ethAmount > 0) {
      const priceEntry = prices[dateKey];
      const ethPriceEUR = priceEntry?.eur ?? 0;
      const ethPriceUSD = priceEntry?.usd ?? 0;
      const taxesInEth = ethAmount * (taxRate / 100);
      const date = new Date(endTs * 1000);
      const txHash = `cl_${trackerId}_${dateKey}`;

      await txsRef.doc(txHash).set(
        {
          date: date.toISOString().slice(0, 10),
          time: date.toISOString().slice(11, 19),
          ethAmount,
          ethPriceEUR,
          ethPriceUSD,
          ethPrice: ethPriceEUR || ethPriceUSD,
          taxRate,
          taxesInEth,
          transactionHash: txHash,
          status: "Unpaid",
          timestamp: endTs,
          rewardType: "CL",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      written = 1;
      lastClSyncDateKey = dateKey;
    }

    await trackerRef.update({
      lastClSyncDateKey: lastClSyncDateKey ?? dateKey,
      beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn(`  [${trackerId}] daily aggregate failed:`, e);
  }

  try {
    console.log(`  [${trackerId}] Calling Beaconcha validators overview for validator ${validatorPublicKey}...`);
    const overview = await fetchValidatorOverview(beaconApiKey, validatorPublicKey);
    if (overview?.status != null) {
      const balanceEth = overview.balanceWei ? Number(overview.balanceWei) / 1e18 : undefined;
      await trackerRef.update({
        validatorStatus: overview.status,
        validatorBalanceEth: balanceEth,
        beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`  [${trackerId}] Updated validatorStatus to ${overview.status}, balanceEth=${balanceEth ?? "n/a"}`);
    } else {
      console.warn(`  [${trackerId}] Validator overview returned no status for ${validatorPublicKey}.`);
    }
  } catch (e) {
    console.warn(`  [${trackerId}] validator overview failed:`, e);
  }

  return written;
}

async function main() {
  console.log("Beacon sync (forward-only) starting...");
  const prices = await loadEthPrices();
  console.log(`Loaded ${Object.keys(prices).length} date keys from ETH prices.`);

  const usersSnap = await db.collection("users").get();
  console.log(`Found ${usersSnap.size} user(s) in Firestore.`);
  let totalWritten = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const trackersSnap = await db.collection("users").doc(uid).collection("trackers").get();
    console.log(`User ${uid}: found ${trackersSnap.size} tracker(s).`);

    for (const doc of trackersSnap.docs) {
      const data = doc.data();
      if (!data.validatorPublicKey || !data.beaconApiKey) {
        console.log(
          `  [${uid}/${doc.id}] Skipping tracker in main loop (missing validatorPublicKey or beaconApiKey). validatorPublicKey present? ${
            !!data.validatorPublicKey
          }, beaconApiKey present? ${!!data.beaconApiKey}`
        );
        continue;
      }
      const tracker: TrackerDoc = {
        id: doc.id,
        validatorPublicKey: data.validatorPublicKey,
        beaconApiKey: data.beaconApiKey,
        taxRate: data.taxRate ?? 24,
        lastClSyncDateKey: data.lastClSyncDateKey ?? null,
      };
      console.log(`Processing ${uid} / ${doc.id}`);
      const n = await processTracker(uid, tracker, prices);
      totalWritten += n;
    }
  }

  console.log(`Beacon sync done. Wrote ${totalWritten} new CL transactions.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
