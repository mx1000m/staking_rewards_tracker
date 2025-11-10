// Simple in-memory cache for ETH prices by date
const priceCache = new Map<string, number>();

export function getCachedPrice(dateKey: string): number | null {
  return priceCache.get(dateKey) || null;
}

export function setCachedPrice(dateKey: string, price: number): void {
  priceCache.set(dateKey, price);
}

export function getDateKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return `${year}-${month}-${day}`;
}

