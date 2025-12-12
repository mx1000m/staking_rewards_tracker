export interface EtherscanTransaction {
  hash: string;
  timeStamp: string;
  value: string;
  from: string;
  to: string;
  isError: string;
  rewardType?: "CL" | "EVM"; // Tag to identify reward source
}

export interface BeaconWithdrawal {
  withdrawalIndex: string;
  validatorIndex: string;
  address: string;
  amount: string;
  blockNumber: string;
  timestamp: string;
  // Some APIs may use different field names
  withdrawalAddress?: string;
  blockTimestamp?: string;
}

export async function getTransactions(
  withdrawalAddress: string, // Consensus Layer (CL) address - receives beacon withdrawals
  feeRecipientAddress: string, // Execution Layer (EVM) address - receives fee recipient rewards
  apiKey: string,
  startTimestamp?: number // Unix timestamp to start from (e.g., Jan 1 of current year)
): Promise<EtherscanTransaction[]> {
  // Calculate start block from timestamp (approximate: 1 block per 12 seconds)
  // If no timestamp provided, default to Jan 1 of current year
  const startTime = startTimestamp || new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
  const startBlock = Math.floor((startTime - 1438269988) / 12); // Ethereum genesis was at timestamp 1438269988
  
  // Normalize addresses for comparison
  const clAddress = withdrawalAddress.toLowerCase();
  const evmAddress = feeRecipientAddress.toLowerCase();
  const addressesAreSame = clAddress === evmAddress;
  
  // ===== CONSENSUS LAYER (CL) REWARDS =====
  // Get beacon chain withdrawals (partial withdrawals from validators)
  // These ONLY appear in txsBeaconWithdrawal endpoint, NOT in txlist or txlistinternal
  const withdrawalUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txsBeaconWithdrawal&address=${withdrawalAddress}&startblock=0&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  const withdrawalRes = await fetch(withdrawalUrl);
  const withdrawalData = await withdrawalRes.json();
  
  // Handle beacon withdrawal errors (empty is OK - not all addresses have withdrawals)
  let beaconWithdrawals: BeaconWithdrawal[] = [];
  if (withdrawalData.status === "0" && withdrawalData.message) {
    if (!withdrawalData.message.includes("No transactions found") && !withdrawalData.message.includes("No record")) {
      console.warn("Beacon withdrawals API error:", withdrawalData.message);
    }
  } else {
    beaconWithdrawals = withdrawalData.result || [];
  }
  
  // Convert beacon withdrawals to EtherscanTransaction format and tag as CL
  const clTransactions: EtherscanTransaction[] = beaconWithdrawals.map((w: BeaconWithdrawal) => {
    const withdrawalAddr = w.address || w.withdrawalAddress || "";
    const withdrawalTimestamp = w.timestamp || w.blockTimestamp || "";
    const withdrawalAmount = w.amount || "0";
    const withdrawalIndex = w.withdrawalIndex || "";
    const validatorIndex = w.validatorIndex || "";
    
    // Create a unique hash-like identifier for beacon withdrawals
    const uniqueHash = `0xbeacon_${withdrawalIndex}_${validatorIndex}`;
    
    return {
      hash: uniqueHash,
      timeStamp: withdrawalTimestamp,
      value: withdrawalAmount,
      from: "", // Beacon withdrawals don't have a 'from' address - they're system-level
      to: withdrawalAddr,
      isError: "0", // Withdrawals are always successful
      rewardType: "CL", // Tag as Consensus Layer reward
    };
  });
  
  // ===== EXECUTION LAYER (EVM) REWARDS =====
  // Get regular transactions (fee recipient rewards)
  const regularUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${feeRecipientAddress}&startblock=0&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  const regularRes = await fetch(regularUrl);
  const regularData = await regularRes.json();
  
  console.log("Etherscan API response (EVM):", regularData);
  
  // Handle API errors
  let regularTxs: EtherscanTransaction[] = [];
  if (regularData.status === "0") {
    const errorMsg = typeof regularData.result === "string" 
      ? regularData.result 
      : regularData.message || "Unknown error";
    
    if (!errorMsg.includes("No transactions found") && 
        !errorMsg.includes("No record") &&
        errorMsg !== "0" &&
        errorMsg !== "") {
      throw new Error(`Etherscan API error: ${errorMsg}. Please check your API key and try again.`);
    }
  } else if (regularData.status === "1" && Array.isArray(regularData.result)) {
    regularTxs = regularData.result;
  } else if (Array.isArray(regularData.result)) {
    regularTxs = regularData.result;
  }
  
  // Tag regular transactions as EVM rewards
  regularTxs = regularTxs.map(tx => ({ ...tx, rewardType: "EVM" as const }));

  // Get internal transactions (fee recipient rewards)
  const internalUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlistinternal&address=${feeRecipientAddress}&startblock=0&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
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
  
  // Tag internal transactions as EVM rewards
  internalTxs = internalTxs.map(tx => ({ ...tx, rewardType: "EVM" as const }));
  
  // Combine all transactions
  const allTxs = [...clTransactions, ...regularTxs, ...internalTxs];
  
  console.log(`Total transactions found: ${allTxs.length} (${clTransactions.length} CL withdrawals, ${regularTxs.length} EVM regular, ${internalTxs.length} EVM internal)`);
  
  // Filter for incoming transactions only, and also filter by timestamp
  // CL rewards: check tx.to matches withdrawal address
  // EVM rewards: check tx.to matches fee recipient address
  const incomingTxs = allTxs.filter(
    (tx: EtherscanTransaction) => {
      const txTimestamp = parseInt(tx.timeStamp);
      if (isNaN(txTimestamp)) return false;
      
      // Determine which address to check based on reward type
      const targetAddress = tx.rewardType === "CL" ? clAddress : evmAddress;
      const isIncoming = tx.to && tx.to.toLowerCase() === targetAddress;
      const hasValue = parseFloat(tx.value) > 0;
      const isSuccessful = tx.isError === "0" || tx.isError === undefined;
      const isAfterStartTime = txTimestamp >= startTime;
      
      return isIncoming && hasValue && isSuccessful && isAfterStartTime;
    }
  );
  
  // Prevent double counting: if addresses are the same, ensure we don't count the same transaction twice
  // This shouldn't happen since CL and EVM use different endpoints, but we'll deduplicate by hash
  const uniqueTxs = new Map<string, EtherscanTransaction>();
  incomingTxs.forEach(tx => {
    if (!uniqueTxs.has(tx.hash)) {
      uniqueTxs.set(tx.hash, tx);
    }
  });
  
  const finalTxs = Array.from(uniqueTxs.values());
  
  console.log(`Incoming transactions (from ${new Date(startTime * 1000).toLocaleDateString()}): ${finalTxs.length} (${finalTxs.filter(t => t.rewardType === "CL").length} CL, ${finalTxs.filter(t => t.rewardType === "EVM").length} EVM)`);
  
  return finalTxs;
}

/**
 * Get ETH daily price from Etherscan for a specific date (V2 API)
 * Note: This endpoint returns daily average prices, similar to CoinGecko.
 * The "Estimated Value on Day of Txn" shown on Etherscan's website may use
 * more precise calculations, but the API endpoint provides daily averages.
 * 
 * If this endpoint is not available in V2 or requires PRO subscription,
 * the Dashboard will automatically fall back to CoinGecko.
 * 
 * @param timestamp Unix timestamp (seconds)
 * @param apiKey Etherscan API key
 * @returns ETH price in USD for that date (daily average)
 */
export async function getEthPriceAtTimestamp(
  timestamp: number,
  apiKey: string
): Promise<number> {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const dateString = `${year}-${month}-${day}`;

  // Etherscan daily price API endpoint - Using V2 API format
  // V2 API requires chainid parameter (1 for Ethereum mainnet)
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethdailyprice&startdate=${dateString}&enddate=${dateString}&sort=desc&apikey=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  // Log full response for debugging
  console.log(`Etherscan V2 price API response for ${dateString}:`, JSON.stringify(data, null, 2));

  if (data.status === "0" || data.status === 0) {
    const errorMsg = data.message || data.result || "Unknown error";
    console.error(`Etherscan V2 price API error details:`, {
      status: data.status,
      message: data.message,
      result: data.result,
      date: dateString,
      url: url.replace(apiKey, "***")
    });
    
    // Check if the endpoint doesn't exist in V2 - it might be PRO-only or not available
    if (typeof errorMsg === "string" && errorMsg.includes("deprecated")) {
      throw new Error(`Etherscan V2 API: ${errorMsg}. The ethdailyprice endpoint may not be available in V2 or may require PRO subscription.`);
    }
    
    throw new Error(`Etherscan V2 price API error: ${errorMsg}`);
  }

  if (!data.result || !Array.isArray(data.result) || data.result.length === 0) {
    throw new Error(`No price data found for date ${dateString}`);
  }

  // Get the price for the specific date (should be the first/only result)
  const priceData = data.result[0];
  
  // Handle different possible response formats
  let usdPrice: number | null = null;
  
  if (priceData.valueUSD) {
    usdPrice = parseFloat(priceData.valueUSD);
  } else if (priceData.usd) {
    usdPrice = parseFloat(priceData.usd);
  } else if (typeof priceData === "number") {
    usdPrice = priceData;
  } else if (priceData.price) {
    usdPrice = parseFloat(priceData.price);
  }
  
  if (usdPrice === null || isNaN(usdPrice)) {
    console.error("Etherscan price API response:", JSON.stringify(data, null, 2));
    throw new Error(`Invalid price data format for date ${dateString}. Response: ${JSON.stringify(priceData)}`);
  }

  // Return USD price per ETH
  return usdPrice;
}

/**
 * Get EUR/USD exchange rate for a specific date
 * Uses exchangerate-api.com API (free, no API key required for basic usage)
 * @param timestamp Unix timestamp (seconds)
 * @returns EUR/USD exchange rate (USD per 1 EUR, e.g., 1.09 means 1 EUR = 1.09 USD)
 */
export async function getEurUsdRateAtTimestamp(timestamp: number): Promise<number> {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const dateString = `${year}-${month}-${day}`;

  // Use exchangerate-api.com API (free tier, historical data)
  // This returns USD per 1 EUR (e.g., 1.09 means 1 EUR = 1.09 USD)
  const url = `https://api.exchangerate-api.com/v4/historical/usd/${dateString}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.rates && data.rates.EUR) {
      // Return USD per 1 EUR (e.g., 1.09 means 1 EUR = 1.09 USD)
      return parseFloat(data.rates.EUR);
    }
  } catch (error) {
    console.warn(`Failed to fetch EUR/USD rate from exchangerate-api.com: ${error}`);
  }

  // Fallback: use exchangerate.host API
  const fallbackUrl = `https://api.exchangerate.host/${dateString}?base=USD&symbols=EUR`;
  const fallbackRes = await fetch(fallbackUrl);
  const fallbackData = await fallbackRes.json();

  if (fallbackData.success && fallbackData.rates && fallbackData.rates.EUR) {
    // exchangerate.host returns EUR per 1 USD, so we need to invert it
    // If it returns 0.92 (EUR per 1 USD), then USD per 1 EUR = 1 / 0.92 = 1.087
    const eurPerUsd = parseFloat(fallbackData.rates.EUR);
    return 1 / eurPerUsd; // Convert to USD per 1 EUR
  }

  // Last fallback: try current rate
  console.warn(`Historical EUR/USD rate not available for ${dateString}, trying current rate`);
  const currentUrl = `https://api.exchangerate-api.com/v4/latest/USD`;
  const currentRes = await fetch(currentUrl);
  const currentData = await currentRes.json();
  
  if (currentData.rates && currentData.rates.EUR) {
    return parseFloat(currentData.rates.EUR);
  }

  throw new Error(`Failed to fetch EUR/USD rate for date ${dateString}`);
}

