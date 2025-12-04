import React, { useEffect, useState, useRef } from "react";
import { useTrackerStore, Tracker } from "../store/trackerStore";
import { getTransactions } from "../api/etherscan";
import { getEthPriceAtTimestamp } from "../api/coingecko";
import { getCachedPrice, setCachedPrice, getDateKey } from "../utils/priceCache";
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
} from "../utils/firestoreAdapter";

interface Transaction {
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
  timestamp: number;
  swapHash?: string;
}

interface DashboardProps {
  onAddTracker?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ onAddTracker }) => {
  const { trackers, activeTrackerId, setActiveTracker } = useTrackerStore();
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
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
  const [markSoldYear, setMarkSoldYear] = useState<number>(new Date().getFullYear());
  const [markSoldMode, setMarkSoldMode] = useState<"year" | "custom">("year");
  const [markSoldStartMonth, setMarkSoldStartMonth] = useState<number>(0);
  const [markSoldEndMonth, setMarkSoldEndMonth] = useState<number>(0);
  const [walletCopied, setWalletCopied] = useState(false);

  const activeTracker = trackers.find((t) => t.id === activeTrackerId);
  const glowShadow = "0 0 8px rgba(1, 225, 253, 0.8), 0 0 20px rgba(1, 225, 253, 0.45)";

  useEffect(() => {
    if (activeTracker) {
      loadTransactions(activeTracker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackerId]);

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
    setError(null);

    try {
      // Load cached transactions first (instant display)
      const cached = await getCachedTransactions(tracker.id);
      if (cached.length > 0) {
        setTransactions(cached);
        setLoading(false);
        console.log(`Loaded ${cached.length} cached transactions`);
      }

      // Sync with Firestore if user is authenticated
      if (user) {
        try {
          const metadata = await getCacheMetadata(tracker.id);
          const firestoreTxs = await getFirestoreTransactions(
            user.uid,
            tracker.id,
            metadata?.lastFetchedTimestamp
          );
          
          if (firestoreTxs.length > 0) {
            console.log(`Synced ${firestoreTxs.length} transactions from Firestore`);
            // Merge Firestore data with cached data (Firestore takes precedence for status)
            const cachedMap = new Map(cached.map((t) => [t.transactionHash, t]));
            firestoreTxs.forEach((ftx) => {
              cachedMap.set(ftx.transactionHash, ftx);
            });
            const merged = Array.from(cachedMap.values()).sort((a, b) => b.timestamp - a.timestamp);
            setTransactions(merged);
            await saveTransactions(tracker.id, merged);
          }
        } catch (firestoreError) {
          console.warn("Firestore sync failed (continuing with cache):", firestoreError);
        }
      }

      // Check if we need to fetch new transactions from Etherscan
      const metadata = await getCacheMetadata(tracker.id);
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 24 * 60 * 60;

      // Fetch if:
      // - No cache exists
      // - Cache is older than 1 day
      // - It's after midnight UTC (for daily updates)
      const shouldFetch =
        !metadata ||
        metadata.lastFetchedTimestamp < oneDayAgo ||
        isAfterMidnightUTC(metadata.lastFetchedTimestamp);

      if (shouldFetch) {
        await fetchTransactions(tracker, false);
      } else {
        console.log("Using cached data, no fetch needed");
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

  const fetchTransactions = async (tracker: Tracker, forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      // Always start from Jan 1 of current year (00:01 UTC) to include entire-year history
      const startTimestamp = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1, 0, 1, 0) / 1000);
      
      console.log("Fetching transactions for:", tracker.walletAddress, "from", new Date(startTimestamp * 1000).toLocaleDateString());
      const etherscanTxs = await getTransactions(tracker.walletAddress, tracker.etherscanKey, startTimestamp);
      console.log("Found transactions:", etherscanTxs.length);
      
      if (etherscanTxs.length === 0) {
        setError("No incoming transactions found for this wallet address.");
        setTransactions([]);
        setLoading(false);
        return;
      }
      
      // Process each transaction
      const processedTxs: Transaction[] = [];
      
      for (let i = 0; i < etherscanTxs.length; i++) {
        const tx = etherscanTxs[i];
        const timestamp = parseInt(tx.timeStamp) * 1000;
        const date = new Date(timestamp);
        const ethAmount = parseFloat(tx.value) / 1e18;
        
        // Get ETH price at transaction time (use cache to avoid duplicate API calls)
        let ethPrice = 0;
        const dateKey = getDateKey(parseInt(tx.timeStamp));
        const cachedPrice = getCachedPrice(`${dateKey}-${tracker.currency}`);
        
        if (cachedPrice !== null) {
          ethPrice = cachedPrice;
          console.log(`Transaction ${i + 1}/${etherscanTxs.length}: Using cached price: ${ethPrice}`);
        } else {
          try {
            ethPrice = await getEthPriceAtTimestamp(parseInt(tx.timeStamp), tracker.currency);
            setCachedPrice(`${dateKey}-${tracker.currency}`, ethPrice);
            console.log(`Transaction ${i + 1}/${etherscanTxs.length}: Price fetched: ${ethPrice}`);
            // Small delay to avoid rate limiting (only if not last transaction)
            if (i < etherscanTxs.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1200)); // 1.2s to stay under 5/sec
            }
          } catch (error: any) {
            console.error(`Failed to fetch price for transaction ${i + 1}:`, error);
            setError(`Warning: Could not fetch price for some transactions. ${error.message || ""}`);
            // Continue with 0 price if fetch fails
          }
        }
        
      const rewardsInCurrency = ethAmount * ethPrice;
      const taxesInEth = ethAmount * (tracker.taxRate / 100);
      const taxesInCurrency = rewardsInCurrency * (tracker.taxRate / 100);
      
      processedTxs.push({
        date: date.toLocaleDateString("en-GB", { timeZone: "Europe/Zagreb" }),
        time: date.toLocaleTimeString("en-GB", { timeZone: "Europe/Zagreb", hour12: false }),
        ethAmount,
        ethPrice,
        rewardsInCurrency,
        taxRate: tracker.taxRate,
        taxesInEth,
        taxesInCurrency,
        transactionHash: tx.hash,
        status: "Unpaid", // TODO: Track swap status
        timestamp: parseInt(tx.timeStamp),
      } as CachedTransaction);
    }
    
    // Get existing cached transactions to merge
    const existingCached = await getCachedTransactions(tracker.id);
    const existingHashes = new Set(existingCached.map((t) => t.transactionHash));
    
    // Filter out duplicates
    const newTxs = processedTxs.filter((tx) => !existingHashes.has(tx.transactionHash));
    
    // Merge with existing cache
    const allTransactions = [...existingCached, ...newTxs];
    
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
    } catch (error: any) {
      console.error("Failed to fetch transactions:", error);
      setError(`Failed to fetch transactions: ${error.message || "Unknown error"}. Please check your Etherscan API key and wallet address.`);
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  };

  if (trackers.length === 0) {
    return (
      <div className="card">
        <h2>No trackers yet</h2>
        <p>Create your first node tracker to get started.</p>
      </div>
    );
  }

  // Get available years from transactions
  const availableYears = React.useMemo(() => {
    const years = new Set<number>();
    transactions.forEach((tx) => {
      const year = new Date(tx.timestamp * 1000).getFullYear();
      years.add(year);
    });
    return Array.from(years).sort((a, b) => b - a); // Sort descending
  }, [transactions]);

  // Filter transactions by selected year and month
  const filteredTransactions = React.useMemo(() => {
    return transactions.filter((tx) => {
      const txDate = new Date(tx.timestamp * 1000);
      const txYear = txDate.getFullYear();
      const txMonth = txDate.getMonth(); // 0-11
      
      if (txYear !== selectedYear) return false;
      if (selectedMonth !== null && txMonth !== selectedMonth) return false;
      return true;
    });
  }, [transactions, selectedYear, selectedMonth]);

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

  // Month payment status for the selected year (used for month dots)
  const monthPaymentStatus = React.useMemo(() => {
    const stats: { [month: number]: { total: number; paid: number } } = {};

    transactions.forEach((tx) => {
      const date = new Date(tx.timestamp * 1000);
      const year = date.getFullYear();
      if (year !== selectedYear) return;
      const month = date.getMonth(); // 0-11

      if (!stats[month]) {
        stats[month] = { total: 0, paid: 0 };
      }
      stats[month].total += 1;
      if (tx.status === "✓ Paid") {
        stats[month].paid += 1;
      }
    });

    const statusMap: { [month: number]: "none" | "partial" | "allPaid" } = {};
    for (let m = 0; m < 12; m++) {
      const s = stats[m];
      if (!s || s.total === 0) {
        statusMap[m] = "none";
      } else if (s.paid === s.total) {
        statusMap[m] = "allPaid";
      } else {
        statusMap[m] = "partial";
      }
    }

    return statusMap;
  }, [transactions, selectedYear]);

  // Calculate totals for ALL trackers (for All nodes overview)
  const [allTrackersTotals, setAllTrackersTotals] = React.useState({
    totalRewards: 0,
    totalTaxes: 0,
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
      let allEthRewards = 0;
      let allEthTaxes = 0;
      let allCgtFreeRewards = 0;
      let allCgtFreeEth = 0;

      for (const tracker of trackers) {
        const cached = await getCachedTransactions(tracker.id);
        allRewards += cached.reduce((sum, tx) => sum + tx.rewardsInCurrency, 0);
        allTaxes += cached.reduce((sum, tx) => sum + tx.taxesInCurrency, 0);
        allEthRewards += cached.reduce((sum, tx) => sum + tx.ethAmount, 0);
        allEthTaxes += cached.reduce((sum, tx) => sum + tx.taxesInEth, 0);

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
              allCgtFreeRewards += tx.rewardsInCurrency;
              allCgtFreeEth += tx.ethAmount;
            }
          });
        }
      }

      setAllTrackersTotals({
        totalRewards: allRewards,
        totalTaxes: allTaxes,
        totalEthRewards: allEthRewards,
        totalEthTaxes: allEthTaxes,
        totalCgtFreeRewards: allCgtFreeRewards,
        totalCgtFreeEth: allCgtFreeEth,
      });
    };

    if (trackers.length > 0) {
      calculateAllTotals();
    }
  }, [trackers, transactions, holdingStatusMap]); // Recalculate when trackers, transactions or holding status change

  // Calculate totals based on filtered transactions (for selected node)
  const totalRewards = filteredTransactions.reduce((sum, tx) => sum + tx.rewardsInCurrency, 0);
  const totalTaxes = filteredTransactions.reduce((sum, tx) => sum + tx.taxesInCurrency, 0);
  const totalEthRewards = filteredTransactions.reduce((sum, tx) => sum + tx.ethAmount, 0);
  const totalEthTaxes = filteredTransactions.reduce((sum, tx) => sum + tx.taxesInEth, 0);
  
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
        return nowForCgt >= taxableUntil ? sum + tx.ethAmount : sum;
      }, 0)
    : 0;
  const totalCgtFreeRewards = isCroatia
    ? filteredTransactions.reduce((sum, tx) => {
        const holding = holdingStatusMap[tx.transactionHash] ?? "Hodling";
        if (holding === "Sold") return sum;
        const rewardDate = new Date(tx.timestamp * 1000);
        const taxableUntil = new Date(rewardDate);
        taxableUntil.setFullYear(taxableUntil.getFullYear() + 2);
        return nowForCgt >= taxableUntil ? sum + tx.rewardsInCurrency : sum;
      }, 0)
    : 0;

  // Use active tracker's currency, or default to EUR for All nodes overview
  const currencySymbol = activeTracker?.currency === "EUR" ? "€" : "$";
  const valueLabel = activeTracker?.currency === "EUR" ? "Value in EUR" : "Value in USD";
  const incomeTaxLabel = activeTracker?.currency === "EUR" ? "Income tax (EUR)" : "Income tax (USD)";
  const allNodesCurrencySymbol = trackers.length > 0 && trackers[0].currency === "USD" ? "$" : "€";
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
    
    const currency = activeTracker.currency === "EUR" ? "€" : "$";
    const headers = [
      "Date",
      "Time",
      "ETH Amount",
      `ETH Price (${currency})`,
      `Rewards (${currency})`,
      "Tax Rate (%)",
      "Taxes in ETH",
      `Taxes (${currency})`,
      "Transaction Hash",
      "Status",
      "Swap Hash",
    ];
    const rows = yearTransactions.map((tx) => [
      tx.date,
      tx.time,
      tx.ethAmount.toFixed(6),
      tx.ethPrice.toFixed(2),
      tx.rewardsInCurrency.toFixed(2),
      tx.taxRate.toString(),
      tx.taxesInEth.toFixed(6),
      tx.taxesInCurrency.toFixed(2),
      tx.transactionHash,
      tx.status,
      tx.swapHash || "",
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${c}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeTracker.name || "node").replace(/\s+/g, "_")}_transactions_${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowExportModal(false);
  };

  const [isYearDropdownOpen, setIsYearDropdownOpen] = React.useState(false);

  return (
    <div style={{ width: "100%" }}>
      {/* All Nodes Overview */}
      <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#aaaaaa" }}>All nodes overview</h3>
      <div style={{ background: "#181818", border: "1px solid #2b2b2b", borderRadius: "14px", padding: "24px", marginBottom: "24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
        <div style={{ background: "linear-gradient(45deg, #3088d5, #34f3fc)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)", position: "relative" }}>
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
                  Cumulative staking{'\n'}rewards distributed to{'\n'}all nodes across all{'\n'}years.
                </div>
              </div>
            )}
          </div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>REWARDS RECEIVED</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {allNodesCurrencySymbol} {allTrackersTotals.totalRewards.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {allTrackersTotals.totalEthRewards.toFixed(6)} ETH
          </p>
        </div>
        <div style={{ background: "linear-gradient(45deg, #c18d02, #ffbb45)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)", position: "relative" }}>
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
                  Cumulative taxes at{'\n'}selected country rate{'\n'}across all nodes and years.
                </div>
              </div>
            )}
          </div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>INCOME TAX DUE</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {allNodesCurrencySymbol} {allTrackersTotals.totalTaxes.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {allTrackersTotals.totalEthTaxes.toFixed(6)} ETH
          </p>
        </div>
        <div style={{ background: "linear-gradient(45deg, #0f9d7a, #10dcb6)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)", position: "relative" }}>
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
                  Estimated amount of{'\n'}rewards currently{'\n'}capital‑gains tax free{'\n'}(based on local rules).
                </div>
              </div>
            )}
          </div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>CAPITAL GAINS TAX FREE</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {allTrackersTotals.totalCgtFreeEth.toFixed(6)} ETH
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {allNodesCurrencySymbol} {allTrackersTotals.totalCgtFreeRewards.toFixed(2)}
          </p>
        </div>
        </div>
      </div>

      {/* Your Nodes */}
      <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#aaaaaa" }}>Your nodes</h3>
      <div style={{ background: "#181818", border: "1px solid #2b2b2b", borderRadius: "14px", marginBottom: "24px" }}>
        <div style={{ borderRadius: "13px", padding: "24px" }}>
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
              <span style={{ 
                fontWeight: 600, 
                visibility: "hidden",
                position: "absolute",
                whiteSpace: "nowrap",
                pointerEvents: "none"
              }}>
                {tracker.name || `Node ${tracker.walletAddress.slice(0, 6)}...`}
              </span>
              <span style={{ fontWeight: activeTrackerId === tracker.id ? 600 : 400 }}>
                {tracker.name || `Node ${tracker.walletAddress.slice(0, 6)}...`}
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
              + Add node tracker
            </button>
          )}
          </div>
        </div>
      </div>

      {/* Node Selected + Incoming Rewards combined */}
      {activeTracker && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#aaaaaa" }}>Node selected:</h3>
          <div style={{ background: "#181818", border: "1px solid #2b2b2b", borderRadius: "14px", marginBottom: "24px" }}>
            <div style={{ borderRadius: "13px", padding: "24px" }}>
              {/* Header row: node name, wallet + copy, action buttons */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
                  <h2 style={{ margin: 0, color: "#f0f0f0" }}>
                    {activeTracker.name || `${activeTracker.walletAddress.slice(0, 10)}...`}
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
                    onClick={() => copyToClipboard(activeTracker.walletAddress, "Wallet address")}
                  >
                    <p style={{ margin: 0, fontSize: "0.85rem", color: "#aaaaaa", transition: "color 0.2s" }}>
                      {activeTracker.walletAddress.slice(0, 7)}...{activeTracker.walletAddress.slice(-5)}
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
                      setMarkSoldYear(selectedYear);
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
                    onClick={() => setShowExportModal(true)}
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
                  <button
                    onClick={() => fetchTransactions(activeTracker, true)}
                    disabled={loading}
                    style={{ background: "#2b2b2b", transition: "all 0.2s", border: "none", borderRadius: "9px", padding: "10px 12px", display: "inline-flex", alignItems: "center", gap: 6, textTransform: "none" }}
                    onMouseEnter={(e) => {
                      if (!e.currentTarget.disabled) {
                        e.currentTarget.style.background = "#383838";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#2b2b2b";
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 67.6 67.5" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M0,60c0,2.1,1.7,3.8,3.8,3.8s3.8-1.7,3.8-3.8v-4.7c6.5,7.7,16.1,12.2,26.2,12.2,17,0,31.3-12.6,33.5-29.5.3-2.1-1.1-3.9-3.2-4.2s-3.9,1.1-4.2,3.2v.1c-1.7,13.1-12.8,22.9-26,22.9-8.7,0-16.9-4.2-21.9-11.2h6.8c2.1,0,3.8-1.7,3.8-3.8s-1.7-3.8-3.8-3.8H3.8C1.7,41.2,0,42.9,0,45H0s0,15,0,15Z" fill="#aaaaaa" />
                      <path d="M45,22.5c0,2.1,1.7,3.8,3.8,3.8h15c2.1,0,3.8-1.7,3.8-3.8h0V7.5c0-2.1-1.7-3.8-3.8-3.8s-3.8,1.7-3.8,3.8v4.7C53.5,4.5,43.9,0,33.8,0,16.8,0,2.4,12.7.3,29.5c-.2,2.1,1.3,3.9,3.4,4.1,2,.2,3.8-1.2,4.1-3.2,1.6-13.1,12.8-23,26-23,8.7,0,16.9,4.2,21.9,11.3h-6.9c-2.1.1-3.8,1.8-3.8,3.8h0Z" fill="#aaaaaa" />
                    </svg>
                    <span style={{ color: "#aaaaaa" }}>{loading ? "Loading..." : "Refresh"}</span>
                  </button>
                </div>
              </div>

              {/* Node metadata */}
              <p
                style={{
                  margin: "4px 0 0 0",
                  fontSize: "0.85rem",
                  color: "#aaaaaa",
                }}
              >
                Node location: {activeTracker.country || "—"} - Income tax rate:{" "}
                {typeof activeTracker.taxRate === "number"
                  ? `${activeTracker.taxRate.toFixed(0)}%`
                  : "—"}
              </p>


              {/* Filters row: year dropdown + months bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginTop: "24px", marginBottom: "12px" }}>
                {/* Year dropdown */}
                {availableYears.length > 0 && (
                  <div style={{ position: "relative" }}>
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
                            style={{
                              width: "100%",
                              background: "transparent",
                              color: year === selectedYear ? "#ffffff" : "#aaaaaa",
                              padding: "8px 12px",
                              border: "none",
                              textAlign: "left",
                              cursor: "pointer",
                              fontSize: "0.9rem",
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
                      const dotColor =
                        status === "allPaid"
                          ? "#00c853" // green
                          : status === "partial"
                          ? "#ff5252" // red
                          : "#777777"; // grey
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
                              <span
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: "50%",
                                  background: dotColor,
                                }}
                              />
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

              {/* Totals strip */}
              <div
                style={{
                  background: "#2b2b2b",
                  borderRadius: "10px",
                  padding: "16px 20px",
                  marginBottom: "16px",
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa" }}>Rewards Received</p>
                    <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#32c0ea", textTransform: "none" }}>
                      {currencySymbol}
                      {totalRewards.toFixed(2)}
                    </p>
                    <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#aaaaaa" }}>
                      {totalEthRewards.toFixed(6)} ETH
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa" }}>Income tax due</p>
                    <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#e4a729", textTransform: "none" }}>
                      {currencySymbol}
                      {totalTaxes.toFixed(2)}
                    </p>
                    <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#aaaaaa" }}>
                      {totalEthTaxes.toFixed(6)} ETH
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#aaaaaa" }}>Capital gains tax free</p>
                    <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#55b685", textTransform: "none" }}>
                      {totalCgtFreeEth.toFixed(6)} ETH
                    </p>
                    <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#aaaaaa" }}>
                      {currencySymbol}
                      {totalCgtFreeRewards.toFixed(2)}
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
                  {error}
                </div>
              )}

              {/* Incoming rewards table */}
              {loading ? (
            <p>Loading transactions...</p>
          ) : transactions.length === 0 && !error ? (
            <p>No transactions found.</p>
          ) : filteredTransactions.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid transparent", borderImage: "linear-gradient(45deg, #0c86ab, #2d55ac) 1" }}>
                    <th style={{ padding: "12px", textAlign: "left", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600 }}>Received</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>Reward (ETH)</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>ETH Price</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>{valueLabel}</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>{incomeTaxLabel}</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600 }}>CGT status</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600 }}>Hodling status</th>
                    <th style={{ padding: "12px", textAlign: "center", color: "#aaaaaa", fontSize: "0.85rem", fontWeight: 600 }}>Reward Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {transactionsByMonth.map((monthGroup) => (
                    <React.Fragment key={monthGroup.monthKey}>
                      {/* Month separator row */}
                      <tr style={{ borderBottom: "1px solid transparent", borderImage: "linear-gradient(45deg, #0c86ab, #2d55ac) 1" }}>
                      <td 
                          colSpan={8} 
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
                            <td colSpan={8} style={{ padding: 0, height: "1px" }}>
                              <div style={{ height: "1px", background: "#383838" }}></div>
                            </td>
                          </tr>
                          <tr>
                      <td style={{ padding: "12px", color: "#aaaaaa", textAlign: "left" }}>{tx.date}, {tx.time}</td>
                      <td style={{ padding: "12px", color: "#32c0ea", textAlign: "center" }}>{tx.ethAmount.toFixed(6)}</td>
                      <td style={{ padding: "12px", color: "#aaaaaa", whiteSpace: "nowrap", textAlign: "center" }}>{currencySymbol} {tx.ethPrice.toFixed(2)}</td>
                      <td style={{ padding: "12px", color: "#32c0ea", textAlign: "center" }}>{currencySymbol} {tx.rewardsInCurrency.toFixed(2)}</td>
                      <td style={{ padding: "12px", color: "#e4a729", whiteSpace: "nowrap", textAlign: "center" }}>{currencySymbol} {tx.taxesInCurrency.toFixed(2)}</td>
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
                          const dateLabel = taxableUntil.toLocaleDateString("en-GB");
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
                                      <span style={{ fontSize: "0.85rem", color: "#aaaaaa" }}>Taxable until</span>
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

      {/* Settings Modal */}
      {showSettings && activeTracker && (
        <TrackerSettingsModal
          tracker={activeTracker}
          onClose={() => setShowSettings(false)}
          onSaved={() => loadTransactions(activeTracker)}
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
                  <h3 style={{ margin: 0, color: "#f0f0f0", fontSize: "1.5rem" }}>Export CSV?</h3>
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
                  Select the year you wish to export transactions for:
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
                    <span>Entire year</span>
                    <select
                      className="gradient-select"
                      value={markSoldYear}
                      onChange={(e) => setMarkSoldYear(parseInt(e.target.value))}
                      style={{ marginLeft: 4, minWidth: 80 }}
                    >
                      {availableYears.length > 0
                        ? availableYears.map((year) => (
                            <option key={year} value={year}>
                              {year}
                            </option>
                          ))
                        : (
                          <option value={new Date().getFullYear()}>{new Date().getFullYear()}</option>
                        )}
                    </select>
                  </label>

                  {/* Custom range */}
                  <label
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      cursor: "pointer",
                      color: "#e8e8f0",
                      fontSize: "0.9rem",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
                        disabled={markSoldMode !== "custom"}
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
                        disabled={markSoldMode !== "custom"}
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
                          if (year === markSoldYear) {
                            updated[tx.transactionHash] = "Sold";
                          }
                        } else {
                          if (year === markSoldYear && month >= markSoldStartMonth && month <= markSoldEndMonth) {
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

