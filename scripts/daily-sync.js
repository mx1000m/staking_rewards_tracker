/**
 * Daily sync script for staking rewards tracker
 * Fetches new transactions for all trackers and saves to Firestore
 * Runs daily via GitHub Actions cron
 * 
 * Usage: node scripts/daily-sync.js
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
 * Process a single tracker
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
    
    // Collect unique dates
    const uniqueDates = new Set();
    for (const tx of newTxs) {
      const dateKey = getDateKey(parseInt(tx.timeStamp));
      uniqueDates.add(dateKey);
    }
    
    // Fetch prices for unique dates
    console.log(`  Fetching prices for ${uniqueDates.size} unique dates...`);
    const datePriceMapEUR = new Map();
    const datePriceMapUSD = new Map();
    
    for (const dateKey of uniqueDates) {
      const [year, month, day] = dateKey.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      const timestamp = Math.floor(date.getTime() / 1000);
      
      try {
        const priceEUR = await getEthPriceAtTimestamp(timestamp, 'EUR', coingeckoApiKey);
        datePriceMapEUR.set(dateKey, priceEUR);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        
        const priceUSD = await getEthPriceAtTimestamp(timestamp, 'USD', coingeckoApiKey);
        datePriceMapUSD.set(dateKey, priceUSD);
        await new Promise((resolve) => setTimeout(resolve, 2100));
      } catch (error) {
        console.error(`  Failed to fetch prices for ${dateKey}:`, error.message);
        datePriceMapEUR.set(dateKey, 0);
        datePriceMapUSD.set(dateKey, 0);
      }
    }
    
    // Process transactions
    const processedTxs = [];
    for (const tx of newTxs) {
      const timestamp = parseInt(tx.timeStamp) * 1000;
      const date = new Date(timestamp);
      const dateKey = getDateKey(parseInt(tx.timeStamp));
      
      const rawValue = parseFloat(tx.value);
      const ethAmount = tx.rewardType === 'CL' ? rawValue / 1e9 : rawValue / 1e18;
      const ethPriceEUR = datePriceMapEUR.get(dateKey) || 0;
      const ethPriceUSD = datePriceMapUSD.get(dateKey) || 0;
      const taxesInEth = ethAmount * (tracker.taxRate / 100);
      
      processedTxs.push({
        date: date.toLocaleDateString('en-GB', { timeZone: 'Europe/Zagreb' }),
        time: date.toLocaleTimeString('en-GB', { timeZone: 'Europe/Zagreb', hour12: false }),
        ethAmount,
        ethPriceEUR,
        ethPriceUSD,
        taxRate: tracker.taxRate,
        taxesInEth,
        transactionHash: tx.hash,
        status: 'Unpaid',
        timestamp: parseInt(tx.timeStamp),
        rewardType: tx.rewardType || 'EVM',
      });
    }
    
    // Save to Firestore
    const batch = db.batch();
    for (const tx of processedTxs) {
      const txRef = db.collection(`users/${uid}/trackers/${tracker.id}/transactions`).doc(tx.transactionHash);
      batch.set(txRef, {
        date: tx.date,
        time: tx.time,
        ethAmount: tx.ethAmount,
        ethPriceEUR: tx.ethPriceEUR,
        ethPriceUSD: tx.ethPriceUSD,
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
 * Main function
 */
async function main() {
  console.log('Starting daily sync...');
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  
  if (!coingeckoApiKey) {
    console.warn('Warning: COINGECKO_API_KEY not set, price fetching may fail');
  }
  
  try {
    const trackersMap = await getAllTrackers();
    console.log(`Found ${trackersMap.size} users with trackers`);
    
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

