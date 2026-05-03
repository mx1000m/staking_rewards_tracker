/**
 * Same semantics as app/src/utils/coinGeckoHistoryQueryDate.ts (for plain `node` scripts).
 */
export function coinGeckoHistoryDdMmYyyyFromUtcRewardDay(timestampSeconds) {
  const d = new Date(timestampSeconds * 1000);
  const api = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return `${String(api.getUTCDate()).padStart(2, "0")}-${String(api.getUTCMonth() + 1).padStart(2, "0")}-${api.getUTCFullYear()}`;
}
