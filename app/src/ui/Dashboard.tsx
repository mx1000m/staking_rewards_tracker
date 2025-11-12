import React, { useEffect, useState } from "react";
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
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportYear, setExportYear] = useState<number>(new Date().getFullYear());

  const activeTracker = trackers.find((t) => t.id === activeTrackerId);

  useEffect(() => {
    if (activeTracker) {
      loadTransactions(activeTracker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackerId]);

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

  // Filter transactions by selected year
  const filteredTransactions = React.useMemo(() => {
    return transactions.filter((tx) => {
      const txYear = new Date(tx.timestamp * 1000).getFullYear();
      return txYear === selectedYear;
    });
  }, [transactions, selectedYear]);

  // Calculate totals based on filtered transactions
  const totalRewards = filteredTransactions.reduce((sum, tx) => sum + tx.rewardsInCurrency, 0);
  const totalTaxes = filteredTransactions.reduce((sum, tx) => sum + tx.taxesInCurrency, 0);
  const totalEthRewards = filteredTransactions.reduce((sum, tx) => sum + tx.ethAmount, 0);
  const totalEthTaxes = filteredTransactions.reduce((sum, tx) => sum + tx.taxesInEth, 0);
  
  // Calculate total swapped (paid transactions) - in taxes amount
  const totalSwapped = filteredTransactions
    .filter((tx) => tx.status === "✓ Paid")
    .reduce((sum, tx) => sum + tx.taxesInCurrency, 0);
  const totalEthSwapped = filteredTransactions
    .filter((tx) => tx.status === "✓ Paid")
    .reduce((sum, tx) => sum + tx.taxesInEth, 0);
  
  // Calculate total left to swap (total taxes - total swapped)
  const totalLeftToSwap = totalTaxes - totalSwapped;
  const totalEthLeftToSwap = totalEthTaxes - totalEthSwapped;

  const currencySymbol = activeTracker?.currency === "EUR" ? "€" : "$";
  const activeIndex = trackers.findIndex((t) => t.id === activeTrackerId);

  // Copy to clipboard function
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // You could add a toast notification here
      console.log(`${label} copied to clipboard`);
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

  return (
    <div style={{ width: "100%" }}>
      {/* All Nodes Overview */}
      <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#8a8ea1" }}>All nodes overview</h3>
      <div className="card" style={{ width: "auto", maxWidth: "none", marginBottom: "24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
        <div style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL REWARDS</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} {totalRewards.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {totalEthRewards.toFixed(6)} ETH
          </p>
        </div>
        <div style={{ background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL TAXES</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} {totalTaxes.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {totalEthTaxes.toFixed(6)} ETH
          </p>
        </div>
        <div style={{ background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL LEFT TO SWAP</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} {totalLeftToSwap.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {totalEthLeftToSwap.toFixed(6)} ETH
          </p>
        </div>
        <div style={{ background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)", padding: "20px", borderRadius: "14px", boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL SWAPPED</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} {totalSwapped.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {totalEthSwapped.toFixed(6)} ETH
          </p>
        </div>
        </div>
      </div>

      {/* Your Nodes */}
      <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#8a8ea1" }}>Your nodes</h3>
      <div className="card" style={{ width: "auto", maxWidth: "none", marginBottom: "24px" }}>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
        {trackers.map((tracker) => (
          <button
            key={tracker.id}
            onClick={() => setActiveTracker(tracker.id)}
            style={{
              background: activeTrackerId === tracker.id ? "#6b6bff" : "#2a2a44",
              padding: "12px 20px",
              border: "none",
              borderRadius: "10px",
              color: "white",
              cursor: "pointer",
              fontWeight: activeTrackerId === tracker.id ? 600 : 400,
            }}
          >
            {tracker.name || `Node ${tracker.walletAddress.slice(0, 6)}...`}
          </button>
        ))}
        {onAddTracker && (
          <button
            onClick={onAddTracker}
            style={{
              background: "#6b6bff",
              padding: "12px 20px",
              border: "none",
              borderRadius: "10px",
              color: "white",
              cursor: "pointer",
              fontWeight: 400,
            }}
          >
            + Add Node Tracker
          </button>
        )}
        </div>
      </div>

      {/* Node Selected */}
      {activeTracker && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#8a8ea1" }}>Node selected</h3>
          <div className="card" style={{ width: "auto", maxWidth: "none", marginBottom: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h2 style={{ margin: "0 0 4px 0" }}>
                {activeTracker.name || `${activeTracker.walletAddress.slice(0, 10)}...`}
              </h2>
              <div 
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                onMouseEnter={(e) => {
                  const p = e.currentTarget.querySelector("p");
                  const img = e.currentTarget.querySelector("img");
                  if (p) p.style.color = "#6a6bf6";
                  if (img) img.style.filter = "brightness(0) saturate(100%) invert(47%) sepia(96%) saturate(1234%) hue-rotate(228deg) brightness(102%) contrast(101%)";
                }}
                onMouseLeave={(e) => {
                  const p = e.currentTarget.querySelector("p");
                  const img = e.currentTarget.querySelector("img");
                  if (p) p.style.color = "#9aa0b4";
                  if (img) img.style.filter = "brightness(0) invert(1)";
                }}
                onClick={() => copyToClipboard(activeTracker.walletAddress, "Wallet address")}
              >
                <p style={{ margin: 0, fontSize: "0.85rem", color: "#9aa0b4", transition: "color 0.2s" }}>{activeTracker.walletAddress}</p>
                <img 
                  src="/staking_rewards_tracker/icons/copy_icon.svg" 
                  alt="Copy" 
                  style={{ width: "16px", height: "16px", filter: "brightness(0) invert(1)", transition: "filter 0.2s", border: "none" }}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setShowSettings(true)}
                style={{ background: "#2a2a44", padding: "10px 12px", transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6 }}
                title="Settings"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "#3a3a54";
                  e.currentTarget.style.transform = "scale(1.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "#2a2a44";
                  e.currentTarget.style.transform = "scale(1)";
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = "scale(0.95)";
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = "scale(1.05)";
                }}
              >
                <img 
                  src="/staking_rewards_tracker/icons/gear_icon.svg" 
                  alt="Settings" 
                  style={{ width: "18px", height: "18px", filter: "brightness(0) invert(1)" }}
                />
                Edit
              </button>
              <button
                onClick={() => setShowExportModal(true)}
                disabled={transactions.length === 0}
                style={{ background: "#2a2a44", transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 6 }}
                title="Export CSV"
                onMouseEnter={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.background = "#3a3a54";
                    e.currentTarget.style.transform = "scale(1.05)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "#2a2a44";
                  e.currentTarget.style.transform = "scale(1)";
                }}
                onMouseDown={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.transform = "scale(0.95)";
                  }
                }}
                onMouseUp={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.transform = "scale(1.05)";
                  }
                }}
              >
                <img 
                  src="/staking_rewards_tracker/icons/export_icon.svg" 
                  alt="Export" 
                  style={{ width: "18px", height: "18px", filter: "brightness(0) invert(1)" }}
                />
                Export CSV
              </button>
              <button 
                onClick={() => fetchTransactions(activeTracker, true)}
                disabled={loading}
                style={{ background: "#2a2a44", transition: "all 0.2s" }}
                onMouseEnter={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.background = "#3a3a54";
                    e.currentTarget.style.transform = "scale(1.05)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "#2a2a44";
                  e.currentTarget.style.transform = "scale(1)";
                }}
                onMouseDown={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.transform = "scale(0.95)";
                  }
                }}
                onMouseUp={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.transform = "scale(1.05)";
                  }
                }}
              >
                {loading ? "Loading..." : "🔄 Refresh"}
              </button>
            </div>
          </div>
          </div>
        </>
      )}

      {/* Fiscal Year */}
      {activeTracker && availableYears.length > 0 && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#8a8ea1" }}>Fiscal year</h3>
          <div className="card" style={{ width: "auto", maxWidth: "none", marginBottom: "24px" }}>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {availableYears.map((year) => (
                <button
                  key={year}
                  onClick={() => setSelectedYear(year)}
                  style={{
                    background: selectedYear === year ? "#6b6bff" : "#2a2a44",
                    color: "white",
                    padding: "8px 16px",
                    border: "none",
                    borderRadius: "20px",
                    cursor: "pointer",
                    fontSize: "0.9rem",
                    fontWeight: selectedYear === year ? 600 : 400,
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    if (selectedYear !== year) {
                      e.currentTarget.style.background = "#3a3a54";
                      e.currentTarget.style.transform = "scale(1.05)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedYear !== year) {
                      e.currentTarget.style.background = "#2a2a44";
                      e.currentTarget.style.transform = "scale(1)";
                    }
                  }}
                  onMouseDown={(e) => {
                    e.currentTarget.style.transform = "scale(0.95)";
                  }}
                  onMouseUp={(e) => {
                    e.currentTarget.style.transform = selectedYear === year ? "scale(1)" : "scale(1.05)";
                  }}
                >
                {year}
              </button>
            ))}
            </div>
          </div>
        </>
      )}

      {/* Node Overview */}
      {activeTracker && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#8a8ea1" }}>Node overview</h3>
          <div className="card" style={{ width: "auto", maxWidth: "none", marginBottom: "24px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "16px" }}>
            <div>
              <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#9aa0b4" }}>Total Rewards</p>
              <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#10b981" }}>
                {currencySymbol}{totalRewards.toFixed(2)}
              </p>
              <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#9aa0b4" }}>
                {totalEthRewards.toFixed(6)} ETH
              </p>
            </div>
            <div>
              <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#9aa0b4" }}>Total Taxes</p>
              <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#f59e0b" }}>
                {currencySymbol}{totalTaxes.toFixed(2)}
              </p>
              <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#9aa0b4" }}>
                {totalEthTaxes.toFixed(6)} ETH
              </p>
            </div>
            <div>
              <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#9aa0b4" }}>Total Left To Swap</p>
              <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#ef4444" }}>
                {currencySymbol}{totalLeftToSwap.toFixed(2)}
              </p>
              <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#9aa0b4" }}>
                {totalEthLeftToSwap.toFixed(6)} ETH
              </p>
            </div>
            <div>
              <p style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#9aa0b4" }}>Total Swapped</p>
              <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600, color: "#3b82f6" }}>
                {currencySymbol}{totalSwapped.toFixed(2)}
              </p>
              <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#9aa0b4" }}>
                {totalEthSwapped.toFixed(6)} ETH
              </p>
            </div>
          </div>
          </div>
        </>
      )}

      {/* Error Message */}
      {activeTracker && error && (
        <div className="card" style={{ width: "auto", maxWidth: "none", marginBottom: "24px" }}>
          <div style={{ 
            padding: "12px", 
            background: "#2a1a1a", 
            border: "1px solid #ff4444", 
            borderRadius: "8px", 
            color: "#ff8888" 
          }}>
            {error}
          </div>
        </div>
      )}

      {/* Incoming Rewards */}
      {activeTracker && (
        <>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", fontWeight: 500, color: "#8a8ea1" }}>Incoming rewards</h3>
          <div className="card" style={{ width: "auto", maxWidth: "none" }}>
          {loading ? (
            <p>Loading transactions...</p>
          ) : transactions.length === 0 && !error ? (
            <p>No transactions found.</p>
          ) : filteredTransactions.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #232342" }}>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Date, Time</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>ETH Rewards</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>ETH Price</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Rewards in {activeTracker.currency}</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Tax Rate</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Taxes in ETH</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}>Taxes in {activeTracker.currency}</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Transaction Hash</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransactions.map((tx, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #232342" }}>
                      <td style={{ padding: "12px", color: "#e8e8f0" }}>{tx.date}, {tx.time}</td>
                      <td style={{ padding: "12px", color: "#10b981" }}>{tx.ethAmount.toFixed(6)}</td>
                      <td style={{ padding: "12px", color: "#e8e8f0", whiteSpace: "nowrap" }}>{currencySymbol} {tx.ethPrice.toFixed(2)}</td>
                      <td style={{ padding: "12px", color: "#10b981" }}>{currencySymbol} {tx.rewardsInCurrency.toFixed(2)}</td>
                      <td style={{ padding: "12px", color: "#e8e8f0" }}>{tx.taxRate}%</td>
                      <td style={{ padding: "12px", color: "#f59e0b" }}>{tx.taxesInEth.toFixed(6)}</td>
                      <td style={{ padding: "12px", color: "#f59e0b", whiteSpace: "nowrap" }}>{currencySymbol} {tx.taxesInCurrency.toFixed(2)}</td>
                      <td style={{ padding: "12px" }}>
                        <div 
                          style={{ display: "flex", alignItems: "center", gap: 6 }}
                          onMouseEnter={(e) => {
                            const links = e.currentTarget.querySelectorAll("a");
                            links.forEach(link => {
                              link.style.color = "#8a8eff";
                              link.style.textDecoration = "underline";
                            });
                            const img = e.currentTarget.querySelector("img");
                            if (img) img.style.filter = "brightness(0) saturate(100%) invert(60%) sepia(96%) saturate(1234%) hue-rotate(228deg) brightness(120%) contrast(101%)";
                          }}
                          onMouseLeave={(e) => {
                            const links = e.currentTarget.querySelectorAll("a");
                            links.forEach(link => {
                              link.style.color = "#6b6bff";
                              link.style.textDecoration = "none";
                            });
                            const img = e.currentTarget.querySelector("img");
                            if (img) img.style.filter = "brightness(0) saturate(100%) invert(47%) sepia(96%) saturate(1234%) hue-rotate(228deg) brightness(102%) contrast(101%)";
                          }}
                        >
                          <a
                            href={`https://etherscan.io/tx/${tx.transactionHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#6b6bff", textDecoration: "none", transition: "all 0.2s" }}
                          >
                            {tx.transactionHash.slice(0, 6)}...{tx.transactionHash.slice(-4)}
                          </a>
                          <a
                            href={`https://etherscan.io/tx/${tx.transactionHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ 
                              color: "#6b6bff", 
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
                              style={{ width: "16px", height: "16px", filter: "brightness(0) saturate(100%) invert(47%) sepia(96%) saturate(1234%) hue-rotate(228deg) brightness(102%) contrast(101%)", transition: "filter 0.2s" }}
                            />
                          </a>
                        </div>
                      </td>
                      <td style={{ padding: "12px" }}>
                        {tx.status === "✓ Paid" ? (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span style={{ 
                              background: "#10b981", 
                              color: "white", 
                              padding: "4px 8px", 
                              borderRadius: "6px", 
                              fontSize: "0.85rem",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                            }}>
                              ✓ Paid{tx.swapHash ? ` + ${tx.swapHash.slice(0, 6)}...${tx.swapHash.slice(-4)}` : ""}
                            </span>
                            <button
                              onClick={() => {
                                setEditPaidHash(tx.transactionHash);
                                setEditSwapHashInput(tx.swapHash || "");
                              }}
                              style={{
                                background: "transparent",
                                border: "1px solid #10b981",
                                color: "#10b981",
                                padding: "4px 8px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                transition: "all 0.2s",
                              }}
                              title="Edit paid status"
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "#10b981";
                                e.currentTarget.style.color = "white";
                                e.currentTarget.style.transform = "scale(1.05)";
                                const img = e.currentTarget.querySelector("img");
                                if (img) {
                                  img.style.filter = "brightness(0) invert(1)";
                                }
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "transparent";
                                e.currentTarget.style.color = "#10b981";
                                e.currentTarget.style.transform = "scale(1)";
                                const img = e.currentTarget.querySelector("img");
                                if (img) {
                                  img.style.filter = "brightness(0) saturate(100%) invert(60%) sepia(95%) saturate(500%) hue-rotate(120deg) brightness(95%) contrast(90%)";
                                }
                              }}
                              onMouseDown={(e) => {
                                e.currentTarget.style.transform = "scale(0.95)";
                              }}
                              onMouseUp={(e) => {
                                e.currentTarget.style.transform = "scale(1.05)";
                              }}
                            >
                              <img 
                                src="/staking_rewards_tracker/icons/edit_icon.svg" 
                                alt="Edit" 
                                style={{ width: "14px", height: "14px", filter: "brightness(0) saturate(100%) invert(60%) sepia(95%) saturate(500%) hue-rotate(120deg) brightness(95%) contrast(90%)" }}
                              />
                              Edit
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setMarkPaidHash(tx.transactionHash); setSwapHashInput(""); }}
                            style={{ 
                              background: "#2a2a44", 
                              color: "white", 
                              padding: "6px 10px", 
                              border: 0, 
                              borderRadius: 8, 
                              cursor: "pointer",
                              transition: "all 0.2s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "#3a3a54";
                              e.currentTarget.style.transform = "scale(1.05)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "#2a2a44";
                              e.currentTarget.style.transform = "scale(1)";
                            }}
                            onMouseDown={(e) => {
                              e.currentTarget.style.transform = "scale(0.95)";
                            }}
                            onMouseUp={(e) => {
                              e.currentTarget.style.transform = "scale(1.05)";
                            }}
                          >
                            Mark as Paid
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          </div>
        </>
      )}

      {/* Settings Modal */}
      {showSettings && activeTracker && (
        <TrackerSettingsModal
          tracker={activeTracker}
          onClose={() => setShowSettings(false)}
          onSaved={() => loadTransactions(activeTracker)}
        />
      )}

      {/* Mark as Paid Modal */}
      {markPaidHash && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: 20,
          }}
          onClick={() => setMarkPaidHash(null)}
        >
          <div className="card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Mark as Paid</h3>
            <p className="muted" style={{ marginTop: 0 }}>Enter the transaction hash of the swap (optional).</p>
            <input
              className="input"
              placeholder="Swap transaction hash (optional, 0x...)"
              value={swapHashInput}
              onChange={(e) => setSwapHashInput(e.target.value.trim())}
            />
            <div className="actions" style={{ marginTop: 16 }}>
              <button style={{ background: "#2a2a44" }} onClick={() => setMarkPaidHash(null)}>Cancel</button>
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
                  setMarkPaidHash(null);
                  setSwapHashInput("");
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Paid Status Modal */}
      {editPaidHash && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: 20,
          }}
          onClick={() => setEditPaidHash(null)}
        >
          <div className="card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Edit Paid Status</h3>
            <p className="muted" style={{ marginTop: 0 }}>Update the swap transaction hash or mark as unpaid.</p>
            <input
              className="input"
              placeholder="Swap transaction hash (optional, 0x...)"
              value={editSwapHashInput}
              onChange={(e) => setEditSwapHashInput(e.target.value.trim())}
            />
            <div className="actions" style={{ marginTop: 16 }}>
              <button style={{ background: "#2a2a44" }} onClick={() => setEditPaidHash(null)}>Cancel</button>
              <button
                style={{ background: "#ef4444" }}
                onClick={async () => {
                  if (!activeTracker || !editPaidHash || !user) return;
                  
                  // Mark as unpaid
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
                  setEditPaidHash(null);
                  setEditSwapHashInput("");
                }}
              >
                Mark as Unpaid
              </button>
              <button
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
                  setEditPaidHash(null);
                  setEditSwapHashInput("");
                }}
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export CSV Modal */}
      {showExportModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
            padding: 20,
          }}
          onClick={() => setShowExportModal(false)}
        >
          <div className="card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Export CSV</h3>
            <p className="muted" style={{ marginTop: 0 }}>Select the year to export transactions for.</p>
            <div style={{ marginTop: 16 }}>
              <label style={{ display: "block", marginBottom: "8px", color: "#e8e8f0", fontSize: "0.9rem" }}>
                Year
              </label>
              <select
                value={exportYear}
                onChange={(e) => setExportYear(parseInt(e.target.value))}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  background: "#0e0e1a",
                  border: "1px solid #1a1a2e",
                  borderRadius: "10px",
                  color: "#e8e8f0",
                  fontSize: "1rem",
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
            <div className="actions" style={{ marginTop: 16 }}>
              <button style={{ background: "#2a2a44" }} onClick={() => setShowExportModal(false)}>
                Cancel
              </button>
              <button
                onClick={() => exportToCSV(exportYear)}
                disabled={availableYears.length === 0}
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

