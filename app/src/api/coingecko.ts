export async function getEthPriceAtTimestamp(
  timestamp: number,
  currency: "EUR" | "USD" = "EUR",
  apiKey?: string
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

  // Try direct fetch first
  let res: Response;
  try {
    res = await fetch(baseUrl, { headers });
  } catch (error: any) {
    // If CORS error, try with CORS proxy
    if (error.message?.includes("CORS") || error.message?.includes("Failed to fetch")) {
      console.warn("Direct CoinGecko fetch failed (CORS?), trying with proxy...");
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(baseUrl)}`;
      try {
        res = await fetch(proxyUrl, { headers: { accept: "application/json" } });
      } catch (proxyError) {
        throw new Error(`Failed to fetch ETH price (CORS error): ${error.message}`);
      }
    } else {
      throw error;
    }
  }

  if (!res.ok) {
    if (res.status === 429) {
      // Rate limited, wait and retry
      console.warn("CoinGecko rate limited, waiting 60s before retry...");
      await new Promise((resolve) => setTimeout(resolve, 60000));
      return getEthPriceAtTimestamp(timestamp, currency, apiKey);
    }
    throw new Error(`Failed to fetch ETH price: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (!data.market_data?.current_price?.[currency.toLowerCase()]) {
    throw new Error(`Missing ${currency} price data for ${dateString}`);
  }

  return data.market_data.current_price[currency.toLowerCase()];
}

