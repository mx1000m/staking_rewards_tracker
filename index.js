import fetch from "node-fetch";
import fs from "fs";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

// Configuration for multiple addresses
const ADDRESSES_CONFIG = [
  {
    address: "0x3A647735800601dFCa9a9709DE9122EB7b311E64",
    csvFile: "RewardsNode1.csv",
    name: "Node1"
  },
  {
    address: "0x3fc2e5D10fa56CC17A66088987130991A2430aC7",
    csvFile: "RewardsNode2.csv",
    name: "Node2"
  }
];

function formatDate(date) {
  return date.toLocaleString("en-GB", { timeZone: "Europe/Zagreb" });
}

function formatDateForCoinGecko(date) {
  // CoinGecko expects DD-MM-YYYY format
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function getDateOnly(date) {
  // Get date in DD/MM/YYYY format (Zagreb timezone)
  return date.toLocaleDateString("en-GB", { timeZone: "Europe/Zagreb" });
}

function isToday(timestamp) {
  const txDate = new Date(timestamp * 1000);
  const today = new Date();
  
  // Get both dates in Zagreb timezone and compare only the date part
  const txDateOnly = getDateOnly(txDate);
  const todayOnly = getDateOnly(today);
  
  return txDateOnly === todayOnly;
}

async function getTodaysTransactions(ethAddress) {
  console.log(`Getting today's transactions for ${ethAddress}...`);
  
  // Get both regular and internal transactions
  const [regularTxs, internalTxs] = await Promise.all([
    getRegularTransactions(ethAddress),
    getInternalTransactions(ethAddress)
  ]);
  
  // Combine all transactions
  const allTxs = [...regularTxs, ...internalTxs];
  console.log(`Found ${allTxs.length} total incoming transactions for ${ethAddress}`);
  
  // Debug: Show the most recent transactions
  if (allTxs.length > 0) {
    const sortedTxs = allTxs.sort((a, b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
    console.log(`Most recent transactions for ${ethAddress}:`);
    for (let i = 0; i < Math.min(3, sortedTxs.length); i++) {
      const tx = sortedTxs[i];
      const date = new Date(parseInt(tx.timeStamp) * 1000);
      const dateFormatted = formatDate(date);
      const dateOnly = getDateOnly(date);
      const amountEth = (parseFloat(tx.value) / 1e18).toFixed(6);
      console.log(`  ${i + 1}. ${dateFormatted} (${dateOnly}) - ${amountEth} ETH - Hash: ${tx.hash}`);
    }
  }
  
  // Filter for today's transactions only
  const today = new Date();
  const todayOnly = getDateOnly(today);
  console.log(`Today's date (Zagreb timezone): ${todayOnly}`);
  
  const todaysTxs = allTxs.filter(tx => {
    const txTimestamp = parseInt(tx.timeStamp);
    const isTodayTx = isToday(txTimestamp);
    
    if (isTodayTx) {
      const txDate = new Date(txTimestamp * 1000);
      const txDateFormatted = formatDate(txDate);
      console.log(`Found today's transaction: ${txDateFormatted}`);
    }
    
    return isTodayTx;
  });
  
  console.log(`Found ${todaysTxs.length} transactions for today`);
  
  // Sort by timestamp
  return todaysTxs.sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));
}

async function getRegularTransactions(ethAddress) {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${ethAddress}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.result) {
    throw new Error(`Etherscan API error: ${data.message || 'Unknown error'}`);
  }
  
  // Filter for incoming transactions only (where our address is the recipient)
  return data.result.filter(tx => 
    tx.to.toLowerCase() === ethAddress.toLowerCase() && 
    parseFloat(tx.value) > 0 &&
    tx.isError === '0' // Only successful transactions
  );
}

async function getInternalTransactions(ethAddress) {
  const url = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${ethAddress}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.result) {
    console.log(`No internal transactions found for ${ethAddress} or API error`);
    return [];
  }
  
  // Filter for incoming internal transactions only
  return data.result.filter(tx => 
    tx.to.toLowerCase() === ethAddress.toLowerCase() && 
    parseFloat(tx.value) > 0 &&
    tx.isError === '0' // Only successful transactions
  );
}

async function getCurrentPrice() {
  // Get current ETH price in EUR
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur`;
  
  const headers = {
    accept: "application/json"
  };
  
  // Only add API key header if it exists
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  }
  
  const res = await fetch(url, { headers });
  
  if (!res.ok) {
    console.error(`CoinGecko API error: ${res.status} ${res.statusText}`);
    
    if (res.status === 401) {
      console.error("Authentication failed - check your Demo API key");
    } else if (res.status === 429) {
      console.log("Rate limited, waiting 60 seconds...");
      await new Promise(resolve => setTimeout(resolve, 60000));
      // Retry once after rate limit
      return getCurrentPrice();
    }
    throw new Error(`Failed to fetch current ETH price: ${res.status} ${res.statusText}`);
  }
  
  const data = await res.json();
  
  if (!data.ethereum || !data.ethereum.eur) {
    console.error("Missing price data in response:", JSON.stringify(data, null, 2));
    throw new Error("Missing EUR price data from CoinGecko");
  }
  
  return data.ethereum.eur;
}

async function getPriceAt(timestamp) {
  const date = new Date(timestamp * 1000);
  const dateString = formatDateForCoinGecko(date);
  
  // Use historical price API endpoint
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  
  const headers = {
    accept: "application/json"
  };
  
  // Only add API key header if it exists
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  }
  
  const res = await fetch(url, { headers });
  
  if (!res.ok) {
    console.error(`CoinGecko API error for date ${dateString}: ${res.status} ${res.statusText}`);
    
    if (res.status === 401) {
      console.error("Authentication failed - check your Demo API key");
    } else if (res.status === 429) {
      console.log("Rate limited, waiting 60 seconds...");
      await new Promise(resolve => setTimeout(resolve, 60000));
      // Retry once after rate limit
      return getPriceAt(timestamp);
    }
    throw new Error(`Failed to fetch ETH price for ${dateString}: ${res.status} ${res.statusText}`);
  }
  
  const data = await res.json();
  
  if (!data.market_data || !data.market_data.current_price || !data.market_data.current_price.eur) {
    console.error(`Missing price data for date ${dateString}`);
    console.error("DEBUG CoinGecko response:", JSON.stringify(data, null, 2));
    throw new Error(`Missing EUR price data for ${dateString}`);
  }
  
  return data.market_data.current_price.eur;
}

function getExistingTransactionHashes(csvFile) {
  const existingTxHashes = new Set();
  
  if (fs.existsSync(csvFile)) {
    const content = fs.readFileSync(csvFile, "utf8").split("\n").slice(1); // skip header
    for (const line of content) {
      if (line.trim().length > 0) {
        const columns = line.split('","');
        if (columns.length >= 8) { // Make sure we have the hash column
          const txHash = columns[7]?.replace(/"/g, ''); // Remove quotes from hash
          
          // Collect transaction hashes (no more daily totals to filter out)
          if (txHash && txHash !== 'Transaction Hash') {
            existingTxHashes.add(txHash);
          }
        }
      }
    }
  }
  
  return existingTxHashes;
}

async function processAddress(config) {
  const { address, csvFile, name } = config;
  
  console.log(`\n🔄 Processing ${name} (${address}) for today's transactions...`);
  
  try {
    // Create CSV file with header if it doesn't exist (do this first)
    if (!fs.existsSync(csvFile)) {
      console.log(`Creating new CSV file: ${csvFile}`);
      fs.writeFileSync(csvFile, "Date,ETH Rewards,ETH Price (EURO),ETH Rewards in EURO,Income Tax Rate,ETH for Taxes,Taxes in EURO,Transaction Hash,Tax Status,Tax Transaction Hash\n");
    } else {
      console.log(`CSV file ${csvFile} already exists`);
    }
    
    const todaysTxs = await getTodaysTransactions(address);
    console.log(`Found ${todaysTxs.length} transactions today for ${name}`);
    
    // Get existing transaction hashes to avoid duplicates
    const existingTxHashes = getExistingTransactionHashes(csvFile);
    console.log(`Found ${existingTxHashes.size} existing transaction hashes for ${name}`);
    
    // Filter out transactions we've already processed
    const newTxs = todaysTxs.filter(tx => !existingTxHashes.has(tx.hash));
    console.log(`Found ${newTxs.length} new transactions today for ${name}`);
    
    const todayDateOnly = getDateOnly(new Date());
    
    if (newTxs.length === 0) {
      console.log(`ℹ️ No new transactions to process for ${name} today`);
      
      return {
        name,
        address,
        newTransactions: 0,
        totalTransactions: existingTxHashes.size,
        addedZeroRecord: false
      };
    }
    
    const TAX_RATE = 0.24; // 24% tax rate
    let rows = [];
    
    // Process each new transaction with its specific timestamp price
    for (const tx of newTxs) {
      const amountEth = parseFloat(tx.value) / 1e18;
      const timestamp = parseInt(tx.timeStamp);
      const date = new Date(timestamp * 1000);
      const dateFormatted = formatDate(date);
      
      console.log(`Fetching ETH price for transaction at ${dateFormatted}...`);
      const priceEur = await getPriceAt(timestamp);
      
      const totalValueEur = amountEth * priceEur;
      const ethForTaxes = amountEth * TAX_RATE;
      const taxesInEur = totalValueEur * TAX_RATE;
      
      // Create individual transaction row
      const csvRow = `"${dateFormatted}","${amountEth.toFixed(6)}","${priceEur.toFixed(2)}","${totalValueEur.toFixed(2)}","24%","${ethForTaxes.toFixed(6)}","${taxesInEur.toFixed(2)}","${tx.hash}","Unpaid",""`;
      rows.push(csvRow);
      
      console.log(`Processed transaction: ${amountEth.toFixed(6)} ETH @ €${priceEur.toFixed(2)} = €${totalValueEur.toFixed(2)}`);
      
      // Small delay between price fetches to be respectful to the API
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
    }
    
    // Write all transaction rows to CSV (no daily totals)
    if (rows.length > 0) {
      fs.appendFileSync(csvFile, rows.join("\n") + "\n");
      console.log(`✅ Added ${newTxs.length} new transactions for ${name}`);
    }
    
    return {
      name,
      address,
      newTransactions: newTxs.length,
      totalTransactions: existingTxHashes.size + newTxs.length
    };
    
  } catch (error) {
    console.error(`Error processing ${name} (${address}):`, error);
    return {
      name,
      address,
      error: error.message,
      newTransactions: 0,
      totalTransactions: 0
    };
  }
}

async function main() {
  const today = getDateOnly(new Date());
  console.log(`🚀 Starting daily ETH tracker for ${today} (Zagreb time)...`);
  console.log(`📍 Tracking ${ADDRESSES_CONFIG.length} addresses`);
  
  const results = [];
  
  for (const config of ADDRESSES_CONFIG) {
    const result = await processAddress(config);
    results.push(result);
    
    // Small delay between addresses
    if (config !== ADDRESSES_CONFIG[ADDRESSES_CONFIG.length - 1]) {
      console.log("⏳ Brief pause before next address...");
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
    }
  }
  
  // Final summary
  console.log(`\n📊 DAILY SUMMARY FOR ${today}:`);
  console.log("=" * 60);
  
  let totalNewTransactions = 0;
  let totalAllTransactions = 0;
  let totalDailyRewards = 0;
  
  for (const result of results) {
    if (result.error) {
      console.log(`❌ ${result.name}: ERROR - ${result.error}`);
    } else {
      let statusText = `✅ ${result.name}: `;
      
      if (result.addedZeroRecord) {
        statusText += `0 transactions (added 0 ETH record)`;
      } else if (result.newTransactions === 0) {
        statusText += `0 transactions (record already exists)`;
      } else {
        statusText += `${result.newTransactions} new transactions`;
        totalDailyRewards += result.newTransactions; // Count transactions instead of EUR value
      }
      
      statusText += ` - Total: ${result.totalTransactions} records`;
      console.log(statusText);
      
      totalNewTransactions += result.newTransactions;
      totalAllTransactions += result.totalTransactions;
    }
  }
  
  console.log("=" * 60);
  console.log(`🎯 GRAND TOTAL: ${totalNewTransactions} new transactions today`);
  console.log(`📈 Combined total transactions across all addresses: ${totalAllTransactions}`);
}

main().catch(error => {
  console.error("Fatal error in main function:", error);
  process.exit(1);
});
