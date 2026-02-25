import React, { useEffect, useState, useRef } from "react";
import { useTrackerStore, Tracker } from "../store/trackerStore";
import { getTransactions, getMevPoolPayoutTransactions, EtherscanTransaction } from "../api/etherscan";
import { getDateKey } from "../utils/priceCache";

// Country to timezone mapping
const COUNTRY_TIMEZONE: Record<string, string> = {
  Croatia: "Europe/Zagreb",    // UTC+1 (winter) / UTC+2 (summer)
  Germany: "Europe/Berlin",    // UTC+1 (winter) / UTC+2 (summer)
  "United Kingdom": "Europe/London", // UTC+0 (winter) / UTC+1 (summer)
};

// Helper to get timezone for a country (defaults to UTC if not found)
function getTimezoneForCountry(country: string): string {
  return COUNTRY_TIMEZONE[country] || "UTC";
}
import {
  getCachedTransactions,
  saveTransactions,
  getCacheMetadata,
  saveCacheMetadata,
  CachedTransaction,
} from "../utils/transactionCache";
import { TrackerSettingsModal } from "./TrackerSettingsModal";
import { useAuth } from "../hooks/useAuth";
import {
  getFirestoreTransactions,
  saveFirestoreTransactionsBatch,
  updateFirestoreTransactionStatus,
  hasFirestoreTransactionsForYear,
} from "../utils/firestoreAdapter";

// ETH prices are now stored in GitHub, not Firestore
export interface EthPricesDocument {
  [dateKey: string]: { eur: number; usd: number }; // dateKey format: "YYYY-MM-DD"
}

// Transaction interface matches CachedTransaction
// rewardsInCurrency and taxesInCurrency are calculated on-the-fly based on currency preference
interface Transaction extends Omit<CachedTransaction, 'rewardsInCurrency' | 'taxesInCurrency'> {
  // These are calculated on-the-fly, not stored
  rewardsInCurrency?: number;
  taxesInCurrency?: number;
}

interface DashboardProps {
  onAddTracker?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ onAddTracker }) => {
  const { trackers, activeTrackerId, setActiveTracker, currency: globalCurrency } = useTrackerStore();
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0, progressPercent: 0 });
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [markPaidHash, setMarkPaidHash] = useState<string | null>(null);
  const [swapHashInput, setSwapHashInput] = useState<string>("");
  const [editPaidHash, setEditPaidHash] = useState<string | null>(null);
  const [editSwapHashInput, setEditSwapHashInput] = useState<string>("");
  const [markPaidModalAnimation, setMarkPaidModalAnimation] = useState<"enter" | "exit">("enter");
  const [editPaidModalAnimation, setEditPaidModalAnimation] = useState<"enter" | "exit">("enter");
  const markPaidModalCloseTimeoutRef = useRef<number | null>(null);
  const editPaidModalCloseTimeoutRef = useRef<number | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null); // null means "ALL"
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportYear, setExportYear] = useState<number>(new Date().getFullYear());
  const [exportModalAnimation, setExportModalAnimation] = useState<"enter" | "exit">("enter");
  const exportModalCloseTimeoutRef = useRef<number | null>(null);
  const EXPORT_MODAL_ANIMATION_DURATION = 175;
  const [visibleTooltip, setVisibleTooltip] = useState<string | null>(null);
  // Local holding status per transaction hash: "Hodling" (default) or "Sold"
  const [holdingStatusMap, setHoldingStatusMap] = useState<Record<string, "Hodling" | "Sold">>({});
  // Bulk "mark as sold" modal state
  const [showMarkSoldModal, setShowMarkSoldModal] = useState(false);
  const [markSoldMode, setMarkSoldMode] = useState<"year" | "custom">("year");
  const [markSoldStartMonth, setMarkSoldStartMonth] = useState<number>(0);
  const [markSoldEndMonth, setMarkSoldEndMonth] = useState<number>(0);
  const [walletCopied, setWalletCopied] = useState(false);
  // Centralized ETH prices storage (dateKey -> { eur: number, usd: number })
  const [ethPrices, setEthPrices] = useState<EthPricesDocument>({});
  const [ethPricesLoaded, setEthPricesLoaded] = useState(false);

  const activeTracker = trackers.find((t) => t.id === activeTrackerId);
  const glowShadow = "0 0 8px rgba(1, 225, 253, 0.8), 0 0 20px rgba(1, 225, 253, 0.45)";
  
  // Current ETH price state (from Coinbase API)
  const [currentEthPrice, setCurrentEthPrice] = useState<{ eur: number; usd: number } | null>(null);
  const [currentEthPriceError, setCurrentEthPriceError] = useState<string | null>(null);
  const [currentEthPriceLoading, setCurrentEthPriceLoading] = useState(false);

  // Load centralized ETH prices from GitHub on mount
  useEffect(() => {
    const loadEthPrices = async () => {
      try {
        // Fetch from GitHub raw URL
        // Using main branch - in production you might want to use a specific version/tag
        const response = await fetch(
          'https://raw.githubusercontent.com/mx1000m/staking_rewards_tracker/main/data/eth-prices.json'
        );
        
        if (!response.ok) {
          throw new Error(`Failed to fetch prices: ${response.status} ${response.statusText}`);
        }
        
        const prices = await response.json() as EthPricesDocument;
        setEthPrices(prices);
        setEthPricesLoaded(true);
        console.log(`Loaded ${Object.keys(prices).length} ETH price entries from GitHub`);
      } catch (error) {
        console.error("Failed to load ETH prices from GitHub:", error);
        setEthPricesLoaded(true); // Still mark as loaded to prevent infinite retries
        // Set empty prices so app doesn't crash
        setEthPrices({});
      }
    };
    loadEthPrices();
  }, []);

  // Fetch current ETH price from Coinbase API with 1-hour browser cache
  useEffect(() => {
    const fetchCurrentEthPrice = async () => {
      const CACHE_KEY = 'current_eth_price';
      const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds
      
      try {
        // Check cache first
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { price, timestamp } = JSON.parse(cached);
          const now = Date.now();
          if (now - timestamp < CACHE_DURATION) {
            setCurrentEthPrice(price);
            setCurrentEthPriceError(null);
            return;
          }
        }

        // Fetch from Coinbase API
        setCurrentEthPriceLoading(true);
        const response = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=ETH');
        
        if (!response.ok) {
          throw new Error(`Failed to fetch current ETH price: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        const rates = data.data?.rates;
        
        if (!rates || !rates.EUR || !rates.USD) {
          throw new Error('Invalid response from Coinbase API');
        }
        
        const price = {
          eur: parseFloat(rates.EUR),
          usd: parseFloat(rates.USD),
        };
        
        // Cache the result
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          price,
          timestamp: Date.now(),
        }));
        
        setCurrentEthPrice(price);
        setCurrentEthPriceError(null);
      } catch (error: any) {
        console.error('Failed to fetch current ETH price:', error);
        setCurrentEthPriceError('Currently not available');
        setCurrentEthPrice(null);
      } finally {
        setCurrentEthPriceLoading(false);
      }
    };

    fetchCurrentEthPrice();
  }, []);

  // Format number based on currency preference
  // USD: period (.) as decimal separator, comma (,) as thousands separator (e.g., 1,000.45)
  // EUR: comma (,) as decimal separator, thin space as thousands separator (e.g., 1 000,45)
  const formatNumber = (value: number, decimals: number, currency: "EUR" | "USD"): string => {
    if (isNaN(value) || !isFinite(value)) {
      value = 0;
    }
    
    // Round to specified decimals
    const rounded = Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
    
    // Split into integer and decimal parts
    const parts = rounded.toFixed(decimals).split(".");
    const integerPart = parts[0];
    const decimalPart = parts[1] || "";
    
    // Format thousands separator
    const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, currency === "USD" ? "," : "\u2009");
    
    // Add decimal part if needed
    if (decimals === 0) {
      return formattedInteger;
    }
    
    if (currency === "USD") {
      // USD: comma for thousands, period for decimal
      return formattedInteger + "." + decimalPart;
    } else {
      // EUR: thin space for thousands, comma for decimal
      return formattedInteger + "," + decimalPart;
    }
  };

  // Format currency value with symbol in correct position
  // EUR: symbol after number (e.g., "88 324,70 €")
  // USD: symbol before number (e.g., "$ 1,000.45")
  const formatCurrency = (value: number, decimals: number, currency: "EUR" | "USD"): string => {
    const formattedNumber = formatNumber(value, decimals, currency);
    const symbol = currency === "EUR" ? "€" : "$";
    
    if (currency === "EUR") {
      return `${formattedNumber} ${symbol}`;
    } else {
      return `${symbol} ${formattedNumber}`;
    }
  };

  // Format date based on currency preference
  // EUR: DD/MM/YYYY (e.g., "05/01/2026")
  // USD: MM/DD/YYYY (e.g., "01/05/2026")
  const formatDate = (date: Date, timezone: string, currency: "EUR" | "USD"): string => {
    const locale = currency === "EUR" ? "en-GB" : "en-US";
    return date.toLocaleDateString(locale, { timeZone: timezone });
  };

  const getEthPriceFromStorage = (dateKey: string, currency: "EUR" | "USD"): number => {
    const priceEntry = ethPrices[dateKey];
    if (!priceEntry) return 0;
    return currency === "EUR" ? (priceEntry.eur || 0) : (priceEntry.usd || 0);
  };

  // Helper functions to calculate rewards and taxes on-the-fly based on currency preference
  // Now uses centralized price storage instead of stored prices in transactions
  const getRewardsInCurrency = (tx: CachedTransaction, currency: "EUR" | "USD"): number => {
    if (!tx || !tx.ethAmount) return 0;
    const dateKey = getDateKey(tx.timestamp);
    // Try centralized storage first, then fall back to stored prices (for backward compatibility)
    let ethPrice: number;
    if (currency === "EUR") {
      ethPrice = getEthPriceFromStorage(dateKey, "EUR") || tx.ethPriceEUR || tx.ethPrice || 0;
    } else {
      ethPrice = getEthPriceFromStorage(dateKey, "USD") || tx.ethPriceUSD || tx.ethPrice || 0;
    }
    const result = tx.ethAmount * ethPrice;
    return isNaN(result) ? 0 : result;
  };

  const getTaxesInCurrency = (tx: CachedTransaction, currency: "EUR" | "USD"): number => {
    if (!tx || !tx.taxRate) return 0;
    const rewardsInCurrency = getRewardsInCurrency(tx, currency);
    const result = rewardsInCurrency * (tx.taxRate / 100);
    return isNaN(result) ? 0 : result;
  };

  // Helper to safely get ETH price for display
  const getEthPriceForDisplay = (tx: CachedTransaction, currency: "EUR" | "USD"): number => {
    if (!tx) return 0;
    const dateKey = getDateKey(tx.timestamp);
    // Try centralized storage first, then fall back to stored prices
    const price = currency === "EUR"
      ? (getEthPriceFromStorage(dateKey, "EUR") || tx.ethPriceEUR || tx.ethPrice || 0)
      : (getEthPriceFromStorage(dateKey, "USD") || tx.ethPriceUSD || tx.ethPrice || 0);
    return isNaN(price) ? 0 : price;
  };

  // Helper to check if price is missing (0 or not available)
  const isPriceMissing = (tx: CachedTransaction, currency: "EUR" | "USD"): boolean => {
    if (!tx) return true;
    const price = getEthPriceForDisplay(tx, currency);
    return price === 0;
  };

  // Check for missing prices for the current tracker's transactions and update warning
  const checkForMissingPrices = React.useCallback((trackerTransactions: CachedTransaction[]) => {
    if (!ethPricesLoaded || Object.keys(ethPrices).length === 0) {
      return; // Prices not loaded yet
    }

    let missingCount = 0;
    
    // Check transactions for missing prices
    for (const tx of trackerTransactions) {
      if (isPriceMissing(tx, globalCurrency)) {
        missingCount++;
      }
    }

    // Set warning if there are any missing prices
    if (missingCount > 0) {
      // Store as a special format that we'll parse in the display
      setError(`PRICE_WARNING:${missingCount}`);
    } else {
      // Only clear error if it's a price-related warning (not other errors)
      setError((currentError) => {
        if (currentError && currentError.startsWith("PRICE_WARNING:")) {
          return null;
        }
        return currentError; // Keep other errors
      });
    }
  }, [ethPricesLoaded, ethPrices, globalCurrency]);

  // Clear price warning and transactions immediately when switching trackers to prevent showing wrong tracker's warnings
  React.useEffect(() => {
    // Only run if we have trackers and an active tracker
    if (trackers.length > 0 && activeTracker) {
      // Reset to current year when switching trackers
      const currentYear = new Date().getFullYear();
      setSelectedYear(currentYear);
      // Clear price warning immediately when switching trackers
      setError((currentError) => {
        if (currentError && currentError.startsWith("PRICE_WARNING:")) {
          return null;
        }
        return currentError; // Keep other errors
      });
      // Clear transactions to prevent stale data from previous tracker
      setTransactions([]);
      // Load transactions for the new tracker
      loadTransactions(activeTracker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackerId, trackers.length]);

  // Handle export modal body overflow and animation
  useEffect(() => {
    if (showExportModal) {
      // Calculate scrollbar width to prevent layout shift
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const originalOverflow = document.body.style.overflow;
      const originalPaddingRight = document.body.style.paddingRight;
      
      document.body.style.overflow = "hidden";
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
      setExportModalAnimation("enter");
      
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
      };
    }
  }, [showExportModal]);

  // Handle mark paid modal body overflow and animation
  useEffect(() => {
    if (markPaidHash) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const originalOverflow = document.body.style.overflow;
      const originalPaddingRight = document.body.style.paddingRight;
      
      document.body.style.overflow = "hidden";
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
      setMarkPaidModalAnimation("enter");
      
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
      };
    }
  }, [markPaidHash]);

  // Handle edit paid modal body overflow and animation
  useEffect(() => {
    if (editPaidHash) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const originalOverflow = document.body.style.overflow;
      const originalPaddingRight = document.body.style.paddingRight;
      
      document.body.style.overflow = "hidden";
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
      setEditPaidModalAnimation("enter");
      
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
      };
    }
  }, [editPaidHash]);


  // Handle mark sold modal body overflow
  useEffect(() => {
    if (showMarkSoldModal) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const originalOverflow = document.body.style.overflow;
      const originalPaddingRight = document.body.style.paddingRight;

      document.body.style.overflow = "hidden";
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }

      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
      };
    }
  }, [showMarkSoldModal]);

  const requestMarkPaidModalClose = () => {
    setMarkPaidModalAnimation("exit");
    if (markPaidModalCloseTimeoutRef.current) {
      clearTimeout(markPaidModalCloseTimeoutRef.current);
    }
    markPaidModalCloseTimeoutRef.current = window.setTimeout(() => {
      setMarkPaidHash(null);
      setSwapHashInput("");
      setMarkPaidModalAnimation("enter");
      markPaidModalCloseTimeoutRef.current = null;
    }, EXPORT_MODAL_ANIMATION_DURATION);
  };

  const requestEditPaidModalClose = () => {
    setEditPaidModalAnimation("exit");
    if (editPaidModalCloseTimeoutRef.current) {
      clearTimeout(editPaidModalCloseTimeoutRef.current);
    }
    editPaidModalCloseTimeoutRef.current = window.setTimeout(() => {
      setEditPaidHash(null);
      setEditSwapHashInput("");
      setEditPaidModalAnimation("enter");
      editPaidModalCloseTimeoutRef.current = null;
    }, EXPORT_MODAL_ANIMATION_DURATION);
  };

  const requestExportModalClose = () => {
    setExportModalAnimation("exit");
    if (exportModalCloseTimeoutRef.current) {
      clearTimeout(exportModalCloseTimeoutRef.current);
    }
    exportModalCloseTimeoutRef.current = window.setTimeout(() => {
      setShowExportModal(false);
      setExportModalAnimation("enter"); // Reset animation state for next open
      exportModalCloseTimeoutRef.current = null;
    }, EXPORT_MODAL_ANIMATION_DURATION);
  };

  // Load transactions: first from cache, then sync with Firestore, then fetch new ones if needed
  const loadTransactions = async (tracker: Tracker) => {
    setLoading(true);
    // Don't clear error here - let checkForMissingPrices handle it after transactions are loaded

    try {
      // Load cached transactions first (instant display)
      const cached = await getCachedTransactions(tracker.id);
      const metadata = await getCacheMetadata(tracker.id);
      
      if (cached.length > 0) {
        setTransactions(cached);
        setLoading(false);
        console.log(`Loaded ${cached.length} cached transactions`);
        // Don't check for missing prices here - let the useEffect handle it after transactions are set
      }

      // Sync with Firestore if user is authenticated
      if (user) {
        try {
          // If cache is empty but metadata exists (cache was cleared), fetch ALL transactions from Firestore
          // Otherwise, do delta sync (only new transactions since lastFetchedTimestamp)
          const shouldFetchAll = cached.length === 0 && metadata !== null;
          const firestoreTxs = await getFirestoreTransactions(
            user.uid,
            tracker.id,
            shouldFetchAll ? undefined : metadata?.lastFetchedTimestamp
          );
          
          if (firestoreTxs.length > 0) {
            if (shouldFetchAll) {
              console.log(`Restored ${firestoreTxs.length} transactions from Firestore (cache was cleared)`);
            } else {
              console.log(`Synced ${firestoreTxs.length} new transactions from Firestore`);
            }
            // Merge Firestore data with cached data (Firestore takes precedence for status)
            const cachedMap = new Map(cached.map((t) => [t.transactionHash, t]));
            firestoreTxs.forEach((ftx) => {
              cachedMap.set(ftx.transactionHash, ftx);
            });
            const merged = Array.from(cachedMap.values()).sort((a, b) => b.timestamp - a.timestamp);
            setTransactions(merged);
            await saveTransactions(tracker.id, merged);
            // Don't check for missing prices here - let the useEffect handle it after transactions are set
          }
        } catch (firestoreError) {
          console.warn("Firestore sync failed (continuing with cache):", firestoreError);
        }
      }

      // Check if we need to fetch new transactions from Etherscan
      // (metadata was already fetched above)
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 24 * 60 * 60;
      const currentYear = new Date().getFullYear();

      // Fetch if:
      // - No cache exists
      // - Cache is older than 1 day
      // - It's after midnight UTC (for daily updates)
      // Always fetch for current year on initial load
      const shouldFetch =
        !metadata ||
        metadata.lastFetchedTimestamp < oneDayAgo ||
        isAfterMidnightUTC(metadata.lastFetchedTimestamp);

      if (shouldFetch) {
        // Fetch for current year when tracker is first loaded
        await fetchTransactions(tracker, false, currentYear);
      } else {
        console.log("Using cached data, no fetch needed");
        // Don't check for missing prices here - let the useEffect handle it after transactions are set
      }
    } catch (error: any) {
      console.error("Failed to load transactions:", error);
      setError(`Failed to load transactions: ${error.message}`);
      setLoading(false);
    }
  };

  const isAfterMidnightUTC = (lastTimestamp: number): boolean => {
    const lastDate = new Date(lastTimestamp * 1000);
    const now = new Date();
    const lastUTC = new Date(
      Date.UTC(
        lastDate.getUTCFullYear(),
        lastDate.getUTCMonth(),
        lastDate.getUTCDate()
      )
    );
    const nowUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    return nowUTC > lastUTC;
  };

  const fetchTransactions = async (tracker: Tracker, forceRefresh = false, year?: number) => {
    setLoading(true);
    setLoadingProgress({ current: 0, total: 0, progressPercent: 0 });
    setError(null);
    try {
      // Use provided year or default to current year
      const targetYear = year ?? new Date().getUTCFullYear();
      
      // Check Firestore first to see if we already have transactions for this year
      if (user && !forceRefresh) {
        const hasTransactions = await hasFirestoreTransactionsForYear(user.uid, tracker.id, targetYear);
        if (hasTransactions) {
          console.log(`Transactions for ${targetYear} already exist in Firestore, loading from cache/Firestore`);
          // Load from cache/Firestore instead of fetching from Etherscan
          await loadTransactions(tracker);
          return;
        }
      }
      
      // Start from Jan 1 of target year (00:01 UTC) to include entire-year history
      const startTimestamp = Math.floor(Date.UTC(targetYear, 0, 1, 0, 1, 0) / 1000);
      // End at Dec 31 of target year (23:59:59 UTC)
      const endTimestamp = Math.floor(Date.UTC(targetYear, 11, 31, 23, 59, 59) / 1000);
      
      // Use fee recipient address if provided, otherwise default to withdrawal address
      const feeRecipientAddress = tracker.feeRecipientAddress || tracker.walletAddress;
      
      // ===== Execution-layer (EVM) rewards via Etherscan =====
      // Respect execution rewards mode:
      // - "none": do not track any EVM income at all.
      // - "direct": track EVM rewards via fee recipient / withdrawal address (current behavior).
      // - "pool" / "mixed": MEV pool support will be added later; keep API surface but skip for now if no payout address.
      let etherscanTxs: EtherscanTransaction[] = [];
      let mevPoolTxs: EtherscanTransaction[] = [];

      if (tracker.mevMode !== "none" && tracker.etherscanKey) {
        console.log("Fetching EVM transactions for:", {
          withdrawalAddress: tracker.walletAddress,
          feeRecipientAddress: feeRecipientAddress,
          year: targetYear,
          from: new Date(startTimestamp * 1000).toLocaleDateString()
        });

        try {
          etherscanTxs = await getTransactions(
            tracker.walletAddress,
            feeRecipientAddress,
            tracker.etherscanKey,
            startTimestamp
          );
        } catch (e) {
          console.error("Failed to fetch EVM transactions from Etherscan:", e);
          // Leave etherscanTxs empty; CL rewards from Firestore will still be shown.
        }

        if (
          (tracker.mevMode === "pool" || tracker.mevMode === "mixed") &&
          tracker.mevPoolPayoutAddress
        ) {
          try {
            mevPoolTxs = await getMevPoolPayoutTransactions(
              tracker.mevPoolPayoutAddress,
              tracker.etherscanKey,
              startTimestamp
            );
          } catch (e) {
            console.warn("Failed to fetch MEV pool payouts from Etherscan:", e);
          }
        }
      } else {
        console.log(
          "Skipping EVM transaction fetch because execution rewards mode is 'none' or no Etherscan key is provided."
        );
      }

      // CL (beacon-chain) rewards are synced by the beacon-sync GitHub Action; load from Firestore only.
      let clFromFirestore: CachedTransaction[] = [];
      if (user && tracker.validatorPublicKey) {
        try {
          const allFirestore = await getFirestoreTransactions(user.uid, tracker.id);
          clFromFirestore = allFirestore.filter(
            (ftx) => ftx.rewardType === "CL" && ftx.timestamp >= startTimestamp && ftx.timestamp <= endTimestamp
          );
        } catch (e) {
          console.warn("Failed to load CL transactions from Firestore:", e);
        }
      }
      const allRawTxs: (EtherscanTransaction | CachedTransaction)[] = [...etherscanTxs, ...mevPoolTxs, ...clFromFirestore];
      const yearTxs = allRawTxs.filter((tx) => {
        const txTimestamp = "timeStamp" in tx ? parseInt((tx as EtherscanTransaction).timeStamp) : (tx as CachedTransaction).timestamp;
        return txTimestamp >= startTimestamp && txTimestamp <= endTimestamp;
      });
      
      console.log(`Found ${yearTxs.length} transactions for year ${targetYear} (out of ${etherscanTxs.length} total)`);
      
      // Set initial progress (will be updated during price fetching and transaction processing)
      // Total represents transactions, but progress includes price fetches too
      setLoadingProgress({ current: 0, total: yearTxs.length, progressPercent: 0 });
      
      if (yearTxs.length === 0) {
        const hasValidator = !!tracker.validatorPublicKey;
        const clHint = hasValidator
          ? " Consensus (beacon) rewards appear after the daily Beacon Chain Sync runs in GitHub Actions—check that it finds your project and processes this validator."
          : "";
        setError(`No incoming rewards found for this wallet in ${targetYear}.${clHint}`);
        setTransactions([]);
        setLoading(false);
        return;
      }
      
      // Get prices from centralized storage (no API calls needed!)
      // Step 1: Collect all unique dates from transactions
      const datePriceMapEUR = new Map<string, number>(); // dateKey -> EUR price
      const datePriceMapUSD = new Map<string, number>(); // dateKey -> USD price
      const uniqueDates = new Set<string>();
      const missingDates: string[] = [];
      
      for (const tx of yearTxs) {
        const txTs = "timeStamp" in tx ? parseInt((tx as EtherscanTransaction).timeStamp) : (tx as CachedTransaction).timestamp;
        const dateKey = getDateKey(txTs);
        uniqueDates.add(dateKey);
        
        // Get prices from centralized storage
        const priceEntry = ethPrices[dateKey];
        if (priceEntry && priceEntry.eur && priceEntry.usd) {
          datePriceMapEUR.set(dateKey, priceEntry.eur);
          datePriceMapUSD.set(dateKey, priceEntry.usd);
        } else {
          // Price not found in centralized storage
          missingDates.push(dateKey);
          datePriceMapEUR.set(dateKey, 0);
          datePriceMapUSD.set(dateKey, 0);
        }
      }
      
      if (missingDates.length > 0) {
        console.warn(`Warning: ${missingDates.length} dates missing from centralized price storage:`, missingDates.slice(0, 5));
      }
      
      console.log(`Loaded prices from centralized storage for ${uniqueDates.size - missingDates.length}/${uniqueDates.size} unique dates`);
      
      // Step 2: Process all transactions using prices from centralized storage
      const processedTxs: CachedTransaction[] = [];
      
      const timezone = getTimezoneForCountry(tracker.country);
      for (let i = 0; i < yearTxs.length; i++) {
        const tx = yearTxs[i];
        // CL transactions from Firestore are already CachedTransaction; use as-is.
        if (!("timeStamp" in tx)) {
          const c = tx as CachedTransaction;
          setLoadingProgress({ current: i + 1, total: yearTxs.length, progressPercent: ((i + 1) / yearTxs.length) * 100 });
          processedTxs.push({
            ...c,
            date: formatDate(new Date(c.timestamp * 1000), timezone, globalCurrency),
            time: new Date(c.timestamp * 1000).toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false }),
          });
          continue;
        }
        const rawTs = parseInt((tx as EtherscanTransaction).timeStamp);
        const timestamp = rawTs * 1000;
        const date = new Date(timestamp);

        // IMPORTANT: value units differ by reward type
        // - EVM rewards: value is in WEI  -> ETH = value / 1e18
        // - CL beacon withdrawals: value is in GWEI -> ETH = value / 1e9
        const rawValue = parseFloat((tx as EtherscanTransaction).value);
        const ethAmount =
          (tx as EtherscanTransaction).rewardType === "CL"
            ? rawValue / 1e9 // Gwei → ETH
            : rawValue / 1e18; // Wei → ETH
        
        const dateKey = getDateKey(rawTs);
        const ethPriceEUR = datePriceMapEUR.get(dateKey) || 0;
        const ethPriceUSD = datePriceMapUSD.get(dateKey) || 0;
        
        setLoadingProgress({ current: i + 1, total: yearTxs.length, progressPercent: ((i + 1) / yearTxs.length) * 100 });
        
        const taxesInEth = ethAmount * (tracker.taxRate / 100);
        
        processedTxs.push({
          date: formatDate(date, timezone, globalCurrency),
          time: date.toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false }),
          ethAmount,
          ethPriceEUR: 0,
          ethPriceUSD: 0,
          taxRate: tracker.taxRate,
          taxesInEth,
          transactionHash: (tx as EtherscanTransaction).hash,
          status: "Unpaid",
          timestamp: rawTs,
          rewardType: (tx as EtherscanTransaction).rewardType || "EVM",
          rewardSubType: (tx as EtherscanTransaction).rewardSubType,
        } as CachedTransaction);
      }
    
    // Get existing cached transactions and merge, preferring freshly-processed data
    // If forceRefresh is true, don't merge with old cache (wallet address changed)
    let allTransactions: CachedTransaction[];
    let newTxs: CachedTransaction[];
    
    // Check Firestore for existing transactions to determine which are actually new
    const existingFirestoreHashes = new Set<string>();
    if (user && !forceRefresh) {
      try {
        const firestoreTxs = await getFirestoreTransactions(user.uid, tracker.id);
        firestoreTxs.forEach((ftx) => {
          existingFirestoreHashes.add(ftx.transactionHash);
        });
      } catch (error) {
        console.warn("Failed to check Firestore for existing transactions:", error);
      }
    }
    
    if (forceRefresh) {
      // Force refresh: use only the newly fetched transactions
      allTransactions = processedTxs;
      newTxs = processedTxs; // All are new when force refreshing
    } else {
      // Normal refresh: merge with existing cache and check Firestore
      const existingCached = await getCachedTransactions(tracker.id);
      const existingHashes = new Set([
        ...existingCached.map((t) => t.transactionHash),
        ...Array.from(existingFirestoreHashes)
      ]);
      
      // Only transactions that don't exist in cache OR Firestore are truly new
      newTxs = processedTxs.filter((tx) => !existingHashes.has(tx.transactionHash));

      const mergedMap = new Map<string, CachedTransaction>();
      existingCached.forEach((t) => mergedMap.set(t.transactionHash, t));
      processedTxs.forEach((t) => mergedMap.set(t.transactionHash, t)); // override stale entries
      allTransactions = Array.from(mergedMap.values());
    }
    
    // Sort by timestamp (newest first)
    allTransactions.sort((a, b) => b.timestamp - a.timestamp);
    
    // Save to cache
    await saveTransactions(tracker.id, allTransactions);
    
    // Save to Firestore if user is authenticated
    if (user && newTxs.length > 0) {
      try {
        await saveFirestoreTransactionsBatch(user.uid, tracker.id, newTxs);
        console.log(`Saved ${newTxs.length} new transactions to Firestore`);
      } catch (firestoreError) {
        console.warn("Failed to save to Firestore (continuing):", firestoreError);
      }
    }
    
    // Save metadata
    const now = Math.floor(Date.now() / 1000);
    await saveCacheMetadata({
      trackerId: tracker.id,
      lastFetchedBlock: 0, // We'll track this if needed
      lastFetchedTimestamp: now,
    });
    
    console.log("Processed transactions:", newTxs.length, "new,", allTransactions.length, "total");
    setTransactions(allTransactions);
    
    // Check for missing prices after fetching transactions
    // Don't check for missing prices here - let the useEffect handle it after transactions are set
    } catch (error: any) {
      console.error("Failed to fetch transactions:", error);
      setError(`Failed to fetch transactions: ${error.message || "Unknown error"}. Please check your Etherscan API key and wallet address.`);
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  };

  // Get available years from transactions, plus 2025 as minimum option
  // MUST be called before early return to ensure hooks are always called in same order
  const availableYears = React.useMemo(() => {
    const years = new Set<number>();
    const currentYear = new Date().getFullYear();
    const minYear = 2025;
    
    // Always include 2025 and current year
    years.add(minYear);
    years.add(currentYear);
    
    // Add years from transactions
    transactions.forEach((tx) => {
      const year = new Date(tx.timestamp * 1000).getFullYear();
      if (year >= minYear) {
        years.add(year);
      }
    });
    
    // Fill in any missing years between minYear and currentYear
    for (let y = minYear; y <= currentYear; y++) {
      years.add(y);
    }
    
    return Array.from(years).sort((a, b) => b - a); // Sort descending
  }, [transactions]);

  // Filter transactions by selected year, month, and execution rewards mode
  const filteredTransactions = React.useMemo(() => {
    return transactions.filter((tx) => {
      const txDate = new Date(tx.timestamp * 1000);
      const txYear = txDate.getFullYear();
      const txMonth = txDate.getMonth(); // 0-11
      
      if (txYear !== selectedYear) return false;
      if (selectedMonth !== null && txMonth !== selectedMonth) return false;

      // If execution rewards are disabled for this tracker, hide any EVM rewards
      if (activeTracker && activeTracker.mevMode === "none" && tx.rewardType === "EVM") {
        return false;
      }

      return true;
    });
  }, [transactions, selectedYear, selectedMonth, activeTracker]);

  // Get available months from filtered transactions (for the selected year)
  const availableMonths = React.useMemo(() => {
    const yearTransactions = transactions.filter((tx) => {
      const txYear = new Date(tx.timestamp * 1000).getFullYear();
      return txYear === selectedYear;
    });
    
    const months = new Set<number>();
    yearTransactions.forEach((tx) => {
      const month = new Date(tx.timestamp * 1000).getMonth();
      months.add(month);
    });
    return Array.from(months).sort((a, b) => b - a); // Sort descending (newest first)
  }, [transactions, selectedYear]);

  // Reset selected month when year changes
  React.useEffect(() => {
    setSelectedMonth(null); // Reset to "ALL" when year changes
  }, [selectedYear]);

  // Check for missing prices whenever transactions, prices, or selected year changes
  // This ensures the warning appears even if transactions load before prices or vice versa
  // We check the FILTERED transactions (for selected year) to show warning only for current year
  React.useEffect(() => {
    if (!ethPricesLoaded || !activeTracker) {
      // Clear warning if prices aren't loaded or no active tracker
      setError((currentError) => {
        if (currentError && currentError.startsWith("PRICE_WARNING:")) {
          return null;
        }
        return currentError;
      });
      return;
    }
    
    // Only check if we have transactions for the current tracker
    // If we have filtered transactions for the selected year, check for missing prices
    if (filteredTransactions.length > 0) {
      checkForMissingPrices(filteredTransactions);
    } else if (transactions.length > 0) {
      // If we have transactions but none for the selected year, clear price warning
      // (but keep "No incoming rewards" message if it exists)
      setError((currentError) => {
        if (currentError && currentError.startsWith("PRICE_WARNING:")) {
          return null;
        }
        return currentError; // Keep other errors like "No incoming rewards"
      });
    } else {
      // No transactions at all - clear price warning (other errors will be set by loadTransactions/fetchTransactions)
      setError((currentError) => {
        if (currentError && currentError.startsWith("PRICE_WARNING:")) {
          return null;
        }
        return currentError;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ethPricesLoaded, filteredTransactions, activeTrackerId, transactions.length]);

  // Fetch transactions when year changes (if we don't have data for that year)
  React.useEffect(() => {
    if (activeTracker && user) {
      // Check if we have transactions for the selected year in our current transactions
      const hasTransactionsForYear = transactions.some((tx) => {
        const txYear = new Date(tx.timestamp * 1000).getFullYear();
        return txYear === selectedYear;
      });
      
      // If we don't have transactions for this year, check Firestore first, then fetch from Etherscan if needed
      if (!hasTransactionsForYear) {
        console.log(`No transactions found for ${selectedYear} in current state, checking Firestore...`);
        
        // Check Firestore first
        hasFirestoreTransactionsForYear(user.uid, activeTracker.id, selectedYear)
          .then((hasInFirestore) => {
            if (hasInFirestore) {
              // Firestore has transactions for this year, reload from Firestore
              console.log(`Found transactions for ${selectedYear} in Firestore, loading...`);
              loadTransactions(activeTracker).catch((error) => {
                console.error("Failed to load transactions from Firestore:", error);
              });
            } else {
              // Firestore doesn't have transactions for this year, fetch from Etherscan
              console.log(`No transactions for ${selectedYear} in Firestore, fetching from Etherscan...`);
              fetchTransactions(activeTracker, false, selectedYear).catch((error) => {
                console.error("Failed to fetch transactions for year:", error);
              });
            }
          })
          .catch((error) => {
            console.error("Error checking Firestore for year:", error);
            // On error, try fetching from Etherscan anyway
            fetchTransactions(activeTracker, false, selectedYear).catch((fetchError) => {
              console.error("Failed to fetch transactions for year:", fetchError);
            });
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, activeTrackerId]);

  // Group transactions by month for display
  const transactionsByMonth = React.useMemo(() => {
    const groups: { [key: string]: Transaction[] } = {};
    filteredTransactions.forEach((tx) => {
      const date = new Date(tx.timestamp * 1000);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
      if (!groups[monthKey]) {
        groups[monthKey] = [];
      }
      groups[monthKey].push(tx);
    });
    // Sort months by date (newest first) - compare by timestamp of first transaction
    return Object.entries(groups)
      .sort(([, txsA], [, txsB]) => {
        const timestampA = Math.max(...txsA.map(tx => tx.timestamp));
        const timestampB = Math.max(...txsB.map(tx => tx.timestamp));
        return timestampB - timestampA; // Newest first
      })
      .map(([key, txs]) => {
        const date = new Date(txs[0].timestamp * 1000);
        return {
          monthKey: key,
          monthName: date.toLocaleDateString("en-US", { month: "long" }),
          transactions: txs,
        };
      });
  }, [filteredTransactions]);

  // Month CGT status for the selected year (used for month dots)
  const monthPaymentStatus = React.useMemo(() => {
    const stats: { [month: number]: { taxable: number; taxFree: number } } = {};
    const now = new Date();

    transactions.forEach((tx) => {
      const date = new Date(tx.timestamp * 1000);
      const year = date.getFullYear();
      if (year !== selectedYear) return;
      const month = date.getMonth(); // 0-11

      if (!stats[month]) {
        stats[month] = { taxable: 0, taxFree: 0 };
      }

      const holding = holdingStatusMap[tx.transactionHash] ?? "Hodling";
      // Determine CGT tax-free eligibility (Croatia rule: held >= 2 years and not sold)
      const rewardDate = new Date(tx.timestamp * 1000);
      const taxableUntil = new Date(rewardDate);
      taxableUntil.setFullYear(taxableUntil.getFullYear() + 2);
      const isTaxFree = holding !== "Sold" && now >= taxableUntil;

      if (isTaxFree) {
        stats[month].taxFree += 1;
      } else {
        stats[month].taxable += 1;
      }
    });

    type MonthStatus = "none" | "taxable" | "taxFree" | "mixed";
    const statusMap: { [month: number]: MonthStatus } = {};
    for (let m = 0; m < 12; m++) {
      const s = stats[m];
      if (!s || (s.taxable === 0 && s.taxFree === 0)) {
        statusMap[m] = "none";
      } else if (s.taxable > 0 && s.taxFree > 0) {
        statusMap[m] = "mixed";
      } else if (s.taxable > 0) {
        statusMap[m] = "taxable";
      } else {
        statusMap[m] = "taxFree";
      }
    }

    return statusMap;
  }, [transactions, selectedYear, holdingStatusMap]);

  // Calculate totals for ALL trackers (for All validators overview)
  const [allTrackersTotals, setAllTrackersTotals] = React.useState({
    totalRewards: 0,
    totalTaxes: 0,
    totalTaxesCurrentYear: 0, // Income tax for current year only
    totalEthRewards: 0,
    totalEthTaxes: 0,
    // Capital gains tax‑free amounts (across all trackers)
    totalCgtFreeRewards: 0,
    totalCgtFreeEth: 0,
  });

  // Load and calculate totals for all trackers
  React.useEffect(() => {
    const calculateAllTotals = async () => {
      let allRewards = 0;
      let allTaxes = 0;
      let allTaxesCurrentYear = 0;
      let allEthRewards = 0;
      let allEthTaxes = 0;
      let allCgtFreeRewards = 0;
      let allCgtFreeEth = 0;
      const currentYear = new Date().getFullYear();

      for (const tracker of trackers) {
        const cached = await getCachedTransactions(tracker.id);
        allRewards += cached.reduce((sum, tx) => {
          const value = getRewardsInCurrency(tx, globalCurrency);
          return sum + (isNaN(value) ? 0 : value);
        }, 0);
        allTaxes += cached.reduce((sum, tx) => {
          const value = getTaxesInCurrency(tx, globalCurrency);
          return sum + (isNaN(value) ? 0 : value);
        }, 0);
        // Calculate income tax for current year only
        allTaxesCurrentYear += cached.reduce((sum, tx) => {
          const txYear = new Date(tx.timestamp * 1000).getFullYear();
          if (txYear === currentYear) {
            const value = getTaxesInCurrency(tx, globalCurrency);
            return sum + (isNaN(value) ? 0 : value);
          }
          return sum;
        }, 0);
        allEthRewards += cached.reduce((sum, tx) => sum + (tx.ethAmount || 0), 0);
        allEthTaxes += cached.reduce((sum, tx) => sum + (tx.taxesInEth || 0), 0);

        // Capital gains tax‑free (currently implemented for Croatia: rewards held ≥ 2 years)
        if (tracker.country === "Croatia") {
          const now = new Date();
          cached.forEach((tx) => {
            const holding = holdingStatusMap[tx.transactionHash] ?? "Hodling";
            if (holding === "Sold") return;
            const rewardDate = new Date(tx.timestamp * 1000);
            const taxableUntil = new Date(rewardDate);
            taxableUntil.setFullYear(taxableUntil.getFullYear() + 2);
            if (now >= taxableUntil) {
              const cgtRewards = getRewardsInCurrency(tx, globalCurrency);
              allCgtFreeRewards += isNaN(cgtRewards) ? 0 : cgtRewards;
              allCgtFreeEth += tx.ethAmount || 0;
            }
          });
        }
      }

      setAllTrackersTotals({
        totalRewards: allRewards,
        totalTaxes: allTaxes,
        totalTaxesCurrentYear: allTaxesCurrentYear,
        totalEthRewards: allEthRewards,
        totalEthTaxes: allEthTaxes,
        totalCgtFreeRewards: allCgtFreeRewards,
        totalCgtFreeEth: allCgtFreeEth,
      });
    };

    if (trackers.length > 0) {
      calculateAllTotals();
    }
  }, [trackers, transactions, holdingStatusMap, globalCurrency]); // Recalculate when trackers, transactions, holding status, or currency changes

  // Year dropdown state - MUST be before early return to ensure hooks are always called
  const [isYearDropdownOpen, setIsYearDropdownOpen] = React.useState(false);
  const yearDropdownRef = useRef<HTMLDivElement>(null);

  // Calculate totals based on filtered transactions (for selected validator)
  // Use global currency for all calculations
  // Separate pending and non-pending transactions
  const pendingTransactions = filteredTransactions.filter((tx) => isPriceMissing(tx, globalCurrency));
  const nonPendingTransactions = filteredTransactions.filter((tx) => !isPriceMissing(tx, globalCurrency));
  const pendingCount = pendingTransactions.length;
  
  // Rewards: Include all transactions in ETH, but exclude pending from EUR
  const totalRewardsNonPending = nonPendingTransactions.reduce((sum, tx) => {
    const value = getRewardsInCurrency(tx, globalCurrency);
    return sum + (isNaN(value) ? 0 : value);
  }, 0);
  const totalRewards = filteredTransactions.reduce((sum, tx) => {
    const value = getRewardsInCurrency(tx, globalCurrency);
    return sum + (isNaN(value) ? 0 : value);
  }, 0);
  
  // Taxes: Exclude pending transactions from EUR calculation
  const totalTaxes = nonPendingTransactions.reduce((sum, tx) => {
    const value = getTaxesInCurrency(tx, globalCurrency);
    return sum + (isNaN(value) ? 0 : value);
  }, 0);
  
  // ETH totals include all transactions (pending or not)
  const totalEthRewards = filteredTransactions.reduce((sum, tx) => sum + (tx.ethAmount || 0), 0);
  const totalEthTaxes = filteredTransactions.reduce((sum, tx) => sum + (tx.taxesInEth || 0), 0);
  
  // Capital gains tax‑free amounts for the active tracker (Croatia: rewards held ≥ 2 years)
  const nowForCgt = new Date();
  const isCroatia = activeTracker?.country === "Croatia";
  const totalCgtFreeEth = isCroatia
    ? filteredTransactions.reduce((sum, tx) => {
        const holding = holdingStatusMap[tx.transactionHash] ?? "Hodling";
        if (holding === "Sold") return sum;
        const rewardDate = new Date(tx.timestamp * 1000);
        const taxableUntil = new Date(rewardDate);
        taxableUntil.setFullYear(taxableUntil.getFullYear() + 2);
        return nowForCgt >= taxableUntil ? sum + (tx.ethAmount || 0) : sum;
      }, 0)
    : 0;
  const totalCgtFreeRewards = isCroatia
    ? filteredTransactions.reduce((sum, tx) => {
        const holding = holdingStatusMap[tx.transactionHash] ?? "Hodling";
        if (holding === "Sold") return sum;
        const rewardDate = new Date(tx.timestamp * 1000);
        const taxableUntil = new Date(rewardDate);
        taxableUntil.setFullYear(taxableUntil.getFullYear() + 2);
        if (nowForCgt >= taxableUntil) {
          const cgtRewards = getRewardsInCurrency(tx, globalCurrency);
          return sum + (isNaN(cgtRewards) ? 0 : cgtRewards);
        }
        return sum;
      }, 0)
    : 0;

  // Use global currency for all displays
  const currencySymbol = globalCurrency === "EUR" ? "€" : "$";
  const valueLabel = globalCurrency === "EUR" ? "Value in EUR" : "Value in USD";
  const incomeTaxLabel = globalCurrency === "EUR" ? "Income tax (EUR)" : "Income tax (USD)";
  const allValidatorsCurrencySymbol = globalCurrency === "EUR" ? "€" : "$";
  const activeIndex = trackers.findIndex((t) => t.id === activeTrackerId);

  // Human-readable description of the currently selected time range
  const dataShownText = (() => {
    if (!selectedYear) return "";
    if (selectedMonth === null) {
      return `Data shown for Jan–Dec ${selectedYear}`;
    }
    const monthName = new Date(selectedYear, selectedMonth, 1).toLocaleDateString("en-US", {
      month: "short",
    });
    return `Data shown for ${monthName} ${selectedYear}`;
  })();

  // Copy to clipboard function
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      console.log(`${label} copied to clipboard`);
      if (label === "Wallet address") {
        setWalletCopied(true);
        setTimeout(() => setWalletCopied(false), 650);
      }
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // CSV Export with year filter
  const exportToCSV = (year: number) => {
    if (!activeTracker) return;
    const yearTransactions = transactions.filter((tx) => {
      const txYear = new Date(tx.timestamp * 1000).getFullYear();
      return txYear === year;
    });
    
    if (yearTransactions.length === 0) {
      alert(`No transactions found for year ${year}`);
      return;
    }
    
    const currencySymbol = globalCurrency === "EUR" ? "€" : "$";
    const currencyCode = globalCurrency === "EUR" ? "EUR" : "USD";
    const headers = [
      "Date",
      "Time",
      "Reward type",
      "Reward (ETH)",
      `ETH Price (${currencySymbol})`,
      `Value in ${currencyCode} (${currencySymbol})`,
      "Tax Rate (%)",
      `Income tax (${currencyCode})`,
      "Transaction Hash",
    ];
    const rows = yearTransactions.map((tx) => {
      const ethPrice = getEthPriceForDisplay(tx, globalCurrency);
      const rewardsInCurrency = getRewardsInCurrency(tx, globalCurrency);
      const taxesInCurrency = getTaxesInCurrency(tx, globalCurrency);
      return [
        tx.date || "",
        tx.time || "",
        tx.rewardType || "EVM",
        formatNumber(tx.ethAmount || 0, 6, globalCurrency),
        formatNumber(ethPrice, 2, globalCurrency),
        formatNumber(rewardsInCurrency, 2, globalCurrency),
        (tx.taxRate || 0).toString(),
        formatNumber(taxesInCurrency, 2, globalCurrency),
        tx.rewardType === "CL" ? "" : (tx.transactionHash || ""),
      ];
    });
    
    // Calculate totals for the summary row
    const totalEthRewards = yearTransactions.reduce((sum, tx) => sum + (tx.ethAmount || 0), 0);
    const totalRewardsInCurrency = yearTransactions.reduce((sum, tx) => {
      return sum + getRewardsInCurrency(tx, globalCurrency);
    }, 0);
    const totalTaxesInCurrency = yearTransactions.reduce((sum, tx) => {
      return sum + getTaxesInCurrency(tx, globalCurrency);
    }, 0);
    const taxRate = activeTracker.taxRate || 0;
    
    // Create total row
    const totalRow = [
      "TOTAL",
      "", // Time
      "", // Reward type
      formatNumber(totalEthRewards, 6, globalCurrency),
      "", // ETH Price
      formatNumber(totalRewardsInCurrency, 2, globalCurrency),
      taxRate.toString(),
      formatNumber(totalTaxesInCurrency, 2, globalCurrency),
      "", // Transaction Hash
    ];
    
    // Create header rows with tracker information
    const trackerName = activeTracker.name || "Validator Tracker";
    const trackerLocation = activeTracker.country || "Unknown";
    const consensusAddress = activeTracker.walletAddress || "";
    const executionAddress = activeTracker.feeRecipientAddress || activeTracker.walletAddress || "";
    
    // Number of columns in the table
    const numColumns = headers.length;
    
    // Header rows (text in first column only, rest empty - will appear to span when opened in Excel)
    const headerRows = [
      [`${trackerName} - Location: ${trackerLocation}`, ...Array(numColumns - 1).fill("")],
      [`Consensus layer withdrawal address: ${consensusAddress}`, ...Array(numColumns - 1).fill("")],
      [`Execution layer withdrawal address: ${executionAddress}`, ...Array(numColumns - 1).fill("")],
      Array(numColumns).fill(""), // Empty row for spacing
    ];
    
    const csv = [...headerRows, headers, ...rows, totalRow]
      .map((r) => r.map((c) => `"${c}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeTracker.name || "validator").replace(/\s+/g, "_")}_transactions_${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowExportModal(false);
  };

  // Close year dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (yearDropdownRef.current && !yearDropdownRef.current.contains(event.target as Node)) {
        setIsYearDropdownOpen(false);
      }
    };

    if (isYearDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isYearDropdownOpen]);

  return (
    <div style={{ width: "100%", minWidth: "1130px", paddingLeft: "15px", paddingRight: "15px", boxSizing: "border-box" }}>
      {/* Your validators */}
      <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#aaaaaa" }}>Your validators</h3>
      <div style={{ background: "#181818", border: "1px solid #2b2b2b", borderRadius: "14px", marginBottom: "24px", width: "100%", minWidth: "1100px", boxSizing: "border-box" }}>
        <div style={{ borderRadius: "13px", padding: "24px" }}>
          {trackers.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px" }}>
              <h2 style={{ margin: 0, marginBottom: "8px", color: "#f0f0f0", fontSize: "1.5rem", fontWeight: 600 }}>
                No trackers yet
              </h2>
              <p style={{ margin: 0, marginBottom: "24px", color: "#aaaaaa", fontSize: "0.9rem" }}>
                Create your first validator tracker to get started.
              </p>
              <button
                onClick={() => onAddTracker?.()}
                style={{
                  background: "#555555",
                  border: "none",
                  borderRadius: "10px",
                  padding: "10px 20px",
                  color: "#f0f0f0",
                  textTransform: "none",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "#666666";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "#555555";
                }}
              >
                Add a validator tracker
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
              {trackers.map((tracker) => (
                <button
                  key={tracker.id}
                  onClick={() => setActiveTracker(tracker.id)}
                  style={{
                    background: activeTrackerId === tracker.id ? "#555555" : "#2b2b2b",
                    padding: "12px 20px",
                    border: "none",
                    borderRadius: "10px",
                    color: activeTrackerId === tracker.id ? "white" : "#aaaaaa",
                    cursor: "pointer",
                    fontWeight: activeTrackerId === tracker.id ? 600 : 400,
                    transition: "background 0.2s, color 0.2s, transform 0.2s",
                    transitionProperty: "background, color, transform",
                    position: "relative",
                  }}
                  onMouseEnter={(e) => {
                    if (activeTrackerId !== tracker.id) {
                      e.currentTarget.style.background = "#383838";
                      e.currentTarget.style.transform = "scale(1.05)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (activeTrackerId !== tracker.id) {
                      e.currentTarget.style.background = "#2b2b2b";
                      e.currentTarget.style.transform = "scale(1)";
                    }
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      visibility: "hidden",
                      position: "absolute",
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}
                  >
                    {tracker.name || `Validator ${tracker.walletAddress.slice(0, 6)}...`}
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {tracker.name || `Validator ${tracker.walletAddress.slice(0, 6)}...`}
                  </span>
                </button>
              ))}
              {onAddTracker && (
                <button
                  onClick={onAddTracker}
                  style={{
                    background: "transparent",
                    padding: "12px 20px",
                    border: "1px solid #555555",
                    borderRadius: "10px",
                    color: "#aaaaaa",
                    cursor: "pointer",
                    fontWeight: 400,
                    transition: "all 0.2s",
                    textTransform: "none",
                  }}
                >
                  + Add validator tracker
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Validator overview - for the selected validator's rewards (all years) */}
      {trackers.length > 0 && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#aaaaaa" }}>Validator overview</h3>
          <div style={{ background: "#181818", border: "1px solid #2b2b2b", borderRadius: "14px", padding: "24px", marginBottom: "24px", width: "100%", minWidth: "1100px", boxSizing: "border-box" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
        {/* First Card - TOTAL ETH EARNED */}
        <div style={{ background: "linear-gradient(45deg, #8ec7f9, #3788fd)", padding: "2px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)", display: "flex" }}>
          <div style={{ background: "linear-gradient(45deg, #3088d5, #4b9ee7, #3088d5)", padding: "20px", borderRadius: "12px", position: "relative", display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box" }}>
            <div style={{ position: "absolute", top: "12px", right: "12px", cursor: "pointer" }}
              onMouseEnter={() => setVisibleTooltip("rewards")}
              onMouseLeave={() => setVisibleTooltip(null)}
            >
              <img 
                src="/staking_rewards_tracker/icons/info_icon.svg" 
                alt="Info" 
                style={{ width: "16px", height: "16px", filter: "brightness(0) invert(1)" }}
              />
              {visibleTooltip === "rewards" && (
                <div 
                  className="tooltip-gradient-border"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: "-9px",
                    minWidth: "200px",
                    maxWidth: "250px",
                    zIndex: 1000,
                    opacity: visibleTooltip === "rewards" ? 1 : 0,
                    transition: "opacity 0.2s",
                    pointerEvents: "none",
                  }}
                >
                  <div className="tooltip-content" style={{
                    color: "white",
                    fontSize: "0.85rem",
                    whiteSpace: "pre-line",
                  }}>
                    Total ETH rewards received{'\n'}across all validators and all years.
                  </div>
                </div>
              )}
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.9)", fontWeight: 700, letterSpacing: "0.5px" }}>TOTAL ETH EARNED</h3>
              <p style={{ margin: 0, fontSize: "2rem", fontWeight: 700, color: "white", whiteSpace: "nowrap", lineHeight: "1.2" }}>
                {formatNumber(allTrackersTotals.totalEthRewards, 4, globalCurrency)}<span style={{ fontSize: "1.4rem" }}> ETH</span>
              </p>
            </div>
            <div style={{ marginTop: "6px" }}>
              <p style={{ margin: "0 0 0px 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.85)", lineHeight: "1.4" }}>
                Value at receipt: {formatCurrency(allTrackersTotals.totalRewards, 2, globalCurrency)}
              </p>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "rgba(255,255,255,0.85)", lineHeight: "1.4" }}>
                Value today: {currentEthPriceError ? (
                  <span style={{ color: "rgba(255,255,255,0.7)" }}>Currently not available</span>
                ) : currentEthPrice ? (
                  formatCurrency(allTrackersTotals.totalEthRewards * (globalCurrency === "EUR" ? currentEthPrice.eur : currentEthPrice.usd), 2, globalCurrency)
                ) : (
                  <span style={{ color: "rgba(255,255,255,0.7)" }}>Loading...</span>
                )}
              </p>
            </div>
          </div>
        </div>
        {/* Second Card - TOTAL INCOME TAX */}
        <div style={{ background: "linear-gradient(45deg, #f8c94c, #c18d02)", padding: "2px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)", display: "flex" }}>
          <div style={{ background: "linear-gradient(45deg, #c18d02, #dea611, #c18d02)", padding: "20px", borderRadius: "12px", position: "relative", display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box" }}>
            <div style={{ position: "absolute", top: "12px", right: "12px", cursor: "pointer" }}
              onMouseEnter={() => setVisibleTooltip("taxes")}
              onMouseLeave={() => setVisibleTooltip(null)}
            >
              <img 
                src="/staking_rewards_tracker/icons/info_icon.svg" 
                alt="Info" 
                style={{ width: "16px", height: "16px", filter: "brightness(0) invert(1)" }}
              />
              {visibleTooltip === "taxes" && (
                <div 
                  className="tooltip-gradient-border"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: "-9px",
                    minWidth: "200px",
                    maxWidth: "250px",
                    zIndex: 1000,
                    opacity: visibleTooltip === "taxes" ? 1 : 0,
                    transition: "opacity 0.2s",
                    pointerEvents: "none",
                  }}
                >
                  <div className="tooltip-content" style={{
                    color: "white",
                    fontSize: "0.85rem",
                    whiteSpace: "pre-line",
                  }}>
                    Total income tax accross all validators and all years.
                  </div>
                </div>
              )}
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.9)", fontWeight: 700, letterSpacing: "0.5px" }}>TOTAL INCOME TAX</h3>
              <p style={{ margin: 0, fontSize: "2rem", fontWeight: 700, color: "white", whiteSpace: "nowrap", lineHeight: "1.2" }}>
                {globalCurrency === "EUR" ? (
                  <>
                    {formatNumber(allTrackersTotals.totalTaxes, 2, globalCurrency)}<span style={{ fontSize: "1.4rem" }}> €</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: "1.4rem" }}>$</span>{formatNumber(allTrackersTotals.totalTaxes, 2, globalCurrency)}
                  </>
                )}
              </p>
            </div>
            <div style={{ marginTop: "6px" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "rgba(255,255,255,0.85)", lineHeight: "1.4" }}>
                Due this year: {formatCurrency(allTrackersTotals.totalTaxesCurrentYear, 2, globalCurrency)}
              </p>
            </div>
          </div>
        </div>
        {/* Third Card - CAPITAL GAIN TAX FREE */}
        <div style={{ background: "linear-gradient(45deg, #2fd3ab, #0f9d7a)", padding: "2px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)", display: "flex" }}>
          <div style={{ background: "linear-gradient(45deg, #0f9d7a, #24ba95, #0f9d7a)", padding: "20px", borderRadius: "12px", position: "relative", display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box" }}>
            <div style={{ position: "absolute", top: "12px", right: "12px", cursor: "pointer" }}
              onMouseEnter={() => setVisibleTooltip("cgtFree")}
              onMouseLeave={() => setVisibleTooltip(null)}
            >
              <img 
                src="/staking_rewards_tracker/icons/info_icon.svg" 
                alt="Info" 
                style={{ width: "16px", height: "16px", filter: "brightness(0) invert(1)" }}
              />
              {visibleTooltip === "cgtFree" && (
                <div 
                  className="tooltip-gradient-border"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: "-9px",
                    minWidth: "200px",
                    maxWidth: "250px",
                    zIndex: 1000,
                    opacity: visibleTooltip === "cgtFree" ? 1 : 0,
                    transition: "opacity 0.2s",
                    pointerEvents: "none",
                  }}
                >
                  <div className="tooltip-content" style={{
                    color: "white",
                    fontSize: "0.85rem",
                    whiteSpace: "pre-line",
                  }}>
                    Total ETH rewards that are capital gain tax free (held more than 2 years).
                  </div>
                </div>
              )}
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.9)", fontWeight: 700, letterSpacing: "0.5px" }}>CAPITAL GAIN TAX FREE</h3>
              <p style={{ margin: 0, fontSize: "2rem", fontWeight: 700, color: "white", whiteSpace: "nowrap", lineHeight: "1.2" }}>
                {formatNumber(allTrackersTotals.totalCgtFreeEth, 6, globalCurrency)}<span style={{ fontSize: "1.4rem" }}> ETH</span>
              </p>
            </div>
            <div style={{ marginTop: "6px" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "rgba(255,255,255,0.85)", lineHeight: "1.4" }}>
                Value today: {currentEthPriceError ? (
                  <span style={{ color: "rgba(255,255,255,0.7)" }}>Currently not available</span>
                ) : currentEthPrice ? (
                  formatCurrency(allTrackersTotals.totalCgtFreeEth * (globalCurrency === "EUR" ? currentEthPrice.eur : currentEthPrice.usd), 2, globalCurrency)
                ) : (
                  <span style={{ color: "rgba(255,255,255,0.7)" }}>Loading...</span>
                )}
              </p>
            </div>
          </div>
        </div>
            </div>
          </div>
        </>
      )}

      {/* Validator Selected + Incoming Rewards combined */}
      {activeTracker && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#aaaaaa" }}>Validator selected</h3>
          <div style={{ background: "#181818", border: "1px solid #2b2b2b", borderRadius: "14px", marginBottom: "24px", width: "100%", minWidth: "1100px", boxSizing: "border-box" }}>
            <div style={{ borderRadius: "13px", padding: "24px" }}>
              {/* Header row: validator name, validator pubkey + copy, action buttons */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
                  <h2 style={{ margin: 0, color: "#f0f0f0" }}>
                    {activeTracker.name || `${(activeTracker.validatorPublicKey || activeTracker.walletAddress).slice(0, 10)}...`}
                  </h2>
                  <div style={{ width: "1px", height: "16px", background: "#aaaaaa" }}></div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                    onMouseEnter={(e) => {
                      const p = e.currentTarget.querySelector("p");
                      const img = e.currentTarget.querySelector("img");
                      if (p) p.style.color = "#f0f0f0";
                      if (img) img.style.filter = "brightness(0) invert(1)";
                    }}
                    onMouseLeave={(e) => {
                      const p = e.currentTarget.querySelector("p");
                      const img = e.currentTarget.querySelector("img");
                      if (p) p.style.color = "#aaaaaa";
                      if (img) img.style.filter = "brightness(0) saturate(100%) invert(67%)";
                      (e.currentTarget as HTMLDivElement).style.transform = "scale(1)";
                    }}
                    onMouseDown={(e) => {
                      (e.currentTarget as HTMLDivElement).style.transform = "scale(0.96)";
                    }}
                    onMouseUp={(e) => {
                      (e.currentTarget as HTMLDivElement).style.transform = "scale(1)";
                    }}
                    onClick={() =>
                      copyToClipboard(
                        activeTracker.validatorPublicKey || activeTracker.walletAddress,
                        activeTracker.validatorPublicKey ? "Validator public key" : "Wallet address"
                      )
                    }
                  >
                    <p style={{ margin: 0, fontSize: "0.85rem", color: "#aaaaaa", transition: "color 0.2s" }}>
                      {(activeTracker.validatorPublicKey || activeTracker.walletAddress).slice(0, 7)}...
                      {(activeTracker.validatorPublicKey || activeTracker.walletAddress).slice(-5)}
                    </p>
                    <img
                      src="/staking_rewards_tracker/icons/copy_icon.svg"
                      alt="Copy"
                      style={{ width: "16px", height: "16px", filter: "brightness(0) saturate(100%) invert(67%)", transition: "filter 0.2s", border: "none" }}
                    />
                  </div>
                  {walletCopied && (
                    <div
                      style={{
                        position: "absolute",
                        top: "-18px",
                        left: "50%",
                        transform: "translateX(-50%)",
                        padding: "2px 6px",
                        borderRadius: "6px",
                        background: "#2b2b2b",
                        color: "#f0f0f0",
                        fontSize: "0.7rem",
                        pointerEvents: "none",
                      }}
                    >
                      Copied!
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 16 }}>
                  <button
                    onClick={() => setShowSettings(true)}
                    style={{ background: "#2b2b2b", padding: "10px 12px", transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6, border: "none", borderRadius: "9px", textTransform: "none" }}
                    title="Settings"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#383838";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 22.97 22.66" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M14.28,20.02c-.42.15-.86.26-1.3.35-.07.23-.13.43-.18.62-.1.36-.17.68-.22.98-.07.38-.38.66-.77.68-1.28.07-2.59-.08-3.88-.42-.13-.04-.27-.08-.41-.12-.31-.1-.53-.37-.57-.69-.01-.13-.03-.27-.04-.42-.03-.3-.04-.54-.08-1.07-.01-.19-.02-.32-.03-.42-.67-.36-1.3-.8-1.88-1.34-.48.11-.95.2-1.82.35l-.19.03c-.3.05-.61-.07-.79-.31-.89-1.16-1.56-2.46-2-3.86-.1-.33.01-.69.29-.89.5-.38.98-.74,1.46-1.07-.17-1.13-.14-2.27.1-3.35-.5-.34-.98-.7-1.43-1.07-.27-.22-.37-.6-.24-.93.62-1.61,1.62-3.01,2.98-4.17.28-.24.7-.26,1-.05.31.22.55.41,1.09.87.07.06.12.1.17.14.52-.35,1.07-.66,1.66-.91.03-.6.06-1.21.1-1.74.02-.35.26-.64.6-.74C9.65,0,11.49-.12,13.25.15c.33.05.6.3.67.63.04.17.08.34.12.53.07.34.13.61.25,1.22.21.1.41.17.6.25.32.12.63.27.94.42.17-.14.35-.29.64-.52l.06-.05c.29-.23.45-.36.63-.51.28-.23.68-.25.98-.05,1.51,1.02,2.76,2.35,3.61,3.85.18.33.12.74-.15,1l-.32.3c-.19.18-.27.26-.38.36-.22.21-.41.38-.59.54.22.59.36,1.21.43,1.83.51.21,1.06.42,1.69.65.35.13.56.47.53.84-.06.78-.19,1.54-.39,2.28-.19.7-.43,1.38-.73,2.03-.15.33-.49.52-.85.47-.53-.07-1.07-.15-1.71-.25-.22.35-.46.69-.71,1.01.26.4.55.82.87,1.27.23.33.19.78-.09,1.06-.8.79-1.7,1.45-2.67,1.98-.27.15-.61.13-.86-.05-.28-.2-.5-.37-1.21-.95-.02-.02-.17-.14-.32-.26ZM11.84,20.73c.08-.29.17-.59.28-.95.06-.18.21-.31.4-.34.57-.09,1.14-.24,1.68-.45.17-.06.35-.03.49.08.13.1.51.41.54.44.61.5.85.69,1.08.85.81-.45,1.56-1,2.24-1.65-.37-.53-.7-1.02-1.01-1.49-.12-.19-.1-.43.04-.6.39-.44.73-.93,1.02-1.44.1-.18.31-.28.52-.25.72.12,1.31.21,1.88.29.25-.56.46-1.15.62-1.75.17-.64.29-1.3.35-1.97-.7-.26-1.31-.5-1.88-.73-.18-.07-.3-.24-.31-.43-.05-.74-.22-1.46-.51-2.16-.08-.2-.03-.43.13-.57.25-.22.5-.45.82-.75.1-.1.19-.18.37-.35l.22-.21c-.75-1.28-1.82-2.42-3.12-3.32-.15.12-.3.24-.54.44l-.06.05c-.44.35-.64.52-.88.72-.16.14-.39.16-.57.06-.36-.2-.74-.38-1.12-.53-.26-.1-.52-.19-.79-.27-.18-.05-.32-.2-.35-.38l-.07-.34c-.12-.61-.18-.87-.25-1.21-.03-.14-.06-.27-.09-.4-1.54-.22-3.15-.12-4.67.28-.04.6-.08,1.26-.1,1.91,0,.2-.13.37-.32.44-.74.29-1.43.67-2.05,1.14-.18.14-.44.13-.62-.01-.14-.11-.25-.21-.48-.4-.44-.38-.66-.56-.9-.73-1.14,1-1.99,2.19-2.54,3.55.47.39.99.76,1.53,1.12.18.12.26.34.21.55-.3,1.14-.34,2.37-.12,3.57.04.19-.04.39-.2.5-.51.36-1.03.74-1.58,1.16.39,1.21.97,2.33,1.73,3.34h.08c1-.19,1.46-.28,2.01-.42.17-.04.35,0,.47.13.63.61,1.32,1.11,2.08,1.48.16.08.27.23.28.41.01.19.03.35.05.7.04.54.05.77.08,1.06,0,.1.02.19.03.28.09.03.17.05.25.07,1.15.31,2.3.44,3.43.4.06-.29.13-.59.21-.92ZM15.95,8.31c.19.34.34.69.46,1.04.95,2.91-.59,5.94-3.49,6.89-2.65.86-5.71-.74-6.58-3.44-.83-2.57.72-5.63,3.64-6.58.19-.06.38-.11.57-.15,2.32-.48,4.44.51,5.4,2.23ZM10.75,7.06c-.15.03-.31.07-.47.12-2.4.78-3.66,3.27-3,5.32.71,2.17,3.21,3.48,5.32,2.79,2.38-.77,3.63-3.24,2.85-5.63-.1-.3-.22-.59-.38-.86-.75-1.34-2.44-2.13-4.33-1.74l-.1-.49.1.49Z" fill="#aaaaaa" />
                    </svg>
                    <span style={{ color: "#aaaaaa" }}>Settings</span>
                  </button>
                  <button
                    onClick={() => {
                      setShowMarkSoldModal(true);
                      setMarkSoldMode("year");
                    }}
                    style={{ background: "#2b2b2b", padding: "10px 12px", transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6, border: "none", borderRadius: "9px", textTransform: "none" }}
                    title="Mark rewards as sold"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#383838";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    <img
                      src="/staking_rewards_tracker/icons/sold_icon.svg"
                      alt="Mark as sold"
                      style={{ width: "18px", height: "18px", filter: "brightness(0) saturate(100%) invert(67%)" }}
                    />
                    <span style={{ color: "#aaaaaa" }}>Mark as sold</span>
                  </button>
                  <button
                    onClick={() => {
                      setExportYear(selectedYear);
                      setShowExportModal(true);
                    }}
                    disabled={transactions.length === 0}
                    style={{ background: "#2b2b2b", transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6, border: "none", borderRadius: "9px", padding: "10px 12px", textTransform: "none" }}
                    title="Export CSV"
                    onMouseEnter={(e) => {
                      if (!e.currentTarget.disabled) {
                        e.currentTarget.style.background = "#383838";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 87.5 88.23" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M84.38,25.73h-27.16c-1.73,0-3.12,1.4-3.12,3.13s1.4,3.12,3.12,3.12h24.03v50H6.25V31.98h24.03c1.73,0,3.12-1.4,3.12-3.12s-1.4-3.12-3.12-3.12H3.12c-1.73,0-3.12,1.4-3.12,3.12v56.25c0,1.73,1.4,3.12,3.12,3.12h81.25c1.73,0,3.12-1.4,3.12-3.12V28.86c0-1.73-1.4-3.12-3.12-3.13Z" fill="#aaaaaa" />
                      <path d="M40.63,19.48v42.04c0,1.73,1.4,3.12,3.12,3.12s3.12-1.4,3.12-3.12V19.48c0-1.73-1.4-3.12-3.12-3.12s-3.12,1.4-3.12,3.12Z" fill="#aaaaaa" />
                      <path d="M56.25,19.75c.79,0,1.58-.3,2.19-.89,1.23-1.21,1.25-3.19.05-4.42L45.98,1.68c-1.18-1.2-3.29-1.2-4.46,0l-12.5,12.76c-1.21,1.23-1.19,3.21.05,4.42,1.23,1.21,3.21,1.19,4.42-.05l10.27-10.48,10.27,10.48c.61.62,1.42.94,2.23.94h0Z" fill="#aaaaaa" />
                    </svg>
                    <span style={{ color: "#aaaaaa" }}>Export CSV</span>
                  </button>
                </div>
              </div>

              {/* Status row: validator status + execution rewards status */}
              <div style={{ marginTop: "4px", fontSize: "0.85rem", color: "#aaaaaa" }}>
                <span>
                  Status:{" "}
                  <span style={{ color: "#4ade80", fontWeight: 600 }}>
                    {(activeTracker.validatorStatus || "UNKNOWN").toUpperCase()}
                  </span>
                </span>
                <span style={{ margin: "0 8px", color: "#555555" }}>|</span>
                <span>
                  Execution rewards:{" "}
                  <span
                    style={{
                      color:
                        activeTracker.mevMode && activeTracker.mevMode !== "none"
                          ? "#4ade80"
                          : "#f97373",
                      fontWeight: 600,
                    }}
                  >
                    {activeTracker.mevMode && activeTracker.mevMode !== "none" ? "ACTIVE" : "INACTIVE"}
                  </span>
                </span>
              </div>

              {/* Validator metadata */}
              <p
                style={{
                  margin: "2px 0 0 0",
                  fontSize: "0.85rem",
                  color: "#aaaaaa",
                }}
              >
                Validator location: {activeTracker.country || "—"} - Income tax rate:{" "}
                {typeof activeTracker.taxRate === "number"
                  ? `${formatNumber(activeTracker.taxRate, 0, globalCurrency)}%`
                  : "—"}
              </p>

              {/* Filters row: year dropdown + months bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginTop: "24px", marginBottom: "12px" }}>
                {/* Year dropdown */}
                {availableYears.length > 0 && (
                  <div ref={yearDropdownRef} style={{ position: "relative" }}>
                    <button
                      onClick={() => {
                        if (availableYears.length > 1) {
                          setIsYearDropdownOpen((open) => !open);
                        }
                      }}
                      style={{
                        background: "#555555",
                        color: "#f0f0f0",
                        padding: "8px 16px",
                        border: "none",
                        borderRadius: "8px",
                        cursor: availableYears.length > 1 ? "pointer" : "default",
                        fontSize: "0.9rem",
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      {selectedYear}
                      <span style={{ fontSize: "0.7rem" }}>▾</span>
                    </button>
                    {isYearDropdownOpen && (
                      <div
                        style={{
                          position: "absolute",
                          top: "110%",
                          left: 0,
                          background: "#181818",
                          borderRadius: "8px",
                          border: "1px solid #2b2b2b",
                          boxShadow: "0 8px 16px rgba(0,0,0,0.5)",
                          minWidth: "100%",
                          zIndex: 10,
                        }}
                      >
                        {availableYears.map((year) => (
                          <button
                            key={year}
                            onClick={() => {
                              setSelectedYear(year);
                              setIsYearDropdownOpen(false);
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "#2b2b2b";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                            }}
                            style={{
                              width: "100%",
                              background: "transparent",
                              color: year === selectedYear ? "#ffffff" : "#aaaaaa",
                              padding: "8px 12px",
                              border: "none",
                              textAlign: "left",
                              cursor: "pointer",
                              fontSize: "0.9rem",
                              transition: "background 0.2s",
                            }}
                          >
                            {year}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Month Filter */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      background: "#2b2b2b",
                      borderRadius: "8px",
                      padding: "2px",
                      gap: 0,
                      alignItems: "center",
                      minWidth: "760px", // keep all months visible before wrapping
                      boxSizing: "border-box",
                    }}
                  >
                    <button
                      onClick={() => setSelectedMonth(null)}
                      style={{
                        background: selectedMonth === null ? "#555555" : "transparent",
                        color: selectedMonth === null ? "#f0f0f0" : "#aaaaaa",
                        padding: "8px 16px",
                        border: "none",
                        borderRadius: selectedMonth === null ? "6px" : "0",
                        cursor: "pointer",
                        fontSize: "0.9rem",
                        fontWeight: selectedMonth === null ? 600 : 400,
                        transition: "background 0.2s, color 0.2s",
                        textTransform: "none",
                        position: "relative",
                        minWidth: "48px",
                      }}
                      onMouseEnter={(e) => {
                        if (selectedMonth !== null) {
                          e.currentTarget.style.color = "#f0f0f0";
                          e.currentTarget.style.fontWeight = "600";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (selectedMonth !== null) {
                          e.currentTarget.style.color = "#aaaaaa";
                          e.currentTarget.style.fontWeight = "400";
                        }
                      }}
                    >
                      <span style={{ 
                        fontWeight: selectedMonth === null ? 600 : 400,
                        visibility: "hidden",
                        position: "absolute",
                        whiteSpace: "nowrap",
                        pointerEvents: "none"
                      }}>All</span>
                      <span style={{ fontWeight: selectedMonth === null ? 600 : 400 }}>All</span>
                    </button>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((month) => {
                      const monthName = new Date(2024, month, 1).toLocaleDateString("en-US", { month: "short" });
                      const status = monthPaymentStatus[month] || "none";
                      let dotStyle: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", display: "inline-block" };
                      if (status === "taxFree") {
                        dotStyle = { ...dotStyle, background: "#00c853" };
                      } else if (status === "taxable") {
                        dotStyle = { ...dotStyle, background: "#ff5252" };
                      } else if (status === "mixed") {
                        dotStyle = { ...dotStyle, background: "linear-gradient(90deg, #00c853 50%, #ff5252 50%)" };
                      } else {
                        dotStyle = { ...dotStyle, background: "#777777" };
                      }
                      return (
                        <React.Fragment key={month}>
                          <div style={{ width: "1px", background: "#4b4b4b", margin: "4px 0" }}></div>
                          <button
                            onClick={() => setSelectedMonth(month)}
                            style={{
                              background: selectedMonth === month ? "#555555" : "transparent",
                              color: selectedMonth === month ? "#f0f0f0" : "#aaaaaa",
                              padding: "8px 16px",
                              border: "none",
                              borderRadius: selectedMonth === month ? "6px" : "0",
                              cursor: "pointer",
                              fontSize: "0.9rem",
                              fontWeight: selectedMonth === month ? 600 : 400,
                              transition: "background 0.2s, color 0.2s",
                              textTransform: "none",
                              position: "relative",
                              flex: 1,
                            }}
                            onMouseEnter={(e) => {
                              if (selectedMonth !== month) {
                                e.currentTarget.style.color = "#f0f0f0";
                                e.currentTarget.style.fontWeight = "600";
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (selectedMonth !== month) {
                                e.currentTarget.style.color = "#aaaaaa";
                                e.currentTarget.style.fontWeight = "400";
                              }
                            }}
                          >
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: 8,
                              }}
                            >
                              <span style={dotStyle} />
                              <span style={{ 
                                fontWeight: selectedMonth === month ? 600 : 400,
                                visibility: "hidden",
                                position: "absolute",
                                whiteSpace: "nowrap",
                                pointerEvents: "none"
                              }}>{monthName}</span>
                              <span style={{ fontWeight: selectedMonth === month ? 600 : 400 }}>{monthName}</span>
                            </span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Description of the selected time range */}
              <p style={{ margin: "0 0 16px 0", fontSize: "0.8rem", color: "#aaaaaa" }}>
                {dataShownText}
              </p>

              {/* Summary Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "16px" }}>
                {/* Card 1: Reward received */}
                <div style={{ background: "linear-gradient(45deg, #4a4949, #353536)", padding: "2px", borderRadius: "10px", display: "flex" }}>
                  <div style={{ background: "linear-gradient(to top, #383839, #242325)", padding: "16px", borderRadius: "8px", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa", fontWeight: 700 }}>Reward received</p>
                    <p style={{ margin: "0 0 4px 0", fontSize: "1.2rem", fontWeight: 600, color: "#32c0ea", whiteSpace: "nowrap" }}>
                      {formatNumber(totalEthRewards, 6, globalCurrency)}<span style={{ fontSize: "0.9rem", color: "#32c0ea" }}> ETH</span>
                    </p>
                    <p style={{ margin: 0, fontSize: "0.85rem", color: "#aaaaaa", lineHeight: "1.4" }}>
                      Value today: {currentEthPriceError ? (
                        <span style={{ color: "#888" }}>Currently not available</span>
                      ) : currentEthPrice ? (
                        formatCurrency(totalEthRewards * (globalCurrency === "EUR" ? currentEthPrice.eur : currentEthPrice.usd), 2, globalCurrency)
                      ) : (
                        <span style={{ color: "#888" }}>Loading...</span>
                      )}
                    </p>
                  </div>
                </div>
                {/* Card 2: Value at receipt */}
                <div style={{ background: "linear-gradient(45deg, #4a4949, #353536)", padding: "2px", borderRadius: "10px", display: "flex" }}>
                  <div style={{ background: "linear-gradient(to top, #383839, #242325)", padding: "16px", borderRadius: "8px", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa", fontWeight: 700 }}>Value at receipt</p>
                    <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#32c0ea", whiteSpace: "nowrap" }}>
                      {globalCurrency === "EUR" ? (
                        <>
                          {formatNumber(totalRewards, 2, globalCurrency)}<span style={{ fontSize: "0.9rem", color: "#32c0ea" }}> €</span>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: "0.9rem", color: "#32c0ea" }}>$</span>{formatNumber(totalRewards, 2, globalCurrency)}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                {/* Card 3: Income tax due */}
                <div style={{ background: "linear-gradient(45deg, #4a4949, #353536)", padding: "2px", borderRadius: "10px", display: "flex" }}>
                  <div style={{ background: "linear-gradient(to top, #383839, #242325)", padding: "16px", borderRadius: "8px", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa", fontWeight: 700 }}>Income tax due</p>
                    <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#dbaa46", whiteSpace: "nowrap" }}>
                      {globalCurrency === "EUR" ? (
                        <>
                          {formatNumber(totalTaxes, 2, globalCurrency)}<span style={{ fontSize: "0.9rem", color: "#dbaa46" }}> €</span>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: "0.9rem", color: "#dbaa46" }}>$</span>{formatNumber(totalTaxes, 2, globalCurrency)}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                {/* Card 4: Capital gain tax free */}
                <div style={{ background: "linear-gradient(45deg, #4a4949, #353536)", padding: "2px", borderRadius: "10px", display: "flex" }}>
                  <div style={{ background: "linear-gradient(to top, #383839, #242325)", padding: "16px", borderRadius: "8px", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa", fontWeight: 700 }}>Capital gain tax free</p>
                    <p style={{ margin: "0 0 4px 0", fontSize: "1.2rem", fontWeight: 600, color: "#6fb489", whiteSpace: "nowrap" }}>
                      {formatNumber(totalCgtFreeEth, 6, globalCurrency)}<span style={{ fontSize: "0.9rem", color: "#6fb489" }}> ETH</span>
                    </p>
                    <p style={{ margin: 0, fontSize: "0.85rem", color: "#aaaaaa", lineHeight: "1.4" }}>
                      Value today: {currentEthPriceError ? (
                        <span style={{ color: "#888" }}>Currently not available</span>
                      ) : currentEthPrice ? (
                        formatCurrency(totalCgtFreeEth * (globalCurrency === "EUR" ? currentEthPrice.eur : currentEthPrice.usd), 2, globalCurrency)
                      ) : (
                        <span style={{ color: "#888" }}>Loading...</span>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Error Message */}
              {error && (
                <div
                  style={{
                    padding: "12px",
                    background: "#2a1a1a",
                    border: "1px solid #ff4444",
                    borderRadius: "8px",
                    color: "#ff8888",
                    marginBottom: "16px",
                  }}
                >
                  {error.startsWith("PRICE_WARNING:") ? (
                    <>
                      ⚠ Ethereum price pending for <strong>{error.split(":")[1]} reward{parseInt(error.split(":")[1]) > 1 ? 's' : ''}</strong>. Price updates daily at 00:00 CET.
                    </>
                  ) : (
                    error
                  )}
                </div>
              )}

              {/* Incoming rewards table */}
              {loading ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <p style={{ color: "#f0f0f0", fontSize: "1rem", marginBottom: "8px" }}>
                Loading transactions
                <span style={{ animation: "blink 1.4s infinite" }}>.</span>
                <span style={{ animation: "blink 1.4s infinite 0.2s" }}>.</span>
                <span style={{ animation: "blink 1.4s infinite 0.4s" }}>.</span>
                {loadingProgress.total > 0 && (
                  <span style={{ marginLeft: "12px", color: "#aaaaaa" }}>
                    ({loadingProgress.current}/{loadingProgress.total})
                  </span>
                )}
              </p>
              <p style={{ color: "#aaaaaa", fontSize: "0.9rem", marginTop: "8px" }}>
                Depending on the number of transactions, this may take a few minutes.
              </p>
            </div>
          ) : transactions.length === 0 && !error ? (
            <p>No transactions found.</p>
          ) : filteredTransactions.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid transparent", borderImage: "linear-gradient(45deg, #0c86ab, #2d55ac) 1" }}>
                    <th style={{ padding: "12px", textAlign: "left", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600 }}>Received</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>Reward type</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>Reward (ETH)</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>ETH Price</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>{valueLabel}</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>{incomeTaxLabel}</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>CGT status</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>Hodling status</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600 }}>Reward Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {transactionsByMonth.map((monthGroup) => (
                    <React.Fragment key={monthGroup.monthKey}>
                      {/* Month separator row */}
                      <tr style={{ borderBottom: "1px solid transparent", borderImage: "linear-gradient(45deg, #0c86ab, #2d55ac) 1" }}>
                      <td 
                          colSpan={9} 
                          style={{ 
                            padding: "12px 12px 8px 12px", 
                            color: "#aaaaaa", 
                            fontSize: "0.9rem", 
                            fontWeight: 600,
                            background: "#2b2b2b"
                          }}
                        >
                          {monthGroup.monthName}
                        </td>
                      </tr>
                      {/* Transactions for this month */}
                      {monthGroup.transactions.map((tx, idx) => (
                        <React.Fragment key={`${monthGroup.monthKey}-${idx}`}>
                      <tr>
                            <td colSpan={9} style={{ padding: 0, height: "1px" }}>
                              <div style={{ height: "1px", background: "#383838" }}></div>
                            </td>
                          </tr>
                          <tr>
                      <td style={{ padding: "12px", color: "#aaaaaa", textAlign: "left" }}>{tx.date}, {tx.time}</td>
                      <td style={{ padding: "12px", color: "#aaaaaa", textAlign: "center", whiteSpace: "nowrap" }}>
                        <span style={{ 
                          padding: "4px 8px", 
                          borderRadius: "4px", 
                          background: tx.rewardType === "CL" ? "#2d55ac" : "#0c86ab",
                          color: "#f0f0f0",
                          fontSize: "0.8rem",
                          fontWeight: 600
                        }}>
                          {tx.rewardType === "CL" ? "CL" : "EVM"}
                        </span>
                      </td>
                      <td style={{ padding: "12px", color: "#32c0ea", textAlign: "center" }}>{formatNumber(tx.ethAmount || 0, 6, globalCurrency)}</td>
                      <td style={{ padding: "12px", color: "#aaaaaa", whiteSpace: "nowrap", textAlign: "center" }}>
                        {isPriceMissing(tx, globalCurrency) ? (
                          <span style={{ color: "#e4a729" }}>Pending</span>
                        ) : (
                          formatCurrency(getEthPriceForDisplay(tx, globalCurrency), 2, globalCurrency)
                        )}
                      </td>
                      <td style={{ padding: "12px", color: "#32c0ea", textAlign: "center", whiteSpace: "nowrap" }}>
                        {isPriceMissing(tx, globalCurrency) ? (
                          <span style={{ color: "#e4a729" }}>Pending</span>
                        ) : (
                          formatCurrency(getRewardsInCurrency(tx, globalCurrency), 2, globalCurrency)
                        )}
                      </td>
                      <td style={{ padding: "12px", color: "#e4a729", whiteSpace: "nowrap", textAlign: "center" }}>
                        {isPriceMissing(tx, globalCurrency) ? (
                          <span style={{ color: "#e4a729" }}>Pending</span>
                        ) : (
                          formatCurrency(getTaxesInCurrency(tx, globalCurrency), 2, globalCurrency)
                        )}
                      </td>
                      {/* CGT Status column */}
                      <td style={{ padding: "12px 8px", textAlign: "center" }}>
                        {isCroatia ? (() => {
                          const rewardDate = new Date(tx.timestamp * 1000);
                          const taxableUntil = new Date(rewardDate);
                          taxableUntil.setFullYear(taxableUntil.getFullYear() + 2);
                          const now = nowForCgt;
                          const totalMs = taxableUntil.getTime() - rewardDate.getTime();
                          const elapsedMs = Math.max(0, now.getTime() - rewardDate.getTime());
                          const ratio = totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 1;
                          const progressPercent = Math.round(ratio * 100);
                          const isTaxFree = now >= taxableUntil;
                          const timezone = activeTracker ? getTimezoneForCountry(activeTracker.country) : "UTC";
                          const dateLabel = formatDate(taxableUntil, timezone, globalCurrency);
                          const barColor = isTaxFree ? "#55b685" : "#aaaaaa";
                          const dotColor = isTaxFree ? "#55b685" : "#ff5252";

                          return (
                            <div
                              style={{
                                display: "inline-block",
                                position: "relative",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  alignItems: "center",
                                  textAlign: "center",
                                }}
                              >
                                {isTaxFree ? (
                                  <>
                                    <span style={{ fontSize: "0.85rem", color: "#aaaaaa" }}>Tax free</span>
                                    <div
                                      style={{
                                        marginTop: 4,
                                        width: "100%",
                                        height: 4,
                                        borderRadius: 9999,
                                        background: "#2b2b2b",
                                        overflow: "hidden",
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: `${progressPercent}%`,
                                          height: "100%",
                                          background: barColor,
                                          transition: "width 0.3s ease-out",
                                        }}
                                      />
                                    </div>
                                  </>
                                ) : (
                                  <>
                                      <span style={{ fontSize: "0.85rem", color: "#aaaaaa", whiteSpace: "nowrap" }}>Taxable&nbsp;until</span>
                                      <span style={{ fontSize: "0.85rem", color: "#aaaaaa" }}>{dateLabel}</span>
                                    <div
                                      style={{
                                        marginTop: 4,
                                        width: "100%",
                                        height: 4,
                                        borderRadius: 9999,
                                        background: "#2b2b2b",
                                        overflow: "hidden",
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: `${progressPercent}%`,
                                          height: "100%",
                                          background: barColor,
                                          transition: "width 0.3s ease-out",
                                        }}
                                      />
                                    </div>
                                  </>
                                )}
                              </div>
                              <span
                                style={{
                                  position: "absolute",
                                  top: "50%",
                                  transform: "translateY(-50%)",
                                  left: "100%",
                                  marginLeft: 10,
                                  width: 8,
                                  height: 8,
                                  borderRadius: "50%",
                                  background: dotColor,
                                }}
                              />
                            </div>
                          );
                        })() : (
                          <span style={{ fontSize: "0.8rem", color: "#aaaaaa" }}>N/A</span>
                        )}
                      </td>
                      {/* Hodling status column */}
                      <td style={{ padding: "12px 8px", textAlign: "center" }}>
                        {(() => {
                          const holding = holdingStatusMap[tx.transactionHash] ?? "Hodling";
                          const isSold = holding === "Sold";
                          return (
                            <button
                              onClick={() => {
                                setHoldingStatusMap((prev) => ({
                                  ...prev,
                                  [tx.transactionHash]: isSold ? "Hodling" : "Sold",
                                }));
                              }}
                              style={{
                                padding: "4px 12px",
                                borderRadius: 9999,
                                border: isSold ? "1px solid transparent" : "1px solid #4b4b4b",
                                background: "#2b2b2b",
                                color: "#aaaaaa",
                                fontSize: "0.8rem",
                                cursor: "pointer",
                                textTransform: "none",
                                transition: "background 0.2s, transform 0.1s",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "#383838";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "#2b2b2b";
                              }}
                              onMouseDown={(e) => {
                                e.currentTarget.style.transform = "scale(0.96)";
                              }}
                              onMouseUp={(e) => {
                                e.currentTarget.style.transform = "scale(1)";
                              }}
                            >
                              {isSold ? "Sold" : "Hodling"}
                            </button>
                          );
                        })()}
                      </td>
                      {/* Reward Tx column */}
                      <td style={{ padding: "12px", textAlign: "center" }}>
                        {tx.rewardType === "CL" ? (
                          // Consensus Layer withdrawals don't have a real EVM tx hash
                          <span style={{ color: "#555555", fontSize: "0.85rem" }}>—</span>
                        ) : (
                          <div 
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "center" }}
                            onMouseEnter={(e) => {
                              const links = e.currentTarget.querySelectorAll("a");
                              links.forEach(link => {
                                (link as HTMLAnchorElement).style.color = "#aaaaaa";
                                (link as HTMLAnchorElement).style.textDecoration = "underline";
                              });
                              const img = e.currentTarget.querySelector("img") as HTMLImageElement | null;
                              if (img) {
                                // Light grey close to #aaaaaa so it visually matches the hash color
                                img.style.filter = "brightness(0) saturate(100%) invert(67%)";
                              }
                            }}
                            onMouseLeave={(e) => {
                              const links = e.currentTarget.querySelectorAll("a");
                              links.forEach(link => {
                                (link as HTMLAnchorElement).style.color = "#555555";
                                (link as HTMLAnchorElement).style.textDecoration = "none";
                              });
                              const img = e.currentTarget.querySelector("img") as HTMLImageElement | null;
                              if (img) img.style.filter = "brightness(0.9) saturate(100%) invert(33%)";
                            }}
                          >
                            <a
                              href={`https://etherscan.io/tx/${tx.transactionHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "#555555", textDecoration: "none", transition: "all 0.2s", fontSize: "0.85rem" }}
                            >
                              {tx.transactionHash.slice(0, 6)}...{tx.transactionHash.slice(-4)}
                            </a>
                            <a
                              href={`https://etherscan.io/tx/${tx.transactionHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ 
                                color: "#555555", 
                                textDecoration: "none",
                                display: "inline-flex",
                                alignItems: "center",
                                fontSize: "0.85rem",
                                transition: "all 0.2s",
                              }}
                              title="View on Etherscan"
                            >
                              <img 
                                src="/staking_rewards_tracker/icons/link_icon.svg" 
                                alt="View on Etherscan" 
                                style={{ width: "16px", height: "16px", filter: "brightness(0.9) saturate(100%) invert(33%)", transition: "filter 0.2s" }}
                              />
                            </a>
                          </div>
                        )}
                      </td>
                    </tr>
                        </React.Fragment>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
            </div>
          </div>
        </>
      )}

      {/* Disclaimer */}
      <div
        style={{
          marginTop: "8px",
          textAlign: "center",
          fontSize: "0.75rem",
          color: "#666666",
        }}
      >
        Not tax advice · Use at your own risk · Verify everything with a professional
      </div>

      {/* Loading Overlay */}
      {loading && (
        <div
          className="modal-overlay modal-overlay-enter"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(3px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1500,
            padding: "20px",
          }}
        >
          <div
            className="modal-card modal-card-enter"
            style={{
              width: "100%",
              maxWidth: "400px",
              position: "relative",
            }}
          >
            <div
              style={{
                background: "#181818",
                borderRadius: "18px",
                padding: "1px",
                border: "1px solid #2b2b2b",
              }}
            >
              <div
                style={{
                  background: "#181818",
                  borderRadius: "17px",
                  padding: "28px",
                  textAlign: "center",
                }}
              >
                <p style={{ color: "#f0f0f0", fontSize: "1rem", marginBottom: "16px", marginTop: 0 }}>
                  {loadingProgress.total > 0 ? (
                    <>Loading {loadingProgress.total} transactions<span style={{ animation: "blink 1.4s infinite" }}>.</span>
                    <span style={{ animation: "blink 1.4s infinite 0.2s" }}>.</span>
                    <span style={{ animation: "blink 1.4s infinite 0.4s" }}>.</span></>
                  ) : (
                    <>Loading transactions<span style={{ animation: "blink 1.4s infinite" }}>.</span>
                    <span style={{ animation: "blink 1.4s infinite 0.2s" }}>.</span>
                    <span style={{ animation: "blink 1.4s infinite 0.4s" }}>.</span></>
                  )}
                </p>
                {loadingProgress.total > 0 && (
                  <div
                    style={{
                      width: "100%",
                      height: "4px",
                      background: "#2b2b2b",
                      borderRadius: "2px",
                      overflow: "hidden",
                      marginBottom: "16px",
                    }}
                  >
                    <div
                      style={{
                        width: `${loadingProgress.progressPercent || 0}%`,
                        height: "100%",
                        background: "linear-gradient(90deg, #01e1fd, #6b6bff)",
                        borderRadius: "2px",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                )}
                <p style={{ color: "#aaaaaa", fontSize: "0.9rem", marginTop: 0, marginBottom: 0 }}>
                  Depending on the number of transactions, this may take a few minutes.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && activeTracker && (
        <TrackerSettingsModal
          tracker={activeTracker}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            // Get the updated tracker from the store
            const { trackers } = useTrackerStore.getState();
            const updatedTracker = trackers.find((t) => t.id === activeTracker.id);
            if (updatedTracker) {
              // Check if wallet address or fee recipient changed (requires refetch)
              const walletChanged = updatedTracker.walletAddress.toLowerCase() !== activeTracker.walletAddress.toLowerCase();
              const feeRecipientChanged = (updatedTracker.feeRecipientAddress || "") !== (activeTracker.feeRecipientAddress || "");
              
              if (walletChanged || feeRecipientChanged) {
                // Wallet or fee recipient changed - need to refetch transactions
                setTransactions([]);
                await fetchTransactions(updatedTracker, true);
              } else {
                // Only currency or other settings changed - just reload from cache
                // Prices are already stored in transactions (ethPriceEUR, ethPriceUSD)
                await loadTransactions(updatedTracker);
              }
            }
          }}
        />
      )}

      {/* Mark as Covered Modal */}
      {markPaidHash && (
        <div
          className={`modal-overlay ${markPaidModalAnimation === "enter" ? "modal-overlay-enter" : "modal-overlay-exit"}`}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(3px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: "20px",
          }}
          onClick={requestMarkPaidModalClose}
        >
          <div
            className={`modal-card ${markPaidModalAnimation === "enter" ? "modal-card-enter" : "modal-card-exit"}`}
            style={{
              width: "100%",
              maxWidth: "520px",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                background: "#181818",
                borderRadius: "18px",
                padding: "1px",
                border: "1px solid #2b2b2b",
              }}
            >
              <div
                style={{
                  background: "#181818",
                  borderRadius: "17px",
                  padding: "28px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                  <h3 style={{ margin: 0, color: "#f0f0f0", fontSize: "1.5rem" }}>Mark as covered?</h3>
                  <button
                    onClick={requestMarkPaidModalClose}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#9aa0b4",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "absolute",
                      top: "10px",
                      right: "10px",
                      transition: "color 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#e8e8f0";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "#9aa0b4";
                    }}
                  >
                    ×
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 0, marginBottom: "8px", color: "#aaaaaa" }}>
                  Swap transaction hash (optional):
                </p>
                <input
                  className="input"
                  placeholder="0x..."
                  value={swapHashInput}
                  onChange={(e) => setSwapHashInput(e.target.value.trim())}
                />
                <div className="actions" style={{ marginTop: "32px" }}>
                  <button
                    onClick={requestMarkPaidModalClose}
                    style={{
                      background: "#2b2b2b",
                      color: "#aaaaaa",
                      padding: "10px 20px",
                      borderRadius: "10px",
                      textTransform: "none",
                      border: "none",
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#383838";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      if (!activeTracker || !markPaidHash || !user) return;
                      
                      // Validate swap hash if provided
                      const swapHash = swapHashInput.trim();
                      if (swapHash && !/^0x[a-fA-F0-9]{6,}$/.test(swapHash)) {
                        alert("Invalid transaction hash format. Please enter a valid Ethereum transaction hash (0x followed by hex characters).");
                        return;
                      }
                      
                      // Update local cache
                      const { updateTransactionStatus } = await import("../utils/transactionCache");
                      await updateTransactionStatus(activeTracker.id, markPaidHash, "✓ Paid", swapHash || undefined);
                      
                      // Update Firestore
                      try {
                        await updateFirestoreTransactionStatus(
                          user.uid,
                          activeTracker.id,
                          markPaidHash,
                          "✓ Paid",
                          swapHash || undefined
                        );
                      } catch (firestoreError) {
                        console.warn("Failed to update Firestore (continuing):", firestoreError);
                      }
                      
                      // Update local state
                      setTransactions((prev) => prev.map((t) => 
                        t.transactionHash === markPaidHash 
                          ? { ...t, status: "✓ Paid", swapHash: swapHash || undefined } as Transaction
                          : t
                      ));
                      requestMarkPaidModalClose();
                      setSwapHashInput("");
                    }}
                    className="pressable-button"
                    style={{
                      background: "#555555",
                      border: "none",
                      borderRadius: "10px",
                      padding: "10px 20px",
                      color: "#f0f0f0",
                      textTransform: "none",
                      fontWeight: 600,
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#666666";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#555555";
                    }}
                  >
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Covered Status Modal */}
      {editPaidHash && (
        <div
          className={`modal-overlay ${editPaidModalAnimation === "enter" ? "modal-overlay-enter" : "modal-overlay-exit"}`}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: "20px",
          }}
          onClick={requestEditPaidModalClose}
        >
          <div
            className={`modal-card ${editPaidModalAnimation === "enter" ? "modal-card-enter" : "modal-card-exit"}`}
            style={{
              width: "100%",
              maxWidth: "520px",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                background: "#181818",
                borderRadius: "18px",
                padding: "1px",
                border: "1px solid #2b2b2b",
              }}
            >
              <div
                style={{
                  background: "#181818",
                  borderRadius: "17px",
                  padding: "28px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                  <h3 style={{ margin: 0, color: "#f0f0f0", fontSize: "1.5rem" }}>Edit covered status</h3>
                  <button
                    onClick={requestEditPaidModalClose}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#9aa0b4",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "absolute",
                      top: "10px",
                      right: "10px",
                      transition: "color 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#e8e8f0";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "#9aa0b4";
                    }}
                  >
                    ×
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 0, marginBottom: "8px", color: "#aaaaaa" }}>
                  Swap transaction hash (optional):
                </p>
                <input
                  className="input"
                  placeholder="0x..."
                  value={editSwapHashInput}
                  onChange={(e) => setEditSwapHashInput(e.target.value.trim())}
                />
                <div className="actions" style={{ marginTop: "32px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                  <button
                    className="pressable-button"
                    style={{
                      background: "#ef4444",
                      color: "white",
                      padding: "10px 20px",
                      borderRadius: "10px",
                      textTransform: "none",
                      border: "none",
                      transition: "background 0.2s",
                    }}
                    onClick={async () => {
                      if (!activeTracker || !editPaidHash || !user) return;
                      
                      // Mark as uncovered
                      const { updateTransactionStatus } = await import("../utils/transactionCache");
                      await updateTransactionStatus(activeTracker.id, editPaidHash, "Unpaid", undefined);
                      
                      // Update Firestore
                      try {
                        await updateFirestoreTransactionStatus(
                          user.uid,
                          activeTracker.id,
                          editPaidHash,
                          "Unpaid",
                          undefined
                        );
                      } catch (firestoreError) {
                        console.warn("Failed to update Firestore (continuing):", firestoreError);
                      }
                      
                      // Update local state
                      setTransactions((prev) => prev.map((t) => 
                        t.transactionHash === editPaidHash 
                          ? { ...t, status: "Unpaid", swapHash: undefined } as Transaction
                          : t
                      ));
                      requestEditPaidModalClose();
                      setEditSwapHashInput("");
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#dc2626";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#ef4444";
                    }}
                  >
                    Mark as uncovered
                  </button>
                  <div style={{ display: "flex", gap: "12px", marginLeft: "auto" }}>
                    <button
                      className="pressable-button"
                      onClick={requestEditPaidModalClose}
                      style={{
                        background: "#2b2b2b",
                        color: "#aaaaaa",
                        padding: "10px 20px",
                        borderRadius: "10px",
                        textTransform: "none",
                        border: "none",
                        transition: "background 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#383838";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#2b2b2b";
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="pressable-button"
                      onClick={async () => {
                      if (!activeTracker || !editPaidHash || !user) return;
                      
                      // Validate swap hash if provided
                      const swapHash = editSwapHashInput.trim();
                      if (swapHash && !/^0x[a-fA-F0-9]{6,}$/.test(swapHash)) {
                        alert("Invalid transaction hash format. Please enter a valid Ethereum transaction hash (0x followed by hex characters).");
                        return;
                      }
                      
                      // Update local cache
                      const { updateTransactionStatus } = await import("../utils/transactionCache");
                      await updateTransactionStatus(activeTracker.id, editPaidHash, "✓ Paid", swapHash || undefined);
                      
                      // Update Firestore
                      try {
                        await updateFirestoreTransactionStatus(
                          user.uid,
                          activeTracker.id,
                          editPaidHash,
                          "✓ Paid",
                          swapHash || undefined
                        );
                      } catch (firestoreError) {
                        console.warn("Failed to update Firestore (continuing):", firestoreError);
                      }
                      
                      // Update local state
                      setTransactions((prev) => prev.map((t) => 
                        t.transactionHash === editPaidHash 
                          ? { ...t, status: "✓ Paid", swapHash: swapHash || undefined } as Transaction
                          : t
                      ));
                        requestEditPaidModalClose();
                        setEditSwapHashInput("");
                      }}
                      style={{
                        background: "#555555",
                        border: "none",
                        borderRadius: "10px",
                        padding: "10px 20px",
                        color: "#f0f0f0",
                        textTransform: "none",
                        fontWeight: 600,
                        transition: "background 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "#666666";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#555555";
                      }}
                    >
                      Update
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Export CSV Modal */}
      {showExportModal && (
        <div
          className={`modal-overlay ${exportModalAnimation === "enter" ? "modal-overlay-enter" : "modal-overlay-exit"}`}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(3px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: "20px",
          }}
          onClick={requestExportModalClose}
        >
          <div
            className={`modal-card ${exportModalAnimation === "enter" ? "modal-card-enter" : "modal-card-exit"}`}
            style={{
              width: "100%",
              maxWidth: "520px",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                background: "#181818",
                borderRadius: "18px",
                padding: "1px",
                border: "1px solid #2b2b2b",
              }}
            >
              <div
                style={{
                  background: "#181818",
                  borderRadius: "17px",
                  padding: "28px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                  <h3 style={{ margin: 0, color: "#f0f0f0", fontSize: "1.5rem" }}>Export staking rewards to CSV?</h3>
                  <button
                    onClick={requestExportModalClose}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#9aa0b4",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "absolute",
                      top: "10px",
                      right: "10px",
                      transition: "color 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#e8e8f0";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "#9aa0b4";
                    }}
                  >
                    ×
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 0, marginBottom: "16px", color: "#aaaaaa" }}>
                  Select the year to export:
                </p>
                <div style={{ marginTop: 16 }}>
                  <select
                    className="gradient-select"
                    value={exportYear}
                    onChange={(e) => setExportYear(parseInt(e.target.value))}
                    style={{
                      width: "100%",
                      paddingRight: "48px",
                    }}
                  >
                    {availableYears.length > 0 ? (
                      availableYears.map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))
                    ) : (
                      <option value={new Date().getFullYear()}>{new Date().getFullYear()}</option>
                    )}
                  </select>
                </div>
                <div className="actions" style={{ marginTop: "32px" }}>
                  <button
                    onClick={requestExportModalClose}
                    style={{
                      background: "#2b2b2b",
                      color: "#aaaaaa",
                      padding: "10px 20px",
                      borderRadius: "10px",
                      textTransform: "none",
                      border: "none",
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#383838";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      exportToCSV(exportYear);
                      requestExportModalClose();
                    }}
                    disabled={availableYears.length === 0}
                    style={{
                      background: "#555555",
                      border: "none",
                      borderRadius: "10px",
                      padding: "10px 20px",
                      color: "#f0f0f0",
                      textTransform: "none",
                      fontWeight: 600,
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      if (!e.currentTarget.disabled) {
                        e.currentTarget.style.background = "#666666";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#555555";
                    }}
                  >
                    Export
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* Mark rewards as sold modal */}
      {showMarkSoldModal && (
        <div
          className="modal-overlay modal-overlay-enter"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(3px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: "20px",
          }}
          onClick={() => setShowMarkSoldModal(false)}
        >
          <div
            className="modal-card modal-card-enter"
            style={{
              width: "100%",
              maxWidth: "520px",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                background: "#181818",
                borderRadius: "18px",
                padding: "1px",
                border: "1px solid #2b2b2b",
              }}
            >
              <div
                style={{
                  background: "#181818",
                  borderRadius: "17px",
                  padding: "28px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                  <h3 style={{ margin: 0, color: "#f0f0f0", fontSize: "1.5rem" }}>Mark rewards as sold?</h3>
                  <button
                    onClick={() => setShowMarkSoldModal(false)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#9aa0b4",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "absolute",
                      top: "10px",
                      right: "10px",
                      transition: "color 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#e8e8f0";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "#9aa0b4";
                    }}
                  >
                    ×
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 0, marginBottom: "16px", color: "#aaaaaa" }}>
                  Which period do you want to apply this to:
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {/* Entire year */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      color: "#e8e8f0",
                      fontSize: "0.9rem",
                    }}
                  >
                    <input
                      type="radio"
                      checked={markSoldMode === "year"}
                      onChange={() => setMarkSoldMode("year")}
                    />
                    <span>Entire year {selectedYear}</span>
                  </label>

                  {/* Custom range */}
                  <label
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      cursor: "pointer",
                      fontSize: "0.9rem",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 10, color: markSoldMode === "custom" ? "#f0f0f0" : "#aaaaaa" }}>
                      <input
                        type="radio"
                        checked={markSoldMode === "custom"}
                        onChange={() => setMarkSoldMode("custom")}
                      />
                      <span>Custom range:</span>
                    </span>
                    <div style={{ display: "flex", gap: 8, marginLeft: 26 }}>
                      <select
                        className="gradient-select"
                        value={markSoldStartMonth}
                        onChange={(e) => setMarkSoldStartMonth(parseInt(e.target.value))}
                        onFocus={() => {
                          if (markSoldMode === "year") {
                            setMarkSoldMode("custom");
                          }
                        }}
                        style={{ color: markSoldMode === "custom" ? "#f0f0f0" : "#aaaaaa", opacity: markSoldMode === "custom" ? 1 : 0.6 }}
                      >
                        {Array.from({ length: 12 }).map((_, idx) => {
                          const name = new Date(2024, idx, 1).toLocaleDateString("en-US", { month: "short" });
                          return (
                            <option key={idx} value={idx}>
                              {name}
                            </option>
                          );
                        })}
                      </select>
                      <span style={{ color: "#aaaaaa", alignSelf: "center" }}>–</span>
                      <select
                        className="gradient-select"
                        value={markSoldEndMonth}
                        onChange={(e) => setMarkSoldEndMonth(parseInt(e.target.value))}
                        onFocus={() => {
                          if (markSoldMode === "year") {
                            setMarkSoldMode("custom");
                          }
                        }}
                        style={{ color: markSoldMode === "custom" ? "#f0f0f0" : "#aaaaaa", opacity: markSoldMode === "custom" ? 1 : 0.6 }}
                      >
                        {Array.from({ length: 12 }).map((_, idx) => {
                          const name = new Date(2024, idx, 1).toLocaleDateString("en-US", { month: "short" });
                          return (
                            <option key={idx} value={idx}>
                              {name}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </label>
                </div>

                <div className="actions" style={{ marginTop: "32px" }}>
                  <button
                    onClick={() => setShowMarkSoldModal(false)}
                    style={{
                      background: "#2b2b2b",
                      color: "#aaaaaa",
                      padding: "10px 20px",
                      borderRadius: "10px",
                      textTransform: "none",
                      border: "none",
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#383838";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (!activeTracker) {
                        setShowMarkSoldModal(false);
                        return;
                      }
                      const updated: Record<string, "Hodling" | "Sold"> = { ...holdingStatusMap };
                      transactions.forEach((tx) => {
                        const txDate = new Date(tx.timestamp * 1000);
                        const year = txDate.getFullYear();
                        const month = txDate.getMonth();
                        if (markSoldMode === "year") {
                          if (year === selectedYear) {
                            updated[tx.transactionHash] = "Sold";
                          }
                        } else {
                          if (year === selectedYear && month >= markSoldStartMonth && month <= markSoldEndMonth) {
                            updated[tx.transactionHash] = "Sold";
                          }
                        }
                      });
                      setHoldingStatusMap(updated);
                      setShowMarkSoldModal(false);
                    }}
                    style={{
                      background: "#555555",
                      border: "none",
                      borderRadius: "10px",
                      padding: "10px 20px",
                      color: "#f0f0f0",
                      textTransform: "none",
                      fontWeight: 600,
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#666666";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#555555";
                    }}
                  >
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

