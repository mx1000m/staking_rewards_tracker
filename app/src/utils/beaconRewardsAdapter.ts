import { CachedTransaction } from "./transactionCache";
import { fetchValidatorRewardsFromBeaconcha } from "../api/beaconcha";

/**
 * Map Beaconcha.in rewards response into our CachedTransaction model.
 * For now we treat each reward item as a single synthetic \"transaction\"
 * dated at the epoch range; this is an approximation but gives users
 * visibility into consensus-layer income per validator.
 */
export async function fetchConsensusRewardsAsTransactions(options: {
  beaconApiKey: string;
  validatorPublicKey: string;
  trackerId: string;
}): Promise<CachedTransaction[]> {
  const { beaconApiKey, validatorPublicKey, trackerId } = options;

  if (!beaconApiKey || !validatorPublicKey) {
    console.warn(
      "fetchConsensusRewardsAsTransactions called without beaconApiKey or validatorPublicKey"
    );
    return [];
  }

  const res = await fetchValidatorRewardsFromBeaconcha(
    beaconApiKey,
    validatorPublicKey,
    {
      chain: "mainnet",
      pageSize: 50,
    }
  );

  const now = Date.now();

  const txs: CachedTransaction[] = (res.data || []).map((item, idx) => {
    const totalReward = Number(item.total_reward || item.total || 0);

    // Beaconcha values are in gwei; convert to ETH if that's the case.
    const ethAmount = isNaN(totalReward) ? 0 : totalReward / 1e9;

    const timestampSeconds = Math.floor(now / 1000) - idx; // simple ordering

    return {
      date: new Date(timestampSeconds * 1000).toISOString().slice(0, 10),
      time: new Date(timestampSeconds * 1000).toISOString().slice(11, 19),
      ethAmount,
      ethPriceEUR: 0,
      ethPriceUSD: 0,
      ethPrice: 0,
      taxRate: 0,
      taxesInEth: 0,
      transactionHash: `beaconcha_${trackerId}_${idx}`,
      status: "Unpaid",
      timestamp: timestampSeconds,
      rewardType: "CL",
    };
  });

  return txs;
}

