// Client-side transaction cache using IndexedDB
// Stores transactions per tracker and only fetches new ones

import { Tracker } from "../store/trackerStore";

export interface CachedTransaction {
  date: string;
  time: string;
  ethAmount: number;
  ethPrice: number;
  rewardsInCurrency: number;
  taxRate: number;
  taxesInEth: number;
  taxesInCurrency: number;
  transactionHash: string;
  status: string;
  timestamp: number; // Unix timestamp for sorting
  swapHash?: string; // Optional: transaction hash of the swap
}

interface CacheMetadata {
  lastFetchedBlock: number;
  lastFetchedTimestamp: number; // Unix timestamp
  trackerId: string;
}

const DB_NAME = "staking-rewards-cache";
const DB_VERSION = 1;
const STORE_TRANSACTIONS = "transactions";
const STORE_METADATA = "metadata";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create transactions store
      if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
        const txStore = db.createObjectStore(STORE_TRANSACTIONS, { keyPath: ["trackerId", "transactionHash"] });
        txStore.createIndex("trackerId", "trackerId", { unique: false });
        txStore.createIndex("timestamp", "timestamp", { unique: false });
      }

      // Create metadata store
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: "trackerId" });
      }
    };
  });

  return dbPromise;
}

export async function getCachedTransactions(trackerId: string): Promise<CachedTransaction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRANSACTIONS], "readonly");
    const store = tx.objectStore(STORE_TRANSACTIONS);
    const index = store.index("trackerId");
    const request = index.getAll(trackerId);

    request.onsuccess = () => {
      const transactions = request.result as CachedTransaction[];
      // Sort by timestamp descending (newest first)
      transactions.sort((a, b) => b.timestamp - a.timestamp);
      resolve(transactions);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveTransactions(
  trackerId: string,
  transactions: CachedTransaction[]
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRANSACTIONS], "readwrite");
    const store = tx.objectStore(STORE_TRANSACTIONS);

    // Remove old transactions for this tracker
    const index = store.index("trackerId");
    const deleteRequest = index.openKeyCursor(IDBKeyRange.only(trackerId));
    deleteRequest.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        // All old transactions deleted, now add new ones
        const addPromises = transactions.map((tx) => store.put({ ...tx, trackerId }));
        Promise.all(addPromises)
          .then(() => resolve())
          .catch(reject);
      }
    };
    deleteRequest.onerror = () => reject(deleteRequest.error);
  });
}

export async function getCacheMetadata(trackerId: string): Promise<CacheMetadata | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_METADATA], "readonly");
    const store = tx.objectStore(STORE_METADATA);
    const request = store.get(trackerId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCacheMetadata(metadata: CacheMetadata): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_METADATA], "readwrite");
    const store = tx.objectStore(STORE_METADATA);
    const request = store.put(metadata);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearCache(trackerId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRANSACTIONS, STORE_METADATA], "readwrite");
    
    // Clear transactions
    const txStore = tx.objectStore(STORE_TRANSACTIONS);
    const index = txStore.index("trackerId");
    const deleteRequest = index.openKeyCursor(IDBKeyRange.only(trackerId));
    deleteRequest.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result;
      if (cursor) {
        txStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    // Clear metadata
    const metaStore = tx.objectStore(STORE_METADATA);
    metaStore.delete(trackerId);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateTransactionStatus(
  trackerId: string,
  transactionHash: string,
  status: string,
  swapHash?: string
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRANSACTIONS], "readwrite");
    const store = tx.objectStore(STORE_TRANSACTIONS);
    const key = [trackerId, transactionHash] as unknown as IDBValidKey;
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const record = getReq.result as (CachedTransaction & { trackerId: string; swapHash?: string }) | undefined;
      if (!record) {
        // If not found, create minimal record so UI persists it
        const now = Math.floor(Date.now() / 1000);
        const newRecord: any = {
          trackerId,
          transactionHash,
          date: "",
          time: "",
          ethAmount: 0,
          ethPrice: 0,
          rewardsInCurrency: 0,
          taxRate: 0,
          taxesInEth: 0,
          taxesInCurrency: 0,
          status,
          timestamp: now,
          swapHash,
        };
        store.put(newRecord).onsuccess = () => resolve();
        return;
      }
      const updated = { ...record, status, swapHash };
      store.put(updated).onsuccess = () => resolve();
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function getTransaction(
  trackerId: string,
  transactionHash: string
): Promise<CachedTransaction | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRANSACTIONS], "readonly");
    const store = tx.objectStore(STORE_TRANSACTIONS);
    const key = [trackerId, transactionHash] as unknown as IDBValidKey;
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as CachedTransaction) || null);
    req.onerror = () => reject(req.error);
  });
}

