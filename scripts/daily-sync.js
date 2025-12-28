/**
 * Daily sync script for staking rewards tracker
 * Fetches new transactions for all trackers and saves to Firestore
 * Runs daily via GitHub Actions cron
 * 
 * Usage: node scripts/daily-sync.js
 * Requires: FIREBASE_SERVICE_ACCOUNT (JSON string) and COINGECKO_API_KEY env vars
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Initialize Firebase Admin (still needed for transaction processing)
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

// Path to ETH prices JSON file
const ETH_PRICES_FILE = path.join(__dirname, '..', 'data', 'eth-prices.json');

// Rate limiting for CoinGecko
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2100; // 2.1 seconds between requests

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
 * Fetch transactions from Etherscan
 */
async function getTransactions(withdrawalAddress, feeRecipientAddress, apiKey, startTimestamp) {
  const startTime = startTimestamp || Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  const startBlock = Math.floor((startTime - 1438269988) / 12); // Ethereum genesis timestamp
  
  const clAddress = withdrawalAddress.toLowerCase();
  const evmAddress = feeRecipientAddress.toLowerCase();
  const addressesAreSame = clAddress === evmAddress;
  
  const allTransactions = [];
  
  // Fetch CL withdrawals
  const withdrawalUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txsBeaconWithdrawal&address=${withdrawalAddress}&startblock=0&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  try {
    const withdrawalRes = await fetch(withdrawalUrl);
    const withdrawalData = await withdrawalRes.json();
    
    if (withdrawalData.status === '1' && withdrawalData.result) {
      withdrawalData.result.forEach((w) => {
        const withdrawalAddressLower = (w.address || w.withdrawalAddress || '').toLowerCase();
        if (withdrawalAddressLower === clAddress) {
          allTransactions.push({
            hash: `0xbeacon_${w.withdrawalIndex}_${w.validatorIndex}`,
            timeStamp: w.timestamp || w.blockTimestamp || Math.floor(Date.now() / 1000).toString(),
            value: w.amount,
            from: '',
            to: w.address || w.withdrawalAddress,
            isError: '0',
            rewardType: 'CL',
          });
        }
      });
    }
  } catch (error) {
    console.warn('Error fetching CL withdrawals:', error.message);
  }
  
  // Fetch EVM transactions
  const txlistUrl = `https://api.etherscan.io/api?module=account&action=txlist&address=${feeRecipientAddress}&startblock=${startBlock}&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  try {
    const txlistRes = await fetch(txlistUrl);
    const txlistData = await txlistRes.json();
    
    if (txlistData.status === '1' && txlistData.result) {
      txlistData.result.forEach((tx) => {
        if (tx.to && tx.to.toLowerCase() === evmAddress && tx.value !== '0') {
          allTransactions.push({
            hash: tx.hash,
            timeStamp: tx.timeStamp,
            value: tx.value,
            from: tx.from,
            to: tx.to,
            isError: tx.isError,
            rewardType: 'EVM',
          });
        }
      });
    }
  } catch (error) {
    console.warn('Error fetching EVM transactions:', error.message);
  }
  
  // Fetch internal transactions
  const txlistinternalUrl = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${feeRecipientAddress}&startblock=${startBlock}&endblock=99999999&page=1&offset=1000&sort=asc&apikey=${apiKey}`;
  
  try {
    const txlistinternalRes = await fetch(txlistinternalUrl);
    const txlistinternalData = await txlistinternalRes.json();
    
    if (txlistinternalData.status === '1' && txlistinternalData.result) {
      txlistinternalData.result.forEach((tx) => {
        if (tx.to && tx.to.toLowerCase() === evmAddress && tx.value !== '0') {
          // Check if we already have this transaction
          if (!allTransactions.find(t => t.hash === tx.hash)) {
            allTransactions.push({
              hash: tx.hash,
              timeStamp: tx.timeStamp,
              value: tx.value,
              from: tx.from,
              to: tx.to,
              isError: tx.isError || '0',
              rewardType: 'EVM',
            });
          }
        }
      });
    }
  } catch (error) {
    console.warn('Error fetching internal transactions:', error.message);
  }
  
  // Filter by startTimestamp
  return allTransactions.filter(tx => parseInt(tx.timeStamp) >= startTime);
}

/**
 * Get date key for caching (YYYY-MM-DD format)
 */
function getDateKey(timestamp) {
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get all trackers from Firestore
 */
async function getAllTrackers() {
  const trackersMap = new Map();
  const usersSnapshot = await db.collection('users').get();
  
  for (const userDoc of usersSnapshot.docs) {
    const uid = userDoc.id;
    const trackers = [];
    const trackersSnapshot = await db.collection(`users/${uid}/trackers`).get();
    
    for (const trackerDoc of trackersSnapshot.docs) {
      const data = trackerDoc.data();
      trackers.push({
        id: trackerDoc.id,
        name: data.name || '',
        walletAddress: data.walletAddress || '',
        feeRecipientAddress: data.feeRecipientAddress || undefined,
        currency: data.currency || 'EUR',
        country: data.country || 'Croatia',
        taxRate: data.taxRate || 24,
        etherscanKey: data.etherscanKey || '',
        createdAt: data.createdAt?.toMillis() || Date.now(),
      });
    }
    
    if (trackers.length > 0) {
      trackersMap.set(uid, trackers);
    }
  }
  
  return trackersMap;
}

/**
 * Get existing transaction hashes for a tracker
 */
async function getExistingTransactionHashes(uid, trackerId) {
  const hashes = new Set();
  const txsSnapshot = await db.collection(`users/${uid}/trackers/${trackerId}/transactions`).get();
  txsSnapshot.forEach((doc) => hashes.add(doc.id));
  return hashes;
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
function commitAndPushPrices() {
  try {
    // Check if we're in a git repository and if there are changes
    try {
      const gitStatus = execSync('git status --porcelain data/eth-prices.json', { 
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8'
      }).trim();
      
      if (!gitStatus) {
        console.log('  No changes to commit (price already up to date)');
        return;
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
      
      // Stage, commit, and push
      execSync('git add data/eth-prices.json', { 
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
      
      const today = new Date().toISOString().split('T')[0];
      execSync(`git commit -m "Update ETH prices for ${today}"`, { 
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
  } catch (error) {
    console.warn('  Warning: Git operations failed:', error.message);
  }
}

/**
 * Get ETH price from JSON storage for a date
 */
function getEthPriceFromStorage(dateKey) {
  const prices = loadEthPrices();
  return prices[dateKey] || null; // Returns { eur: number, usd: number } or null
}

/**
 * Process a single tracker
 * Now uses centralized price storage instead of fetching from CoinGecko per transaction
 */
async function processTracker(uid, tracker, coingeckoApiKey) {
  console.log(`Processing tracker: ${tracker.name} (${tracker.walletAddress})`);
  
  try {
    const existingHashes = await getExistingTransactionHashes(uid, tracker.id);
    console.log(`  Found ${existingHashes.size} existing transactions`);
    
    // Fetch transactions from last 30 days
    const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const feeRecipientAddress = tracker.feeRecipientAddress || tracker.walletAddress;
    
    const etherscanTxs = await getTransactions(
      tracker.walletAddress,
      feeRecipientAddress,
      tracker.etherscanKey,
      thirtyDaysAgo
    );
    
    const newTxs = etherscanTxs.filter((tx) => !existingHashes.has(tx.hash));
    console.log(`  Found ${newTxs.length} new transactions`);
    
    if (newTxs.length === 0) {
      return 0;
    }
    
    // Get prices from centralized storage for all unique dates
    const uniqueDates = new Set();
    for (const tx of newTxs) {
      const dateKey = getDateKey(parseInt(tx.timeStamp));
      uniqueDates.add(dateKey);
    }
    
    console.log(`  Fetching prices from centralized storage for ${uniqueDates.size} unique dates...`);
    const datePriceMap = new Map(); // dateKey -> { eur: number, usd: number }
    
    for (const dateKey of uniqueDates) {
      const price = await getEthPriceFromStorage(dateKey);
      if (price && price.eur && price.usd) {
        datePriceMap.set(dateKey, price);
      } else {
        console.warn(`  Warning: No price found in storage for ${dateKey}, transaction will have 0 prices`);
        datePriceMap.set(dateKey, { eur: 0, usd: 0 });
      }
    }
    
    // Process transactions (no longer storing prices in transaction documents)
    const processedTxs = [];
    for (const tx of newTxs) {
      const timestamp = parseInt(tx.timeStamp) * 1000;
      const date = new Date(timestamp);
      const dateKey = getDateKey(parseInt(tx.timeStamp));
      
      const rawValue = parseFloat(tx.value);
      const ethAmount = tx.rewardType === 'CL' ? rawValue / 1e9 : rawValue / 1e18;
      const taxesInEth = ethAmount * (tracker.taxRate / 100);
      
      processedTxs.push({
        date: date.toLocaleDateString('en-GB', { timeZone: 'Europe/Zagreb' }),
        time: date.toLocaleTimeString('en-GB', { timeZone: 'Europe/Zagreb', hour12: false }),
        ethAmount,
        taxRate: tracker.taxRate,
        taxesInEth,
        transactionHash: tx.hash,
        status: 'Unpaid',
        timestamp: parseInt(tx.timeStamp),
        rewardType: tx.rewardType || 'EVM',
      });
    }
    
    // Save to Firestore (no longer storing ethPriceEUR/ethPriceUSD)
    const batch = db.batch();
    for (const tx of processedTxs) {
      const txRef = db.collection(`users/${uid}/trackers/${tracker.id}/transactions`).doc(tx.transactionHash);
      batch.set(txRef, {
        date: tx.date,
        time: tx.time,
        ethAmount: tx.ethAmount,
        taxRate: tx.taxRate,
        taxesInEth: tx.taxesInEth,
        transactionHash: tx.transactionHash,
        status: tx.status,
        timestamp: admin.firestore.Timestamp.fromMillis(tx.timestamp * 1000),
        rewardType: tx.rewardType || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    
    await batch.commit();
    console.log(`  Saved ${processedTxs.length} new transactions to Firestore`);
    return processedTxs.length;
  } catch (error) {
    console.error(`  Error processing tracker ${tracker.name}:`, error.message);
    return 0;
  }
}

/**
 * Update today's ETH price in JSON file
 * This runs once per day before processing transactions
 */
async function updateTodaysPrice(coingeckoApiKey) {
  console.log('Updating today\'s ETH price in JSON storage...');
  
  try {
    const today = new Date();
    const todayKey = getDateKey(Math.floor(today.getTime() / 1000));
    
    // Load existing prices
    const prices = loadEthPrices();
    
    // Check if today's price already exists
    if (prices[todayKey] && prices[todayKey].eur && prices[todayKey].usd) {
      console.log(`  Today's price (${todayKey}) already exists: EUR ${prices[todayKey].eur}, USD ${prices[todayKey].usd}`);
      return;
    }
    
    // Fetch today's prices from CoinGecko
    const timestamp = Math.floor(today.getTime() / 1000);
    const priceEUR = await getEthPriceAtTimestamp(timestamp, 'EUR', coingeckoApiKey);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const priceUSD = await getEthPriceAtTimestamp(timestamp, 'USD', coingeckoApiKey);
    
    // Update prices object
    prices[todayKey] = { eur: priceEUR, usd: priceUSD };
    
    // Save to JSON file
    saveEthPrices(prices);
    
    // Commit and push to GitHub (if in git repo with permissions)
    commitAndPushPrices();
    
    console.log(`  Updated today's price (${todayKey}): EUR ${priceEUR}, USD ${priceUSD}`);
  } catch (error) {
    console.error('  Error updating today\'s price:', error.message);
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
    // First, update today's price in centralized storage
    if (coingeckoApiKey) {
      await updateTodaysPrice(coingeckoApiKey);
    }
    
    // Then process all trackers
    const trackersMap = await getAllTrackers();
    console.log(`\nFound ${trackersMap.size} users with trackers`);
    
    let totalProcessed = 0;
    for (const [uid, trackers] of trackersMap.entries()) {
      console.log(`\nProcessing user: ${uid} (${trackers.length} trackers)`);
      for (const tracker of trackers) {
        if (!tracker.etherscanKey) {
          console.log(`  Skipping ${tracker.name} - no Etherscan API key`);
          continue;
        }
        const count = await processTracker(uid, tracker, coingeckoApiKey);
        totalProcessed += count;
      }
    }
    
    console.log(`\nDaily sync complete. Processed ${totalProcessed} new transactions.`);
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

