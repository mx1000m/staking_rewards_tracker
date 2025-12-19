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
    const trackerRef = doc(db, getUserTrackersPath(uid), tracker.id);
    await setDoc(trackerRef, {
      name: tracker.name,
      walletAddress: tracker.walletAddress,
      feeRecipientAddress: tracker.feeRecipientAddress || null,
      currency: tracker.currency,
      country: tracker.country,
      taxRate: tracker.taxRate,
      etherscanKey: tracker.etherscanKey, // Note: Consider encrypting this
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
      });
    });
    
    return trackers;
  } catch (error) {
    console.error("Error fetching Firestore trackers:", error);
    return [];
  }
}

/**
 * Delete tracker from Firestore
 */
export async function deleteFirestoreTracker(
  uid: string,
  trackerId: string
): Promise<void> {
  try {
    const trackerRef = doc(db, getUserTrackersPath(uid), trackerId);
    await setDoc(trackerRef, { deleted: true, updatedAt: serverTimestamp() }, { merge: true });
    // Note: We mark as deleted rather than actually deleting to preserve transaction history
  } catch (error) {
    console.error("Error deleting Firestore tracker:", error);
    throw error;
  }
}

