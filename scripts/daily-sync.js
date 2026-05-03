/**
 * Daily job: updates centralized ETH EUR/USD for yesterday (UTC) in data/eth-prices.json
 * and optionally commits/pushes to GitHub. Reward transactions come from Dune + beacon-sync.
 *
 * Usage: node scripts/daily-sync.js
 * Requires: COINGECKO_API_KEY (recommended). FIREBASE_SERVICE_ACCOUNT is optional (unused for prices).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Path to ETH prices JSON file
const ETH_PRICES_FILE = path.join(__dirname, '..', 'data', 'eth-prices.json');

// Rate limiting for CoinGecko
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2100; // 2.1 seconds between requests

/** CoinGecko /history?date= returns prior-day website Close; use UTC reward day + 1 for the query. */
function coinGeckoHistoryDdMmYyyyFromUtcRewardDay(timestampSeconds) {
  const d = new Date(timestampSeconds * 1000);
  const api = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return `${String(api.getUTCDate()).padStart(2, '0')}-${String(api.getUTCMonth() + 1).padStart(2, '0')}-${api.getUTCFullYear()}`;
}

/**
 * Fetch ETH price from CoinGecko for a specific timestamp
 */
async function getEthPriceAtTimestamp(timestamp, currency = 'EUR', apiKey) {
  const dateString = coinGeckoHistoryDdMmYyyyFromUtcRewardDay(timestamp);

  const baseUrl = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  
  const headers = {
    accept: 'application/json',
  };
  
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }

  // Rate limiting
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();

  try {
    const res = await fetch(baseUrl, { headers });
    
    if (!res.ok) {
      if (res.status === 429) {
        // Rate limited - wait and retry once
        console.warn(`Rate limited, waiting 60s...`);
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return getEthPriceAtTimestamp(timestamp, currency, apiKey);
      }
      throw new Error(`Failed to fetch ETH price: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    if (!data.market_data?.current_price?.[currency.toLowerCase()]) {
      throw new Error(`Missing ${currency} for CoinGecko date=${dateString}`);
    }

    return data.market_data.current_price[currency.toLowerCase()];
  } catch (error) {
    console.error(`Error fetching price for ${dateString}:`, error.message);
    throw error;
  }
}

/**
 * UTC calendar date for "yesterday" relative to now (YYYY-MM-DD).
 * Use when the job runs after UTC midnight (e.g. 00:45 UTC) so the prior UTC day is complete
 * and aligns with CoinGecko guidance (~00:35 UTC after midnight for the last completed UTC day).
 */
function getYesterdayUtcDateKey() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Unix seconds for 00:00:00 UTC on a YYYY-MM-DD date key. */
function utcMidnightTimestampSeconds(dateKey) {
  const parts = dateKey.split('-').map(Number);
  const [year, month, day] = parts;
  if (!year || !month || !day) return Math.floor(Date.now() / 1000);
  return Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000);
}

/**
 * Load ETH prices from JSON file
 */
function loadEthPrices() {
  try {
    if (!fs.existsSync(ETH_PRICES_FILE)) {
      return {};
    }
    const data = fs.readFileSync(ETH_PRICES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading ETH prices from JSON:', error.message);
    return {};
  }
}

/**
 * Save ETH prices to JSON file
 */
function saveEthPrices(prices) {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(ETH_PRICES_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Write JSON file with pretty formatting
    fs.writeFileSync(ETH_PRICES_FILE, JSON.stringify(prices, null, 2), 'utf8');
    console.log(`  Saved prices to ${ETH_PRICES_FILE}`);
  } catch (error) {
    console.error('Error saving ETH prices to JSON:', error.message);
    throw error;
  }
}

/**
 * Commit and push the JSON file to GitHub
 */
function commitAndPushPrices(dateLabel) {
  try {
    // Check if there are changes to commit
    try {
      // Check if file has changes compared to HEAD
      execSync('git diff --quiet HEAD -- data/eth-prices.json', {
        cwd: path.join(__dirname, '..'),
        stdio: 'ignore'
      });
      // If diff --quiet succeeds (exit code 0), there are no changes
      console.log('  No changes to commit (price already up to date)');
      return;
    } catch (diffError) {
      // diff --quiet returns non-zero if there are changes - continue to commit
    }
    
    // Configure git user (required for commits)
    execSync('git config user.name "GitHub Actions"', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore'
    });
    execSync('git config user.email "actions@github.com"', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore'
    });
    
    // Stage, commit, and push (force add even if in .gitignore)
    execSync('git add -f data/eth-prices.json', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    
    execSync(`git commit -m "Update ETH prices for ${dateLabel}"`, { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    
    execSync('git push origin main', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    
    console.log('  Successfully committed and pushed price updates to GitHub');
  } catch (error) {
    // If git operations fail (e.g., not in a git repo, no permissions), just log a warning
    console.warn('  Warning: Could not commit/push price updates to GitHub:', error.message);
    console.warn('  Prices were saved locally but not pushed. This is OK if running locally.');
  }
}

/**
 * Fetch and store ETH/EUR and ETH/USD for the previous UTC calendar day ("yesterday").
 * Schedule ~00:45 UTC so the prior UTC day is finished and CoinGecko daily history is available (~after 00:35 UTC).
 */
async function updateYesterdayUtcPrice(coingeckoApiKey) {
  console.log('Updating yesterday (UTC) ETH price in JSON storage...');

  try {
    const dateKey = getYesterdayUtcDateKey();
    const prices = loadEthPrices();

    if (prices[dateKey] && prices[dateKey].eur && prices[dateKey].usd) {
      console.log(
        `  Price for ${dateKey} already exists: EUR ${prices[dateKey].eur}, USD ${prices[dateKey].usd}`
      );
      return;
    }

    const timestamp = utcMidnightTimestampSeconds(dateKey);
    const priceEUR = await getEthPriceAtTimestamp(timestamp, 'EUR', coingeckoApiKey);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const priceUSD = await getEthPriceAtTimestamp(timestamp, 'USD', coingeckoApiKey);

    prices[dateKey] = { eur: priceEUR, usd: priceUSD };
    saveEthPrices(prices);
    commitAndPushPrices(dateKey);

    console.log(`  Updated ETH price for ${dateKey} (UTC): EUR ${priceEUR}, USD ${priceUSD}`);
  } catch (error) {
    console.error('  Error updating yesterday UTC ETH price:', error.message);
    // Don't fail the entire sync if price update fails
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Starting daily sync...');
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  
  if (!coingeckoApiKey) {
    console.warn('Warning: COINGECKO_API_KEY not set, price fetching may fail');
  }
  
  try {
    if (coingeckoApiKey) {
      await updateYesterdayUtcPrice(coingeckoApiKey);
    } else {
      console.warn('Skipping ETH price update: COINGECKO_API_KEY not set');
    }

    console.log('\nDaily sync complete (ETH price JSON only; rewards use beacon-sync + Dune).');
  } catch (error) {
    console.error('Daily sync failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };

