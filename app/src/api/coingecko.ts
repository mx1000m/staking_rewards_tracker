// Rate limiting: track last request time to respect 30 calls/min limit
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2100; // 2.1 seconds between requests (slightly more than 2s to be safe)

export async function getEthPriceAtTimestamp(
  timestamp: number,
  currency: "EUR" | "USD" = "EUR",
  apiKey?: string,
  retryCount = 0
): Promise<number> {
  const date = new Date(timestamp * 1000);
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  const dateString = `${day}-${month}-${year}`;

  const baseUrl = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  
  const headers: HeadersInit = {
    accept: "application/json",
  };
  
  if (apiKey) {
    headers["x-cg-demo-api-key"] = apiKey;
  }

  // Rate limiting: ensure minimum time between requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  // Try direct fetch first
  let res: Response;
  try {
    lastRequestTime = Date.now();
    res = await fetch(baseUrl, { headers });
  } catch (error: any) {
    // If CORS error, try with CORS proxy (corsproxy.io)
    if (error.message?.includes("CORS") || error.message?.includes("Failed to fetch")) {
      console.warn("Direct CoinGecko fetch failed (CORS?), trying with proxy...");
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(baseUrl)}`;
      try {
        lastRequestTime = Date.now();
        res = await fetch(proxyUrl, { 
          headers: { 
            accept: "application/json",
          },
          mode: "cors"
        });
      } catch (proxyError: any) {
        // If proxy also fails, throw with helpful message
        throw new Error(`Failed to fetch ETH price: CORS error. Please try again later or use a different network.`);
      }
    } else {
      throw error;
    }
  }

  if (!res.ok) {
    if (res.status === 429) {
      // Rate limited - exponential backoff
      const backoffTime = Math.min(60000 * Math.pow(2, retryCount), 300000); // Max 5 minutes
      console.warn(`CoinGecko rate limited (attempt ${retryCount + 1}), waiting ${backoffTime / 1000}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
      if (retryCount < 3) {
        return getEthPriceAtTimestamp(timestamp, currency, apiKey, retryCount + 1);
      } else {
        throw new Error(`Rate limited: Too many requests. Please wait a few minutes and try again.`);
      }
    }
    throw new Error(`Failed to fetch ETH price: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (!data.market_data?.current_price?.[currency.toLowerCase()]) {
    // Try to get price from a nearby date if exact date is missing
    if (retryCount === 0) {
      console.warn(`Missing price data for ${dateString}, trying previous day...`);
      const previousDay = new Date(timestamp * 1000);
      previousDay.setDate(previousDay.getDate() - 1);
      return getEthPriceAtTimestamp(Math.floor(previousDay.getTime() / 1000), currency, apiKey, 1);
    }
    throw new Error(`Missing ${currency} price data for ${dateString}`);
  }

  return data.market_data.current_price[currency.toLowerCase()];
}

