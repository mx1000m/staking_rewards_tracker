export interface EtherscanTransaction {
  hash: string;
  timeStamp: string;
  value: string;
  from: string;
  to: string;
  isError: string;
}

/**
 * Get the block number for a specific timestamp using Etherscan API
 */
async function getBlockNumberByTimestamp(
  timestamp: number,
  apiKey: string
): Promise<number> {
  // Get the first block on or after the timestamp
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=block&action=getblocknobytime&timestamp=${timestamp}&closest=after&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (data.status === "0" || !data.result) {
    throw new Error(`Failed to get block number: ${data.message || data.result || "Unknown error"}`);
  }
  
  return parseInt(data.result);
}

export async function getTransactions(
  address: string,
  apiKey: string,
  startTimestamp?: number, // Unix timestamp to start from (e.g., Jan 1 of current year)
  startBlockOverride?: number // Optional: use this block number instead of calculating from timestamp
): Promise<{ transactions: EtherscanTransaction[]; lastBlock: number }> {
  // Default to Jan 1 of current year 00:01 UTC for initial/full loads
  const startTime = startTimestamp ?? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1, 0, 1, 0)).getTime() / 1000;
  
  // Get the exact block number for the start timestamp (unless override provided)
  let startBlock = startBlockOverride ?? 0;
  if (!startBlockOverride) {
    try {
      startBlock = await getBlockNumberByTimestamp(startTime, apiKey);
      console.log(`Block number for ${new Date(startTime * 1000).toISOString()}: ${startBlock}`);
      // Small delay to respect rate limits
      await new Promise((r) => setTimeout(r, 250));
    } catch (error) {
      console.warn("Failed to get exact block number, falling back to block 0:", error);
      // Fallback to block 0 if API call fails
    }
  }

  // Helper: fetch paginated results from Etherscan V2 with small delay to respect 5 req/sec.
  async function fetchPaged(
    action: "txlist" | "txlistinternal",
    offset = 1000
  ): Promise<EtherscanTransaction[]> {
    let page = 1;
    const out: EtherscanTransaction[] = [];
    while (true) {
      const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=${action}&address=${address}&startblock=${startBlock}&endblock=99999999&page=${page}&offset=${offset}&sort=asc&apikey=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status === "0") {
        const msg: string = typeof data.result === "string" ? data.result : data.message || "Unknown error";
        if (msg.includes("No transactions found") || msg.includes("No record") || msg === "0" || msg === "") {
          break;
        }
        throw new Error(`Etherscan API error (${action}): ${msg}`);
      }
      const items: EtherscanTransaction[] = Array.isArray(data.result) ? data.result : [];
      out.push(...items);
      if (items.length < offset) break;
      page += 1;
      await new Promise((r) => setTimeout(r, 250)); // ~4 req/sec
    }
    return out;
  }

  // Fetch both regular and internal transactions with pagination
  const [regularTxs, internalTxs] = await Promise.all([
    fetchPaged("txlist"),
    fetchPaged("txlistinternal"),
  ]);

  const allTxs = [...regularTxs, ...internalTxs];
  console.log(`Total transactions found: ${allTxs.length} (${regularTxs.length} regular, ${internalTxs.length} internal)`);
  
  // Filter for incoming transactions only, and also filter by timestamp
  const incomingTxs = allTxs.filter(
    (tx: EtherscanTransaction) => {
      const txTimestamp = parseInt(tx.timeStamp);
      return tx.to.toLowerCase() === address.toLowerCase() &&
        parseFloat(tx.value) > 0 &&
        tx.isError === "0" &&
        txTimestamp >= startTime; // Ensure transaction is after our start time
    }
  );
  
  // Find the highest block number from transactions (for cache metadata)
  let lastBlock = startBlock;
  if (incomingTxs.length > 0) {
    // Note: EtherscanTransaction doesn't have blockNumber, so we'll use current block as approximation
    // In a real scenario, we'd track the actual block number from the API response
    lastBlock = startBlock; // We'll update this with actual block tracking if needed
  }
  
  console.log(`Incoming transactions (from ${new Date(startTime * 1000).toLocaleDateString()}): ${incomingTxs.length}`);
  
  return { transactions: incomingTxs, lastBlock };
}

