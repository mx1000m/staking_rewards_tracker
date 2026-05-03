/**
 * CoinGecko `GET /coins/ethereum/history?date=dd-mm-yyyy` returns `market_data.current_price`
 * that matches the **previous** calendar day's "Close" on coingecko.com historical_data.
 * To align stored key UTC day `D` with that table, pass `date` = **D+1** (UTC calendar).
 */
export function coinGeckoHistoryDdMmYyyyFromUtcRewardDay(timestampSeconds: number): string {
  const d = new Date(timestampSeconds * 1000);
  const api = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return `${String(api.getUTCDate()).padStart(2, "0")}-${String(api.getUTCMonth() + 1).padStart(2, "0")}-${api.getUTCFullYear()}`;
}
