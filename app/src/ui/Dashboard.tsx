import React, { useEffect, useState } from "react";
import { useTrackerStore, Tracker } from "../store/trackerStore";
import { getTransactions } from "../api/etherscan";
import { getEthPriceAtTimestamp } from "../api/coingecko";

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
}

export const Dashboard: React.FC = () => {
  const { trackers, activeTrackerId, setActiveTracker } = useTrackerStore();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeTracker = trackers.find((t) => t.id === activeTrackerId);

  useEffect(() => {
    if (activeTracker) {
      fetchTransactions(activeTracker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackerId]);

  const fetchTransactions = async (tracker: Tracker) => {
    setLoading(true);
    setError(null);
    try {
      console.log("Fetching transactions for:", tracker.walletAddress);
      const etherscanTxs = await getTransactions(tracker.walletAddress, tracker.etherscanKey);
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
        
        // Get ETH price at transaction time
        let ethPrice = 0;
        try {
          ethPrice = await getEthPriceAtTimestamp(parseInt(tx.timeStamp), tracker.currency);
          console.log(`Transaction ${i + 1}/${etherscanTxs.length}: Price fetched: ${ethPrice}`);
          // Small delay to avoid rate limiting (only if not last transaction)
          if (i < etherscanTxs.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (error: any) {
          console.error(`Failed to fetch price for transaction ${i + 1}:`, error);
          setError(`Warning: Could not fetch price for some transactions. ${error.message || ""}`);
          // Continue with 0 price if fetch fails
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
        });
      }
      
      // Sort by timestamp (newest first)
      processedTxs.sort((a, b) => {
        // Parse dates in DD/MM/YYYY format
        const [dayA, monthA, yearA] = a.date.split("/");
        const [dayB, monthB, yearB] = b.date.split("/");
        const dateA = new Date(`${yearA}-${monthA}-${dayA} ${a.time}`);
        const dateB = new Date(`${yearB}-${monthB}-${dayB} ${b.time}`);
        return dateB.getTime() - dateA.getTime();
      });
      
      console.log("Processed transactions:", processedTxs.length);
      setTransactions(processedTxs);
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
      <div style={{ display: "flex", gap: "12px", marginBottom: "24px", flexWrap: "wrap" }}>
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
      </div>

      {/* Selected Node Details */}
      {activeTracker && (
        <div className="card" style={{ width: "auto", maxWidth: "none" }}>
          <h2 style={{ margin: "0 0 16px 0" }}>Node: {activeTracker.name || activeTracker.walletAddress.slice(0, 10)}...</h2>
          
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
                        <span style={{ 
                          background: tx.status === "✓ Swapped" ? "#10b981" : "#ef4444", 
                          color: "white", 
                          padding: "4px 8px", 
                          borderRadius: "6px", 
                          fontSize: "0.85rem" 
                        }}>
                          {tx.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

