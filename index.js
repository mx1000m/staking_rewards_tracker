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
    address: "0xc858Db9Fd379d21B49B2216e8bFC6588bE3354D7",
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
  
  // Combine and filter for today's transactions only
  const allTxs = [...regularTxs, ...internalTxs];
  const todaysTxs = allTxs.filter(tx => isToday(parseInt(tx.timeStamp)));
  
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
          const dateField = columns[0]?.replace(/"/g, '');
          
          // Only collect actual transaction hashes, not daily totals
          if (txHash && txHash !== 'Transaction Hash' && !dateField.includes("DAILY TOTAL")) {
            existingTxHashes.add(txHash);
          }
        }
      }
    }
  }
  
  return existingTxHashes;
}

function hasExistingDailyTotal(csvFile, dateOnly) {
  if (!fs.existsSync(csvFile)) {
    return false;
  }
  
  const content = fs.readFileSync(csvFile, "utf8");
  const searchPattern = `"${dateOnly} - DAILY TOTAL"`;
  return content.includes(searchPattern);
}

async function processAddress(config) {
  const { address, csvFile, name } = config;
  
  console.log(`\n🔄 Processing ${name} (${address}) for today's transactions...`);
  
  try {
    const todaysTxs = await getTodaysTransactions(address);
    console.log(`Found ${todaysTxs.length} transactions today for ${name}`);
    
    if (todaysTxs.length === 0) {
      console.log(`ℹ️ No transactions found today for ${name}`);
      return {
        name,
        address,
        newTransactions: 0,
        totalTransactions: 0
      };
    }
    
    // Get existing transaction hashes to avoid duplicates
    const existingTxHashes = getExistingTransactionHashes(csvFile);
    console.log(`Found ${existingTxHashes.size} existing transaction hashes for ${name}`);
    
    // Filter out transactions we've already processed
    const newTxs = todaysTxs.filter(tx => !existingTxHashes.has(tx.hash));
    console.log(`Found ${newTxs.length} new transactions today for ${name}`);
    
    if (newTxs.length === 0) {
      console.log(`ℹ️ No new transactions to process for ${name} today`);
      return {
        name,
        address,
        newTransactions: 0,
        totalTransactions: existingTxHashes.size
      };
    }
    
    // Create CSV file with header if it doesn't exist
    if (!fs.existsSync(csvFile)) {
      fs.writeFileSync(csvFile, "Date,ETH Rewards,ETH Price (EURO),ETH Rewards in EURO,Income Tax Rate,ETH for Taxes,Taxes in EURO,Transaction Hash\n");
    }
    
    const TAX_RATE = 0.24; // 24% tax rate
    let rows = [];
    let dailyTotal = {
      totalEth: 0,
      totalValueEur: 0,
      totalEthForTaxes: 0,
      totalTaxesEur: 0,
      count: 0
    };
    
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
      const csvRow = `"${dateFormatted}","${amountEth.toFixed(6)}","${priceEur.toFixed(2)}","${totalValueEur.toFixed(2)}","24%","${ethForTaxes.toFixed(6)}","${taxesInEur.toFixed(2)}","${tx.hash}"`;
      rows.push(csvRow);
      
      // Add to daily total
      dailyTotal.totalEth += amountEth;
      dailyTotal.totalValueEur += totalValueEur;
      dailyTotal.totalEthForTaxes += ethForTaxes;
      dailyTotal.totalTaxesEur += taxesInEur;
      dailyTotal.count += 1;
      
      console.log(`Processed transaction: ${amountEth.toFixed(6)} ETH @ €${priceEur.toFixed(2)} = €${totalValueEur.toFixed(2)}`);
      
      // Small delay between price fetches to be respectful to the API
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
    }
    
    // Add daily total if we have transactions and don't already have a daily total for today
    const todayDateOnly = getDateOnly(new Date());
    if (dailyTotal.count > 0 && !hasExistingDailyTotal(csvFile, todayDateOnly)) {
      const summaryRow = `"${todayDateOnly} - DAILY TOTAL","${dailyTotal.totalEth.toFixed(6)}","","${dailyTotal.totalValueEur.toFixed(2)}","24%","${dailyTotal.totalEthForTaxes.toFixed(6)}","${dailyTotal.totalTaxesEur.toFixed(2)}",""`;
      rows.push(summaryRow);
      console.log(`Added daily total: ${dailyTotal.totalEth.toFixed(6)} ETH = €${dailyTotal.totalValueEur.toFixed(2)}`);
    }
    
    // Write all rows to CSV
    if (rows.length > 0) {
      fs.appendFileSync(csvFile, rows.join("\n") + "\n");
      console.log(`✅ Added ${newTxs.length} new transactions with daily summary for ${name}`);
    }
    
    return {
      name,
      address,
      newTransactions: newTxs.length,
      totalTransactions: existingTxHashes.size + newTxs.length,
      todayTotal: dailyTotal
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
        const dailyRewardsText = result.todayTotal ? `€${result.todayTotal.totalValueEur.toFixed(2)}` : "€0.00";
        statusText += `${result.newTransactions} new transactions - Today's rewards: ${dailyRewardsText}`;
        totalDailyRewards += result.todayTotal ? result.todayTotal.totalValueEur : 0;
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
