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
  apiKey: string
): Promise<EtherscanTransaction[]> {
  // Get regular transactions
  const regularUrl = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${apiKey}`;
  
  const regularRes = await fetch(regularUrl);
  const regularData = await regularRes.json();
  
  // Handle API errors
  if (regularData.status === "0" && regularData.message) {
    // "No transactions found" is not an error, it's just empty
    if (regularData.message.includes("No transactions found") || regularData.message.includes("No record")) {
      console.log("No regular transactions found");
    } else {
      throw new Error(`Etherscan API error: ${regularData.message}`);
    }
  }

  // Get internal transactions
  const internalUrl = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${apiKey}`;
  
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
  const regularTxs = Array.isArray(regularData.result) ? regularData.result : [];
  const allTxs = [...regularTxs, ...internalTxs];
  
  console.log(`Total transactions found: ${allTxs.length} (${regularTxs.length} regular, ${internalTxs.length} internal)`);
  
  // Filter for incoming transactions only
  const incomingTxs = allTxs.filter(
    (tx: EtherscanTransaction) =>
      tx.to.toLowerCase() === address.toLowerCase() &&
      parseFloat(tx.value) > 0 &&
      tx.isError === "0"
  );
  
  console.log(`Incoming transactions: ${incomingTxs.length}`);
  
  return incomingTxs;
}

