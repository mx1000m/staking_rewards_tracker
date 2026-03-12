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
  range?: {
    timestamp?: { start?: number; end?: number };
    epoch?: { start?: number; end?: number };
  };
}

async function fetchDailyAggregate(
  apiKey: string,
  validatorPublicKey: string
): Promise<RewardsAggregateResponse> {
  const shortKey =
    validatorPublicKey.length > 18
      ? `${validatorPublicKey.slice(0, 10)}...${validatorPublicKey.slice(-8)}`
      : validatorPublicKey;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    if (res.ok) {
      return (await res.json()) as RewardsAggregateResponse;
    }

    const text = await res.text();

    // 404 means "no rewards yet" for this validator / time range – treat as empty result, not fatal.
    if (res.status === 404) {
      console.log(
        `[fetchDailyAggregate] 404 (no rewards yet) for ${shortKey}:`,
        text.slice(0, 200)
      );
      return {
        data: { total: "0", total_reward: "0", total_penalty: "0" },
        range: {},
      };
    }

    // 429 – rate limited. Apply exponential backoff and retry a few times.
    if (res.status === 429 && attempt < maxAttempts - 1) {
      const delayMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(
        `[fetchDailyAggregate] 429 Too Many Requests for ${shortKey}, attempt ${
          attempt + 1
        }/${maxAttempts}, retrying after ${delayMs}ms. Body: ${text.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    // Other errors – give up and let caller decide what to do.
    throw new Error(`Beaconcha rewards-aggregate ${res.status} for ${shortKey}: ${text}`);
  }

  // Should not reach here, but TypeScript wants a return.
  return {
    data: { total: "0", total_reward: "0", total_penalty: "0" },
    range: {},
  };
}

async function fetchValidatorOverview(
  apiKey: string,
  validatorPublicKey: string
): Promise<{ status?: string; balanceWei?: string; withdrawalAddress?: string } | null> {
  const shortKey =
    validatorPublicKey.length > 18
      ? `${validatorPublicKey.slice(0, 10)}...${validatorPublicKey.slice(-8)}`
      : validatorPublicKey;

  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{
            status?: string;
            balances?: { current?: string };
            validator?: { withdrawal_credentials?: string };
          }>;
        };

        const first = json.data?.[0];
        if (!first) {
          console.warn(
            `[fetchValidatorOverview] v2 returned no data for ${shortKey}: ${JSON.stringify(
              json
            )}`
          );
          return null;
        }

        console.log(
          `[fetchValidatorOverview] v2 status for ${shortKey}:`,
          first.status,
          "balanceWei:",
          first.balances?.current ?? "n/a"
        );
        const withdrawalCreds = first.validator?.withdrawal_credentials;
        let withdrawalAddress: string | undefined;
        if (
          typeof withdrawalCreds === "string" &&
          withdrawalCreds.startsWith("0x01") &&
          withdrawalCreds.length === 2 + 64
        ) {
          // 0x01 + 11 zero bytes + 20 byte execution address (40 hex chars)
          const addrHex = withdrawalCreds.slice(-40);
          withdrawalAddress = `0x${addrHex.toLowerCase()}`;
        }

        return {
          status: first.status,
          balanceWei: first.balances?.current,
          withdrawalAddress,
        };
      }

      const text = await res.text();

      // Special case: v2 "no validators found" – this commonly happens for
      // validators that are DEPOSITED but have not yet been assigned an index
      // in the active set. For UX purposes we treat this as "deposited"
      // instead of leaving the status unknown, and will overwrite it on later
      // runs once the validator becomes pending/active.
      if (res.status === 404 && text.includes("no validators found")) {
        console.warn(
          `[fetchValidatorOverview] v2 404 no validators found for ${shortKey} – assuming status=deposited until validator index exists. Body: ${text.slice(
            0,
            200
          )}`
        );
        return { status: "deposited", balanceWei: undefined, withdrawalAddress: undefined };
      }

      if (res.status === 429 && attempt < maxAttempts - 1) {
        const delayMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        console.warn(
          `[fetchValidatorOverview] v2 429 Too Many Requests for ${shortKey}, attempt ${
            attempt + 1
          }/${maxAttempts}, retrying after ${delayMs}ms. Body: ${text.slice(0, 200)}`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      console.warn(
        `[fetchValidatorOverview] v2 failed (${res.status}) for ${shortKey}: ${text.slice(
          0,
          200
        )}`
      );
      return null;
    } catch (e) {
      console.warn(
        `[fetchValidatorOverview] v2 threw for ${shortKey}, attempt ${attempt + 1}/${maxAttempts}:`,
        e
      );
    }
  }

  return null;
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

// Light per-request backoff. The dominant limit for the free tier is
// the *monthly* quota; we keep a small delay here mainly to be polite.
const RATE_LIMIT_MS = 1100; // ~1 req/sec

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
    const epochStart = agg.range?.epoch?.start;
    const epochEnd = agg.range?.epoch?.end;

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

      const docData: Record<string, unknown> = {
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
      };

      if (typeof epochStart === "number") {
        docData.epochStart = epochStart;
      }
      if (typeof epochEnd === "number") {
        docData.epochEnd = epochEnd;
      }

      await txsRef.doc(txHash).set(docData, { merge: true });
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
    // Respect rate limit before any further Beaconcha calls
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    if (overview?.status != null) {
      const updateData: Record<string, unknown> = {
        validatorStatus: overview.status,
        beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
      };
      if (overview.balanceWei) {
        updateData.validatorBalanceEth = Number(overview.balanceWei) / 1e18;
      }
      if (overview.withdrawalAddress) {
        updateData.walletAddress = overview.withdrawalAddress;
      }
      await trackerRef.update(updateData);
      console.log(
        `  [${trackerId}] Updated validatorStatus to ${overview.status}, balanceEth=${
          updateData.validatorBalanceEth ?? "n/a"
        }`
      );
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
