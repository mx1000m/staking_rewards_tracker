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
  // Calculate start block from timestamp (approximate: 1 block per 12 seconds)
  // If no timestamp provided, default to Jan 1 of current year
  const startTime = startTimestamp || new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
  const startBlock = Math.floor((startTime - 1438269988) / 12); // Ethereum genesis was at timestamp 1438269988
  
  // Get regular transactions from start (V2 API)
  const regularUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  const regularRes = await fetch(regularUrl);
  const regularData = await regularRes.json();
  
  console.log("Etherscan API response:", regularData);
  
  // Handle API errors
  if (regularData.status === "0") {
    // Etherscan returns errors in the result field when status is "0"
    const errorMsg = typeof regularData.result === "string" 
      ? regularData.result 
      : regularData.message || "Unknown error";
    
    // "No transactions found" is not an error, it's just empty
    if (errorMsg.includes("No transactions found") || 
        errorMsg.includes("No record") ||
        errorMsg === "0" ||
        errorMsg === "") {
      console.log("No regular transactions found");
      // Return empty array, continue to check internal transactions
    } else {
      // This is a real error (invalid API key, rate limit, etc.)
      throw new Error(`Etherscan API error: ${errorMsg}. Please check your API key and try again.`);
    }
  }

  // Get internal transactions from start (V2 API)
  const internalUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlistinternal&address=${address}&startblock=0&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  const internalRes = await fetch(internalUrl);
  const internalData = await internalRes.json();
  
  // Handle internal transaction errors (empty is OK)
  let internalTxs: EtherscanTransaction[] = [];
  if (internalData.status === "0" && internalData.message) {
    if (!internalData.message.includes("No transactions found") && !internalData.message.includes("No record")) {
      console.warn("Internal transactions API error:", internalData.message);
    }
  } else {
    internalTxs = internalData.result || [];
  }

  // Combine all transactions
  // Only include regularTxs if status was "1" (success) or if we got an array
  let regularTxs: EtherscanTransaction[] = [];
  if (regularData.status === "1" && Array.isArray(regularData.result)) {
    regularTxs = regularData.result;
  } else if (Array.isArray(regularData.result)) {
    regularTxs = regularData.result;
  }
  
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

