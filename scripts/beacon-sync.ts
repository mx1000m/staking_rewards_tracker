/**
 * Beacon-chain sync: forward-only CL rewards per validator.
 * Runs in GitHub Actions; reads validatorPublicKey + beaconApiKey from Firestore,
 * fetches new epochs from Beaconcha, writes CL transactions to Firestore.
 * Does not backfill; starts from current epoch when tracker has no lastSyncedEpoch.
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const BEACON_GENESIS = 1606824023;
const SECONDS_PER_EPOCH = 32 * 12; // 384

const ETH_PRICES_URL =
  "https://raw.githubusercontent.com/mx1000m/staking_rewards_tracker/main/data/eth-prices.json";

function getCurrentEpoch(): number {
  return Math.floor((Date.now() / 1000 - BEACON_GENESIS) / SECONDS_PER_EPOCH);
}

function getEpochEndTimestamp(epoch: number): number {
  return BEACON_GENESIS + (epoch + 1) * SECONDS_PER_EPOCH - 1;
}

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
  lastSyncedEpoch?: number | null;
  trackingStartEpoch?: number | null;
  validatorStatus?: string;
  validatorBalanceEth?: number;
  validatorTotalRewardsEth?: number;
}

interface RewardsListResponse {
  data?: Array<{
    total_reward?: string;
    total?: string;
    validator?: { index: number; public_key: string };
    [k: string]: unknown;
  }>;
  range?: { epoch?: { start?: number; end?: number }; timestamp?: { start?: number; end?: number } };
}

async function fetchRewardsForEpoch(
  apiKey: string,
  validatorPublicKey: string,
  epoch: number
): Promise<RewardsListResponse> {
  const res = await fetch("https://beaconcha.in/api/v2/ethereum/validators/rewards-list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      validator: { validator_identifiers: [validatorPublicKey] },
      chain: "mainnet",
      page_size: 10,
      epoch,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beaconcha rewards-list ${res.status}: ${text}`);
  }
  return (await res.json()) as RewardsListResponse;
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

if (getApps().length === 0) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();

const MAX_EPOCHS_PER_RUN = 33; // ~1000/month if run daily
const RATE_LIMIT_MS = 1100; // 1 req/sec

async function processTracker(
  uid: string,
  tracker: TrackerDoc,
  prices: Record<string, { eur?: number; usd?: number }>
): Promise<number> {
  const { id: trackerId, validatorPublicKey, beaconApiKey, taxRate = 24 } = tracker;
  if (!validatorPublicKey || !beaconApiKey) return 0;

  const trackerRef = db.collection("users").doc(uid).collection("trackers").doc(trackerId);
  const trackerSnap = await trackerRef.get();
  const data = trackerSnap.data() || {};
  let lastSyncedEpoch = data.lastSyncedEpoch ?? null;
  const currentEpoch = getCurrentEpoch();

  if (lastSyncedEpoch == null) {
    lastSyncedEpoch = currentEpoch;
    await trackerRef.update({
      lastSyncedEpoch: currentEpoch,
      trackingStartEpoch: currentEpoch,
      beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`  [${trackerId}] Forward-only: set lastSyncedEpoch=${currentEpoch}, no backfill.`);
    const overview = await fetchValidatorOverview(beaconApiKey, validatorPublicKey);
    if (overview?.status != null) {
      const balanceEth = overview.balanceWei ? Number(overview.balanceWei) / 1e18 : undefined;
      await trackerRef.update({
        validatorStatus: overview.status,
        validatorBalanceEth: balanceEth,
        beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
      });
    }
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    return 0;
  }

  const startEpoch = lastSyncedEpoch + 1;
  const endEpoch = Math.min(lastSyncedEpoch + MAX_EPOCHS_PER_RUN, currentEpoch);
  if (startEpoch > endEpoch) {
    const overview = await fetchValidatorOverview(beaconApiKey, validatorPublicKey);
    if (overview?.status != null) {
      const balanceEth = overview.balanceWei ? Number(overview.balanceWei) / 1e18 : undefined;
      await trackerRef.update({
        validatorStatus: overview.status,
        validatorBalanceEth: balanceEth,
        beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
      });
    }
    return 0;
  }

  const txsRef = db.collection("users").doc(uid).collection("trackers").doc(trackerId).collection("transactions");
  let written = 0;
  let newLastEpoch = lastSyncedEpoch;

  for (let epoch = startEpoch; epoch <= endEpoch; epoch++) {
    try {
      const rewards = await fetchRewardsForEpoch(beaconApiKey, validatorPublicKey, epoch);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

      const items = rewards.data ?? [];
      const item = items.find((i) => (i.validator?.public_key ?? "").toLowerCase() === validatorPublicKey.toLowerCase()) ?? items[0];
      if (!item) continue;

      const totalRewardWei = item.total_reward ?? item.total ?? "0";
      const ethAmount = Number(totalRewardWei) / 1e18;
      if (ethAmount <= 0) {
        newLastEpoch = epoch;
        continue;
      }

      const timestamp = rewards.range?.timestamp?.end ?? getEpochEndTimestamp(epoch);
      const dateKey = getDateKey(timestamp);
      const priceEntry = prices[dateKey];
      const ethPriceEUR = priceEntry?.eur ?? 0;
      const ethPriceUSD = priceEntry?.usd ?? 0;
      const taxesInEth = ethAmount * (taxRate / 100);

      const date = new Date(timestamp * 1000);
      const txHash = `cl_${trackerId}_${epoch}`;
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
          timestamp,
          rewardType: "CL",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      written++;
      newLastEpoch = epoch;
    } catch (e) {
      console.warn(`  [${trackerId}] Epoch ${epoch} failed:`, e);
      break;
    }
  }

  await trackerRef.update({
    lastSyncedEpoch: newLastEpoch,
    beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
  });

  try {
    const overview = await fetchValidatorOverview(beaconApiKey, validatorPublicKey);
    if (overview?.status != null) {
      const balanceEth = overview.balanceWei ? Number(overview.balanceWei) / 1e18 : undefined;
      await trackerRef.update({
        validatorStatus: overview.status,
        validatorBalanceEth: balanceEth,
        beaconSyncUpdatedAt: FieldValue.serverTimestamp(),
      });
    }
  } catch {
    // optional
  }

  return written;
}

async function main() {
  console.log("Beacon sync (forward-only) starting...");
  const prices = await loadEthPrices();
  console.log(`Loaded ${Object.keys(prices).length} date keys from ETH prices.`);

  const usersSnap = await db.collection("users").get();
  let totalWritten = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const trackersSnap = await db.collection("users").doc(uid).collection("trackers").get();

    for (const doc of trackersSnap.docs) {
      const data = doc.data();
      if (!data.validatorPublicKey || !data.beaconApiKey) continue;
      const tracker: TrackerDoc = {
        id: doc.id,
        validatorPublicKey: data.validatorPublicKey,
        beaconApiKey: data.beaconApiKey,
        taxRate: data.taxRate ?? 24,
        lastSyncedEpoch: data.lastSyncedEpoch ?? null,
        trackingStartEpoch: data.trackingStartEpoch ?? null,
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
