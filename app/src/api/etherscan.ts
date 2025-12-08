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

