/**
 * Migration script to populate historical ETH prices in centralized storage
 * Fetches prices from CoinGecko for all dates from 2025-01-01 to today
 * 
 * Usage: node scripts/populate-historical-prices.js
 * Requires: FIREBASE_SERVICE_ACCOUNT (JSON string) and COINGECKO_API_KEY env vars
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is required');
  }
  const serviceAccount = JSON.parse(serviceAccountJson);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

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
 * Main function
 */
async function main() {
  console.log('Starting historical price population...');
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
    
    // Check existing prices to avoid re-fetching
    const pricesRef = db.doc('ethPrices/daily');
    const pricesDoc = await pricesRef.get();
    const existingPrices = pricesDoc.exists ? pricesDoc.data() : {};
    
    const pricesToUpdate = {};
    let fetchedCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dateKey = getDateKey(Math.floor(date.getTime() / 1000));
      
      // Skip if price already exists
      if (existingPrices[dateKey] && existingPrices[dateKey].eur && existingPrices[dateKey].usd) {
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
        
        pricesToUpdate[dateKey] = { eur: priceEUR, usd: priceUSD };
        fetchedCount++;
        
        // Log progress every 10 dates
        if (fetchedCount % 10 === 0) {
          console.log(`  Progress: ${i + 1}/${dates.length} (fetched ${fetchedCount} new, skipped ${skippedCount} existing)`);
        }
        
        // Batch update every 50 prices to avoid memory issues
        if (Object.keys(pricesToUpdate).length >= 50) {
          if (pricesDoc.exists) {
            await pricesRef.update(pricesToUpdate);
          } else {
            await pricesRef.set(pricesToUpdate);
          }
          console.log(`  Saved batch of ${Object.keys(pricesToUpdate).length} prices to Firestore`);
          Object.keys(pricesToUpdate).forEach(key => delete pricesToUpdate[key]);
        }
      } catch (error) {
        console.error(`  Failed to fetch prices for ${dateKey}:`, error.message);
        // Continue with next date
      }
    }
    
    // Save remaining prices
    if (Object.keys(pricesToUpdate).length > 0) {
      if (pricesDoc.exists) {
        await pricesRef.update(pricesToUpdate);
      } else {
        await pricesRef.set(pricesToUpdate);
      }
      console.log(`  Saved final batch of ${Object.keys(pricesToUpdate).length} prices to Firestore`);
    }
    
    console.log(`\nHistorical price population complete!`);
    console.log(`  Total dates processed: ${dates.length}`);
    console.log(`  New prices fetched: ${fetchedCount}`);
    console.log(`  Existing prices skipped: ${skippedCount}`);
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

