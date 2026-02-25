// Firestore adapter for syncing transactions and trackers
// Implements Option B: Full transaction history + paid decisions

import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit,
  Timestamp,
  writeBatch,
  serverTimestamp,
  deleteDoc,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { CachedTransaction } from "./transactionCache";
import { Tracker } from "../store/trackerStore";

// Firestore collection paths
const getUserTrackersPath = (uid: string) => `users/${uid}/trackers`;
const getTrackerTransactionsPath = (uid: string, trackerId: string) => 
  `users/${uid}/trackers/${trackerId}/transactions`;

// Convert Firestore timestamp to number
const timestampToNumber = (ts: any): number => {
  if (!ts) return 0;
  if (ts instanceof Timestamp) return ts.toMillis() / 1000;
  if (typeof ts === "number") return ts;
  return 0;
};

// Convert transaction to Firestore format
const transactionToFirestore = (tx: CachedTransaction): any => ({
  date: tx.date,
  time: tx.time,
  ethAmount: tx.ethAmount,
  ethPriceEUR: tx.ethPriceEUR,
  ethPriceUSD: tx.ethPriceUSD,
  // Keep legacy ethPrice for backward compatibility during migration
  ethPrice: tx.ethPrice || tx.ethPriceEUR || 0,
  taxRate: tx.taxRate,
  taxesInEth: tx.taxesInEth,
  transactionHash: tx.transactionHash,
  status: tx.status,
  timestamp: Timestamp.fromMillis(tx.timestamp * 1000),
  swapHash: (tx as any).swapHash || null,
  rewardType: tx.rewardType || null,
  updatedAt: serverTimestamp(),
  // Note: rewardsInCurrency and taxesInCurrency are calculated on-the-fly
});

// Convert Firestore document to transaction
const firestoreToTransaction = (data: any, txHash: string): CachedTransaction => {
  // Handle backward compatibility: if ethPriceEUR/USD don't exist, use legacy ethPrice
  const ethPriceEUR = data.ethPriceEUR ?? data.ethPrice ?? 0;
  const ethPriceUSD = data.ethPriceUSD ?? data.ethPrice ?? 0;
  
  return {
    date: data.date || "",
    time: data.time || "",
    ethAmount: data.ethAmount || 0,
    ethPriceEUR,
    ethPriceUSD,
    ethPrice: data.ethPrice || ethPriceEUR, // Keep for backward compatibility
    taxRate: data.taxRate || 0,
    taxesInEth: data.taxesInEth || 0,
    transactionHash: txHash,
    status: data.status || "Unpaid",
    timestamp: timestampToNumber(data.timestamp),
    swapHash: data.swapHash || undefined,
    rewardType: data.rewardType || undefined,
    // Note: rewardsInCurrency and taxesInCurrency are calculated on-the-fly
  };
};

/**
 * Get all transactions for a tracker from Firestore
 * Only fetches transactions newer than lastFetchedTimestamp (delta fetch)
 */
export async function getFirestoreTransactions(
  uid: string,
  trackerId: string,
  lastFetchedTimestamp?: number
): Promise<CachedTransaction[]> {
  try {
    const transactionsRef = collection(db, getTrackerTransactionsPath(uid, trackerId));
    let q = query(transactionsRef, orderBy("timestamp", "desc"));
    
    // If we have a last fetched timestamp, only get newer transactions
    if (lastFetchedTimestamp) {
      q = query(
        transactionsRef,
        where("timestamp", ">", Timestamp.fromMillis(lastFetchedTimestamp * 1000)),
        orderBy("timestamp", "desc")
      );
    }
    
    const snapshot = await getDocs(q);
    const transactions: CachedTransaction[] = [];
    
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      transactions.push(firestoreToTransaction(data, docSnap.id));
    });
    
    return transactions;
  } catch (error) {
    console.error("Error fetching Firestore transactions:", error);
    return [];
  }
}

/**
 * Check if Firestore has any transactions for a specific year
 * Returns true if at least one transaction exists for that year
 */
export async function hasFirestoreTransactionsForYear(
  uid: string,
  trackerId: string,
  year: number
): Promise<boolean> {
  try {
    const transactionsRef = collection(db, getTrackerTransactionsPath(uid, trackerId));

    // Some transactions store `timestamp` as Firestore Timestamp, others as a number of seconds.
    // To keep this helper robust, read a small set and check the year in JavaScript instead of
    // relying on Firestore range queries with a specific timestamp type.
    const q = query(transactionsRef, orderBy("timestamp", "desc"), limit(20));
    const snapshot = await getDocs(q);

    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      const tsSeconds = timestampToNumber(data.timestamp);
      if (!tsSeconds) continue;
      const txYear = new Date(tsSeconds * 1000).getUTCFullYear();
      if (txYear === year) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Error checking Firestore transactions for year:", error);
    return false; // On error, assume no transactions (will trigger fetch)
  }
}

/**
 * Save a single transaction to Firestore
 */
export async function saveFirestoreTransaction(
  uid: string,
  trackerId: string,
  transaction: CachedTransaction
): Promise<void> {
  try {
    const txRef = doc(db, getTrackerTransactionsPath(uid, trackerId), transaction.transactionHash);
    await setDoc(txRef, transactionToFirestore(transaction), { merge: true });
  } catch (error) {
    console.error("Error saving Firestore transaction:", error);
    throw error;
  }
}

/**
 * Batch save multiple transactions to Firestore
 */
export async function saveFirestoreTransactionsBatch(
  uid: string,
  trackerId: string,
  transactions: CachedTransaction[]
): Promise<void> {
  try {
    const batch = writeBatch(db);
    const batchSize = 500; // Firestore batch limit
    
    for (let i = 0; i < transactions.length; i += batchSize) {
      const chunk = transactions.slice(i, i + batchSize);
      
      chunk.forEach((tx) => {
        const txRef = doc(db, getTrackerTransactionsPath(uid, trackerId), tx.transactionHash);
        batch.set(txRef, transactionToFirestore(tx), { merge: true });
      });
      
      await batch.commit();
    }
  } catch (error) {
    console.error("Error batch saving Firestore transactions:", error);
    throw error;
  }
}

/**
 * Update transaction status (mark as paid)
 */
export async function updateFirestoreTransactionStatus(
  uid: string,
  trackerId: string,
  transactionHash: string,
  status: string,
  swapHash?: string
): Promise<void> {
  try {
    const txRef = doc(db, getTrackerTransactionsPath(uid, trackerId), transactionHash);
    await setDoc(
      txRef,
      {
        status,
        swapHash: swapHash || null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("Error updating Firestore transaction status:", error);
    throw error;
  }
}

/**
 * Save tracker to Firestore
 */
export async function saveFirestoreTracker(
  uid: string,
  tracker: Tracker
): Promise<void> {
  try {
    // Ensure the root user document exists so backend scripts (like beacon-sync)
    // can discover this user via db.collection("users").get()
    const userRef = doc(db, "users", uid);
    await setDoc(
      userRef,
      {
        // Keep it minimal; more user-level fields can be added later if needed
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );

    const trackerRef = doc(db, getUserTrackersPath(uid), tracker.id);
    await setDoc(trackerRef, {
      name: tracker.name,
      walletAddress: tracker.walletAddress,
      feeRecipientAddress: tracker.feeRecipientAddress || null,
      currency: tracker.currency,
      country: tracker.country,
      taxRate: tracker.taxRate,
      etherscanKey: tracker.etherscanKey, // Note: Consider encrypting this
      // Optional validator / MEV metadata (backward compatible)
      validatorPublicKey: tracker.validatorPublicKey || null,
      beaconApiProvider: tracker.beaconApiProvider || null,
      beaconApiKey: tracker.beaconApiKey || null,
      mevMode: tracker.mevMode || null,
      mevPoolPayoutAddress: tracker.mevPoolPayoutAddress || null,
      createdAt: Timestamp.fromMillis(tracker.createdAt),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    console.error("Error saving Firestore tracker:", error);
    throw error;
  }
}

/**
 * Get all trackers for a user from Firestore
 */
export async function getFirestoreTrackers(uid: string): Promise<Tracker[]> {
  try {
    const trackersRef = collection(db, getUserTrackersPath(uid));
    const snapshot = await getDocs(trackersRef);
    const trackers: Tracker[] = [];
    
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      // Skip trackers marked as deleted (backward compatibility)
      if (data.deleted === true) {
        return;
      }
      
      trackers.push({
        id: docSnap.id,
        name: data.name || "",
        walletAddress: data.walletAddress || "",
        feeRecipientAddress: data.feeRecipientAddress || undefined,
        currency: data.currency || "EUR",
        country: data.country || "Croatia",
        taxRate: data.taxRate || 24,
        etherscanKey: data.etherscanKey || "",
        createdAt: timestampToNumber(data.createdAt) * 1000,
        validatorPublicKey: data.validatorPublicKey || undefined,
        beaconApiProvider: data.beaconApiProvider || undefined,
        beaconApiKey: data.beaconApiKey || undefined,
        mevMode: data.mevMode || undefined,
        mevPoolPayoutAddress: data.mevPoolPayoutAddress || undefined,
        lastSyncedEpoch: data.lastSyncedEpoch ?? undefined,
        validatorStatus: data.validatorStatus || undefined,
        validatorBalanceEth: data.validatorBalanceEth ?? undefined,
      });
    });
    
    return trackers;
  } catch (error) {
    console.error("Error fetching Firestore trackers:", error);
    return [];
  }
}

/**
 * Delete all transactions for a tracker from Firestore
 * Used when wallet address changes to clear old transaction data
 */
export async function deleteFirestoreTransactions(
  uid: string,
  trackerId: string
): Promise<void> {
  try {
    const transactionsRef = collection(db, getTrackerTransactionsPath(uid, trackerId));
    const transactionsSnapshot = await getDocs(transactionsRef);
    
    // Delete transactions in batches (Firestore batch limit is 500)
    const batchSize = 500;
    const transactionDocs = transactionsSnapshot.docs;
    
    for (let i = 0; i < transactionDocs.length; i += batchSize) {
      const batch = writeBatch(db);
      const chunk = transactionDocs.slice(i, i + batchSize);
      
      chunk.forEach((docSnap) => {
        batch.delete(docSnap.ref);
      });
      
      await batch.commit();
    }
    
    console.log(`Deleted ${transactionDocs.length} transactions for tracker ${trackerId} from Firestore`);
  } catch (error) {
    console.error("Error deleting Firestore transactions:", error);
    throw error;
  }
}

/**
 * Delete tracker and all its transactions from Firestore
 * This frees up storage space by actually removing the data
 */
export async function deleteFirestoreTracker(
  uid: string,
  trackerId: string
): Promise<void> {
  try {
    // First, delete all transactions in the subcollection
    await deleteFirestoreTransactions(uid, trackerId);
    
    // Finally, delete the tracker document itself
    const trackerRef = doc(db, getUserTrackersPath(uid), trackerId);
    await deleteDoc(trackerRef);
    
    console.log(`Deleted tracker ${trackerId} from Firestore`);
  } catch (error) {
    console.error("Error deleting Firestore tracker:", error);
    throw error;
  }
}

// Note: ETH prices are now stored in GitHub (data/eth-prices.json) instead of Firestore
// This reduces Firestore read costs and improves performance
// The frontend fetches prices from: https://raw.githubusercontent.com/mx1000m/staking_rewards_tracker/main/data/eth-prices.json

