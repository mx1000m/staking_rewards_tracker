/**
 * Daily sync script for staking rewards tracker
 * Fetches new transactions for all trackers and saves to Firestore
 * Runs daily via GitHub Actions cron
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getTransactions } from "../app/src/api/etherscan";
import { getEthPriceAtTimestamp } from "../app/src/api/coingecko";

// Initialize Firebase Admin (server-side)
if (getApps().length === 0) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const db = getFirestore();

interface Tracker {
  id: string;
  name: string;
  walletAddress: string;
  feeRecipientAddress?: string;
  currency: "EUR" | "USD";
  country: string;
  taxRate: number;
  etherscanKey: string;
  createdAt: number;
  // Optional newer fields from app Tracker type; kept for compatibility
  validatorPublicKey?: string;
  beaconApiProvider?: "beaconcha";
  beaconApiKey?: string;
  mevMode?: "none" | "direct" | "pool" | "mixed";
  mevPoolPayoutAddress?: string;
}

interface Transaction {
  date: string;
  time: string;
  ethAmount: number;
  ethPriceEUR: number;
  ethPriceUSD: number;
  taxRate: number;
  taxesInEth: number;
  transactionHash: string;
  status: string;
  timestamp: number;
  rewardType?: "CL" | "EVM";
}

async function getAllTrackers(): Promise<Map<string, Tracker[]>> {
  const trackersMap = new Map<string, Tracker[]>();
  const usersSnapshot = await db.collection("users").get();
  
  for (const userDoc of usersSnapshot.docs) {
    const uid = userDoc.id;
    const trackers: Tracker[] = [];
    const trackersSnapshot = await db.collection(`users/${uid}/trackers`).get();
    
    for (const trackerDoc of trackersSnapshot.docs) {
      const data = trackerDoc.data();
      trackers.push({
        id: trackerDoc.id,
        name: data.name || "",
        walletAddress: data.walletAddress || "",
        feeRecipientAddress: data.feeRecipientAddress || undefined,
        currency: data.currency || "EUR",
        country: data.country || "Croatia",
        taxRate: data.taxRate || 24,
        etherscanKey: data.etherscanKey || "",
        createdAt: data.createdAt?.toMillis() || Date.now(),
        validatorPublicKey: data.validatorPublicKey || undefined,
        beaconApiProvider: data.beaconApiProvider || undefined,
        beaconApiKey: data.beaconApiKey || undefined,
        mevMode: data.mevMode || undefined,
        mevPoolPayoutAddress: data.mevPoolPayoutAddress || undefined,
      });
    }
    
    if (trackers.length > 0) {
      trackersMap.set(uid, trackers);
    }
  }
  
  return trackersMap;
}

async function getExistingTransactionHashes(uid: string, trackerId: string): Promise<Set<string>> {
  const hashes = new Set<string>();
  const txsSnapshot = await db.collection(`users/${uid}/trackers/${trackerId}/transactions`).get();
  txsSnapshot.forEach((doc) => hashes.add(doc.id));
  return hashes;
}

async function processTracker(uid: string, tracker: Tracker, coingeckoApiKey?: string): Promise<number> {
  console.log(`Processing tracker: ${tracker.name} (${tracker.walletAddress})`);
  
  try {
    // Get existing transaction hashes
    const existingHashes = await getExistingTransactionHashes(uid, tracker.id);
    console.log(`  Found ${existingHashes.size} existing transactions`);
    
    // Fetch transactions from Etherscan (last 30 days to catch any missed ones)
    const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const feeRecipientAddress = tracker.feeRecipientAddress || tracker.walletAddress;
    
    const etherscanTxs = await getTransactions(
      tracker.walletAddress,
      feeRecipientAddress,
      tracker.etherscanKey,
      thirtyDaysAgo
    );
    
    // Filter to only new transactions
    const newTxs = etherscanTxs.filter((tx) => !existingHashes.has(tx.hash));
    console.log(`  Found ${newTxs.length} new transactions`);
    
    if (newTxs.length === 0) {
      return 0;
    }
    
    // Process new transactions
    const processedTxs: Transaction[] = [];
    const datePriceMapEUR = new Map<string, number>();
    const datePriceMapUSD = new Map<string, number>();
    const uniqueDates = new Set<string>();
    
    // Collect unique dates
    for (const tx of newTxs) {
      const date = new Date(parseInt(tx.timeStamp) * 1000);
      const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
      uniqueDates.add(dateKey);
    }
    
    // Fetch prices for unique dates
    console.log(`  Fetching prices for ${uniqueDates.size} unique dates...`);
    for (const dateKey of uniqueDates) {
      const [year, month, day] = dateKey.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      const timestamp = Math.floor(date.getTime() / 1000);
      
      try {
        // Fetch EUR price
        const priceEUR = await getEthPriceAtTimestamp(timestamp, "EUR", coingeckoApiKey);
        datePriceMapEUR.set(dateKey, priceEUR);
        
        // Rate limiting delay
        await new Promise((resolve) => setTimeout(resolve, 2100));
        
        // Fetch USD price
        const priceUSD = await getEthPriceAtTimestamp(timestamp, "USD", coingeckoApiKey);
        datePriceMapUSD.set(dateKey, priceUSD);
        
        // Rate limiting delay
        await new Promise((resolve) => setTimeout(resolve, 2100));
      } catch (error) {
        console.error(`  Failed to fetch prices for ${dateKey}:`, error);
        datePriceMapEUR.set(dateKey, 0);
        datePriceMapUSD.set(dateKey, 0);
      }
    }
    
    // Process transactions
    for (const tx of newTxs) {
      const timestamp = parseInt(tx.timeStamp) * 1000;
      const date = new Date(timestamp);
      const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
      
      const rawValue = parseFloat(tx.value);
      const ethAmount = tx.rewardType === "CL" ? rawValue / 1e9 : rawValue / 1e18;
      const ethPriceEUR = datePriceMapEUR.get(dateKey) || 0;
      const ethPriceUSD = datePriceMapUSD.get(dateKey) || 0;
      const taxesInEth = ethAmount * (tracker.taxRate / 100);
      
      processedTxs.push({
        date: date.toLocaleDateString("en-GB", { timeZone: "Europe/Zagreb" }),
        time: date.toLocaleTimeString("en-GB", { timeZone: "Europe/Zagreb", hour12: false }),
        ethAmount,
        ethPriceEUR,
        ethPriceUSD,
        taxRate: tracker.taxRate,
        taxesInEth,
        transactionHash: tx.hash,
        status: "Unpaid",
        timestamp: parseInt(tx.timeStamp),
        rewardType: tx.rewardType || "EVM",
      });
    }
    
    // Save to Firestore
    const batch = db.batch();
    for (const tx of processedTxs) {
      const txRef = db.collection(`users/${uid}/trackers/${tracker.id}/transactions`).doc(tx.transactionHash);
      batch.set(txRef, {
        date: tx.date,
        time: tx.time,
        ethAmount: tx.ethAmount,
        ethPriceEUR: tx.ethPriceEUR,
        ethPriceUSD: tx.ethPriceUSD,
        taxRate: tx.taxRate,
        taxesInEth: tx.taxesInEth,
        transactionHash: tx.transactionHash,
        status: tx.status,
        timestamp: db.Timestamp.fromMillis(tx.timestamp * 1000),
        rewardType: tx.rewardType || null,
        updatedAt: db.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    
    await batch.commit();
    console.log(`  Saved ${processedTxs.length} new transactions to Firestore`);
    return processedTxs.length;
  } catch (error) {
    console.error(`  Error processing tracker ${tracker.name}:`, error);
    return 0;
  }
}

async function main() {
  console.log("Starting daily sync...");
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  
  try {
    const trackersMap = await getAllTrackers();
    console.log(`Found ${trackersMap.size} users with trackers`);
    
    let totalProcessed = 0;
    for (const [uid, trackers] of trackersMap.entries()) {
      console.log(`\nProcessing user: ${uid} (${trackers.length} trackers)`);
      for (const tracker of trackers) {
        const count = await processTracker(uid, tracker, coingeckoApiKey);
        totalProcessed += count;
      }
    }
    
    console.log(`\nDaily sync complete. Processed ${totalProcessed} new transactions.`);
  } catch (error) {
    console.error("Daily sync failed:", error);
    process.exit(1);
  }
}

main();

