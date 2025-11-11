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
}

interface DashboardProps {
  onAddTracker?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ onAddTracker }) => {
  const { trackers, activeTrackerId, setActiveTracker } = useTrackerStore();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [markPaidHash, setMarkPaidHash] = useState<string | null>(null);
  const [swapHashInput, setSwapHashInput] = useState<string>("");

  const activeTracker = trackers.find((t) => t.id === activeTrackerId);

  useEffect(() => {
    if (activeTracker) {
      loadTransactions(activeTracker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackerId]);

  // Load transactions: first from cache, then fetch new ones if needed
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

      // Check if we need to fetch new transactions
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

  const totalRewards = transactions.reduce((sum, tx) => sum + tx.rewardsInCurrency, 0);
  const totalTaxes = transactions.reduce((sum, tx) => sum + tx.taxesInCurrency, 0);
  const totalEthRewards = transactions.reduce((sum, tx) => sum + tx.ethAmount, 0);
  const totalEthTaxes = transactions.reduce((sum, tx) => sum + tx.taxesInEth, 0);

  const currencySymbol = activeTracker?.currency === "EUR" ? "€" : "$";
  const activeIndex = trackers.findIndex((t) => t.id === activeTrackerId);

  // CSV Export
  const exportToCSV = () => {
    if (!activeTracker || transactions.length === 0) return;
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
    ];
    const rows = transactions.map((tx) => [
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
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${c}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeTracker.name || "node").replace(/\s+/g, "_")}_transactions.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ width: "100%" }}>
      {/* Global Summary Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <div className="card" style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", width: "auto", maxWidth: "none" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL REWARDS</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} {totalRewards.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {totalEthRewards.toFixed(6)} ETH
          </p>
        </div>
        <div className="card" style={{ background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)", width: "auto", maxWidth: "none" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL TAXES</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} {totalTaxes.toFixed(2)}
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            {totalEthTaxes.toFixed(6)} ETH
          </p>
        </div>
        <div className="card" style={{ background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)", width: "auto", maxWidth: "none" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL LEFT TO SWAP</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} 0.00
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            0.000000 ETH
          </p>
        </div>
        <div className="card" style={{ background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)", width: "auto", maxWidth: "none" }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "0.9rem", color: "rgba(255,255,255,0.9)" }}>TOTAL SWAPPED</h3>
          <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "white" }}>
            {currencySymbol} 0.00
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "rgba(255,255,255,0.8)" }}>
            0.000000 ETH
          </p>
        </div>
      </div>

      {/* Node Selection */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "24px", flexWrap: "wrap", alignItems: "center" }}>
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

      {/* Selected Node Details */}
      {activeTracker && (
        <div className="card" style={{ width: "auto", maxWidth: "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#9aa0b4" }}>
                {activeIndex >= 0 ? `Node ${activeIndex + 1}:` : "Node"}
              </p>
              <h2 style={{ margin: "2px 0 4px 0" }}>
                {activeTracker.name || `${activeTracker.walletAddress.slice(0, 10)}...`}
              </h2>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#9aa0b4" }}>{activeTracker.walletAddress}</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setShowSettings(true)}
                style={{ background: "#2a2a44", padding: "10px 12px" }}
                title="Settings"
              >
                ⚙️
              </button>
              <button
                onClick={exportToCSV}
                disabled={transactions.length === 0}
                style={{ background: "#2a2a44" }}
                title="Export CSV"
              >
                📥 Export CSV
              </button>
              <button 
                onClick={() => fetchTransactions(activeTracker, true)}
                disabled={loading}
                style={{ background: "#2a2a44" }}
              >
                {loading ? "Loading..." : "🔄 Refresh"}
              </button>
            </div>
          </div>
          
          {/* Node Summary */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "16px", marginBottom: "24px" }}>
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
                {currencySymbol}0.00
              </p>
              <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#9aa0b4" }}>
                0.000000 ETH
              </p>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div style={{ 
              padding: "12px", 
              background: "#2a1a1a", 
              border: "1px solid #ff4444", 
              borderRadius: "8px", 
              marginBottom: "16px", 
              color: "#ff8888" 
            }}>
              {error}
            </div>
          )}

          {/* Transaction Table */}
          {loading ? (
            <p>Loading transactions...</p>
          ) : transactions.length === 0 && !error ? (
            <p>No transactions found.</p>
          ) : transactions.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #232342" }}>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Date, Time</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>ETH Rewards</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>ETH Price</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Rewards in {activeTracker.currency}</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Tax Rate</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Taxes in ETH</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Taxes in {activeTracker.currency}</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Transaction Hash</th>
                    <th style={{ padding: "12px", textAlign: "left", color: "#9aa0b4", fontSize: "0.85rem", fontWeight: 600 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #232342" }}>
                      <td style={{ padding: "12px", color: "#e8e8f0" }}>{tx.date}, {tx.time}</td>
                      <td style={{ padding: "12px", color: "#10b981" }}>{tx.ethAmount.toFixed(6)}</td>
                      <td style={{ padding: "12px", color: "#e8e8f0" }}>{currencySymbol} {tx.ethPrice.toFixed(2)}</td>
                      <td style={{ padding: "12px", color: "#10b981" }}>{currencySymbol} {tx.rewardsInCurrency.toFixed(2)}</td>
                      <td style={{ padding: "12px", color: "#e8e8f0" }}>{tx.taxRate}%</td>
                      <td style={{ padding: "12px", color: "#f59e0b" }}>{tx.taxesInEth.toFixed(6)}</td>
                      <td style={{ padding: "12px", color: "#f59e0b" }}>{currencySymbol} {tx.taxesInCurrency.toFixed(2)}</td>
                      <td style={{ padding: "12px" }}>
                        <a
                          href={`https://etherscan.io/tx/${tx.transactionHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#6b6bff", textDecoration: "none" }}
                        >
                          {tx.transactionHash.slice(0, 6)}...{tx.transactionHash.slice(-4)}
                        </a>
                      </td>
                      <td style={{ padding: "12px" }}>
                        {tx.status === "Paid" ? (
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
                            ✓ Paid
                          </span>
                        ) : (
                          <button
                            onClick={() => { setMarkPaidHash(tx.transactionHash); setSwapHashInput(""); }}
                            style={{ background: "#2a2a44", color: "white", padding: "6px 10px", border: 0, borderRadius: 8, cursor: "pointer" }}
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
            <p className="muted" style={{ marginTop: 0 }}>Enter the transaction hash of the swap you performed for this reward.</p>
            <input
              className="input"
              placeholder="Swap transaction hash (0x...)"
              value={swapHashInput}
              onChange={(e) => setSwapHashInput(e.target.value.trim())}
            />
            <div className="actions" style={{ marginTop: 16 }}>
              <button style={{ background: "#2a2a44" }} onClick={() => setMarkPaidHash(null)}>Cancel</button>
              <button
                onClick={async () => {
                  if (!activeTracker || !markPaidHash) return;
                  // Persist status in cache
                  const { updateTransactionStatus } = await import("../utils/transactionCache");
                  await updateTransactionStatus(activeTracker.id, markPaidHash, "Paid", swapHashInput || undefined);
                  // Update local state
                  setTransactions((prev) => prev.map((t) => t.transactionHash === markPaidHash ? { ...t, status: "Paid" } : t));
                  setMarkPaidHash(null);
                }}
                disabled={!/^0x[a-fA-F0-9]{6,}$/.test(swapHashInput)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

