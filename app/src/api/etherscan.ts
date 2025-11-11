export interface EtherscanTransaction {
  hash: string;
  timeStamp: string;
  value: string;
  from: string;
  to: string;
  isError: string;
}

export async function getTransactions(
  address: string,
  apiKey: string,
  startTimestamp?: number // Unix timestamp to start from (e.g., Jan 1 of current year)
): Promise<EtherscanTransaction[]> {
  // Calculate start block from timestamp (approximate: 1 block per 12 seconds).
  // Default to Jan 1 of current year for initial/full loads.
  const startTime = startTimestamp ?? new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
  const startBlock = Math.floor((startTime - 1438269988) / 12);

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
  
  console.log(`Incoming transactions (from ${new Date(startTime * 1000).toLocaleDateString()}): ${incomingTxs.length}`);
  
  return incomingTxs;
}

