// Simple in-memory cache for ETH prices by date
const priceCache = new Map<string, number>();

export function getCachedPrice(dateKey: string): number | null {
  return priceCache.get(dateKey) || null;
}

export function setCachedPrice(dateKey: string, price: number): void {
  priceCache.set(dateKey, price);
}

export function getDateKey(timestamp: number): string {
  // Use UTC to match backend scripts (daily-sync.js, populate-historical-prices.js)
  // This ensures consistent date keys regardless of user's timezone
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

