/**
 * Migration script to populate historical ETH prices in GitHub JSON file
 * Fetches prices from CoinGecko for all dates from 2025-01-01 to today
 * Writes directly to data/eth-prices.json (which will be committed to GitHub)
 * 
 * Usage: node scripts/populate-historical-prices.js
 * Requires: COINGECKO_API_KEY env var (Firebase not needed anymore)
 */

const fs = require('fs');
const path = require('path');

// Path to ETH prices JSON file
const ETH_PRICES_FILE = path.join(__dirname, '..', 'data', 'eth-prices.json');

// Rate limiting for CoinGecko
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2100; // 2.1 seconds between requests

/**
 * Get date key in YYYY-MM-DD format
 */
function getDateKey(timestamp) {
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Fetch ETH price from CoinGecko for a specific timestamp
 */
async function getEthPriceAtTimestamp(timestamp, currency = 'EUR', apiKey) {
  const date = new Date(timestamp * 1000);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  const dateString = `${day}-${month}-${year}`;

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
      // Try previous day if exact date is missing
      const previousDay = new Date(timestamp * 1000);
      previousDay.setDate(previousDay.getDate() - 1);
      return getEthPriceAtTimestamp(Math.floor(previousDay.getTime() / 1000), currency, apiKey);
    }

    return data.market_data.current_price[currency.toLowerCase()];
  } catch (error) {
    console.error(`Error fetching price for ${dateString}:`, error.message);
    throw error;
  }
}

/**
 * Generate all dates from start date to end date (inclusive)
 */
function generateDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  
  while (current <= endDate) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

/**
 * Load existing prices from JSON file
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
 * Save prices to JSON file
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
  } catch (error) {
    console.error('Error saving ETH prices to JSON:', error.message);
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Starting historical price population (GitHub storage)...');
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  
  if (!coingeckoApiKey) {
    throw new Error('COINGECKO_API_KEY environment variable is required');
  }
  
  try {
    // Generate date range from 2025-01-01 to today
    const startDate = new Date('2025-01-01T00:00:00Z');
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999); // End of today
    
    const dates = generateDateRange(startDate, endDate);
    console.log(`Fetching prices for ${dates.length} dates (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]})`);
    
    // Load existing prices from JSON file
    const existingPrices = loadEthPrices();
    console.log(`Found ${Object.keys(existingPrices).length} existing prices in JSON file`);
    
    const allPrices = { ...existingPrices }; // Start with existing prices
    let fetchedCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dateKey = getDateKey(Math.floor(date.getTime() / 1000));
      
      // Skip if price already exists
      if (allPrices[dateKey] && allPrices[dateKey].eur && allPrices[dateKey].usd) {
        skippedCount++;
        if ((i + 1) % 50 === 0) {
          console.log(`  Progress: ${i + 1}/${dates.length} (skipped ${skippedCount} existing)`);
        }
        continue;
      }
      
      try {
        // Fetch EUR price
        const priceEUR = await getEthPriceAtTimestamp(Math.floor(date.getTime() / 1000), 'EUR', coingeckoApiKey);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        
        // Fetch USD price
        const priceUSD = await getEthPriceAtTimestamp(Math.floor(date.getTime() / 1000), 'USD', coingeckoApiKey);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        
        allPrices[dateKey] = { eur: priceEUR, usd: priceUSD };
        fetchedCount++;
        
        // Log progress every 10 dates
        if (fetchedCount % 10 === 0) {
          console.log(`  Progress: ${i + 1}/${dates.length} (fetched ${fetchedCount} new, skipped ${skippedCount} existing)`);
        }
        
        // Save to file every 50 prices to avoid data loss
        if (fetchedCount % 50 === 0) {
          saveEthPrices(allPrices);
          console.log(`  Saved progress: ${Object.keys(allPrices).length} total prices in file`);
        }
      } catch (error) {
        console.error(`  Failed to fetch prices for ${dateKey}:`, error.message);
        // Continue with next date
      }
    }
    
    // Final save
    saveEthPrices(allPrices);
    console.log(`  Final save: ${Object.keys(allPrices).length} total prices in file`);
    
    console.log(`\nHistorical price population complete!`);
    console.log(`  Total dates processed: ${dates.length}`);
    console.log(`  New prices fetched: ${fetchedCount}`);
    console.log(`  Existing prices skipped: ${skippedCount}`);
    console.log(`  Total prices in file: ${Object.keys(allPrices).length}`);
    console.log(`\nFile saved to: ${ETH_PRICES_FILE}`);
    console.log('Next: Commit and push this file to GitHub');
  } catch (error) {
    console.error('Historical price population failed:', error);
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

