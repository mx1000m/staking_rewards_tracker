// Minimal Beaconcha.in adapter for fetching validator rewards.
// Uses the public V2 API as documented at:
// https://docs.beaconcha.in/api/overview
//
// NOTE: This is an initial integration. The exact response shape may evolve;
// we log unexpected payloads so they can be inspected and adapted without
// breaking the rest of the app.

export interface BeaconchaRewardItem {
  total: string; // total reward in gwei or wei (depends on endpoint)
  validator: {
    index: number;
    public_key: string;
  };
  total_reward: string;
  total_penalty: string;
  // We keep the rest of the structure loosely typed for now.
  [key: string]: any;
}

export interface BeaconchaRewardsResponse {
  data: BeaconchaRewardItem[];
  paging?: any;
  range?: any;
}

/**
 * Fetch validator rewards from beaconcha.in using the v2 rewards-list endpoint.
 * This returns aggregated rewards over the requested range. For now we treat
 * each response as a single logical \"transaction\" in our pipeline and rely
 * on timestamping at the epoch range boundaries.
 */
export async function fetchValidatorRewardsFromBeaconcha(
  apiKey: string,
  validatorPublicKey: string,
  opts?: {
    chain?: "mainnet" | "prater" | "holesky";
    pageSize?: number;
    epoch?: number;
  }
): Promise<BeaconchaRewardsResponse> {
  const chain = opts?.chain ?? "mainnet";
  const pageSize = opts?.pageSize ?? 100;

  const url = "https://beaconcha.in/api/v2/ethereum/validators/rewards-list";

  const body = {
    validator: {
      validator_identifiers: [validatorPublicKey],
    },
    chain,
    page_size: pageSize,
    ...(opts?.epoch != null ? { epoch: opts.epoch } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Beaconcha.in API error: ${res.status} ${res.statusText} – ${text}`
    );
  }

  const json = (await res.json()) as BeaconchaRewardsResponse;

  if (!json || !Array.isArray(json.data)) {
    console.warn("Unexpected Beaconcha.in rewards response shape:", json);
  }

  return json;
}

