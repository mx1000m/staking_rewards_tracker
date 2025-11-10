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
  
  if (!regularData.result || regularData.status === "0") {
    throw new Error(`Etherscan API error: ${regularData.message || "Unknown error"}`);
  }

  // Get internal transactions
  const internalUrl = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${apiKey}`;
  
  const internalRes = await fetch(internalUrl);
  const internalData = await internalRes.json();
  
  const internalTxs = internalData.result || [];

  // Filter for incoming transactions only
  const allTxs = [...(regularData.result || []), ...internalTxs];
  
  return allTxs.filter(
    (tx: EtherscanTransaction) =>
      tx.to.toLowerCase() === address.toLowerCase() &&
      parseFloat(tx.value) > 0 &&
      tx.isError === "0"
  );
}

