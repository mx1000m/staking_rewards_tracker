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

async function getTransactions(ethAddress) {
  // Get both regular and internal transactions
  const [regularTxs, internalTxs] = await Promise.all([
    getRegularTransactions(ethAddress),
    getInternalTransactions(ethAddress)
  ]);
  
  return [...regularTxs, ...internalTxs].sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));
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

async function getPriceAt(timestamp) {
  const date = new Date(timestamp * 1000);
  const dateString = formatDateForCoinGecko(date);
  
  // Use free API endpoint instead of pro
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  
  const headers = {
    accept: "application/json"
  };
  
  // Only add API key header if it exists (for free tier, it might not be needed)
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY; // Free tier uses x-cg-demo-api-key
  }
  
  const res = await fetch(url, { headers });
  
  if (!res.ok) {
    console.error(`CoinGecko API error for date ${dateString}: ${res.status} ${res.statusText}`);
    
    if (res.status === 401) {
      console.error("Authentication failed - check your Demo API key");
    } else if (res.status === 429) {
      console.log("Rate limited, waiting 60 seconds...");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    return null;
  }
  
  const data = await res.json();
  
  if (!data.market_data || !data.market_data.current_price || !data.market_data.current_price.eur) {
    console.error(`Missing price data for date ${dateString}`);
    console.error("DEBUG CoinGecko response:", JSON.stringify(data, null, 2));
    return null;
  }
  
  return data.market_data.current_price.eur;
}

async function processAddress(config) {
  const { address, csvFile, name } = config;
  
  console.log(`\n🔄 Processing ${name} (${address})...`);
  
  try {
    console.log(`Fetching transactions for ${name}...`);
    const txs = await getTransactions(address);
    console.log(`Found ${txs.length} incoming transactions for ${name}`);
    
    // Read existing transaction hashes (if file exists)
    let existingTxHashes = new Set();
    let existingDailyTotals = new Set();
    
    if (fs.existsSync(csvFile)) {
      const content = fs.readFileSync(csvFile, "utf8").split("\n").slice(1); // skip header
      for (const line of content) {
        if (line.trim().length > 0) {
          const columns = line.split('","');
          if (columns.length >= 8) { // Make sure we have the hash column
            const txHash = columns[7]?.replace(/"/g, ''); // Remove quotes from hash
            const dateField = columns[0]?.replace(/"/g, '');
            
            if (dateField && dateField.includes("DAILY TOTAL")) {
              existingDailyTotals.add(dateField.split(' - ')[0]); // Store date part only
            } else if (txHash && txHash !== 'Transaction Hash') { // Skip header
              existingTxHashes.add(txHash);
            }
          }
        }
      }
      console.log(`Found ${existingTxHashes.size} existing transaction hashes for ${name}`);
      console.log(`Found ${existingDailyTotals.size} existing daily totals for ${name}`);
    }
    
    let rows = [];
    let processedCount = 0;
    const TAX_RATE = 0.24; // 24% tax rate
    
    // Group transactions by date for daily summaries
    let dailyTotals = new Map();
    
    for (const tx of txs) {
      // Skip if we already processed this transaction hash
      if (existingTxHashes.has(tx.hash)) {
        continue;
      }
      
      const amountEth = parseFloat(tx.value) / 1e18;
      const timestamp = parseInt(tx.timeStamp);
      const date = new Date(timestamp * 1000);
      const dateFormatted = formatDate(date);
      const dateOnly = dateFormatted.split(' ')[0]; // Get just the date part (DD/MM/YYYY)
      
      console.log(`Processing new transaction ${tx.hash} from ${dateFormatted} for ${name}...`);
      
      const priceEur = await getPriceAt(timestamp);
      
      if (priceEur === null) {
        console.log(`Skipping transaction ${tx.hash} from ${dateFormatted} for ${name} due to price fetch error`);
        continue;
      }
      
      const totalValueEur = amountEth * priceEur;
      const ethForTaxes = amountEth * TAX_RATE;
      const taxesInEur = totalValueEur * TAX_RATE;
      
      // Create individual transaction row with hash
      const csvRow = `"${dateFormatted}","${amountEth.toFixed(6)}","${priceEur.toFixed(2)}","${totalValueEur.toFixed(2)}","24%","${ethForTaxes.toFixed(6)}","${taxesInEur.toFixed(2)}","${tx.hash}"`;
      rows.push(csvRow);
      
      // Add to daily totals
      if (!dailyTotals.has(dateOnly)) {
        dailyTotals.set(dateOnly, {
          totalEth: 0,
          totalValueEur: 0,
          totalEthForTaxes: 0,
          totalTaxesEur: 0,
          count: 0
        });
      }
      
      const dayTotal = dailyTotals.get(dateOnly);
      dayTotal.totalEth += amountEth;
      dayTotal.totalValueEur += totalValueEur;
      dayTotal.totalEthForTaxes += ethForTaxes;
      dayTotal.totalTaxesEur += taxesInEur;
      dayTotal.count += 1;
      
      processedCount++;
      
      // Add delay between API calls to respect rate limits
      if (processedCount % 5 === 0) {
        console.log("Pausing to respect rate limits...");
        await new Promise(resolve => setTimeout(resolve, 12000)); // 12 second delay
      }
    }
    
    // Create CSV file with new header structure if it doesn't exist
    if (!fs.existsSync(csvFile)) {
      fs.writeFileSync(csvFile, "Date,ETH Rewards,ETH Price (EURO),ETH Rewards in EURO,Income Tax Rate,ETH for Taxes,Taxes in EURO,Transaction Hash\n");
    }
    
    if (rows.length > 0) {
      // Sort rows by date and add daily summary rows
      const sortedRows = [];
      const dateGroups = new Map();
      
      // Group rows by date
      for (const row of rows) {
        const dateOnly = row.split('","')[0].replace('"', '').split(' ')[0];
        if (!dateGroups.has(dateOnly)) {
          dateGroups.set(dateOnly, []);
        }
        dateGroups.get(dateOnly).push(row);
      }
      
      // Add rows and daily summaries (only for dates that don't already have them)
      for (const [dateOnly, dateRows] of dateGroups) {
        // Add all transactions for this date
        sortedRows.push(...dateRows);
        
        // Add daily summary row only if we don't already have one for this date
        if (dailyTotals.has(dateOnly) && !existingDailyTotals.has(dateOnly)) {
          const dayTotal = dailyTotals.get(dateOnly);
          const summaryRow = `"${dateOnly} - DAILY TOTAL","${dayTotal.totalEth.toFixed(6)}","","${dayTotal.totalValueEur.toFixed(2)}","24%","${dayTotal.totalEthForTaxes.toFixed(6)}","${dayTotal.totalTaxesEur.toFixed(2)}",""`;
          sortedRows.push(summaryRow);
        }
      }
      
      fs.appendFileSync(csvFile, sortedRows.join("\n") + "\n");
      console.log(`✅ Added ${rows.length} new transactions with daily summaries for ${name}`);
    } else {
      console.log(`ℹ️ No new transactions found for ${name}`);
    }
    
    // Log summary for this address
    const totalProcessed = existingTxHashes.size + rows.length;
    console.log(`📊 Total transactions processed for ${name}: ${totalProcessed}`);
    
    return {
      name,
      address,
      newTransactions: rows.length,
      totalTransactions: totalProcessed
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
  console.log("🚀 Starting multi-address ETH tracker...");
  console.log(`📍 Tracking ${ADDRESSES_CONFIG.length} addresses`);
  
  const results = [];
  
  for (const config of ADDRESSES_CONFIG) {
    const result = await processAddress(config);
    results.push(result);
    
    // Add delay between addresses to be extra careful with rate limits
    if (config !== ADDRESSES_CONFIG[ADDRESSES_CONFIG.length - 1]) {
      console.log("⏳ Waiting before processing next address...");
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay between addresses
    }
  }
  
  // Final summary
  console.log("\n📊 FINAL SUMMARY:");
  console.log("=" * 50);
  
  let totalNewTransactions = 0;
  let totalAllTransactions = 0;
  
  for (const result of results) {
    if (result.error) {
      console.log(`❌ ${result.name}: ERROR - ${result.error}`);
    } else {
      console.log(`✅ ${result.name}: ${result.newTransactions} new, ${result.totalTransactions} total transactions`);
      totalNewTransactions += result.newTransactions;
      totalAllTransactions += result.totalTransactions;
    }
  }
  
  console.log("=" * 50);
  console.log(`🎯 GRAND TOTAL: ${totalNewTransactions} new transactions, ${totalAllTransactions} total across all addresses`);
}

main().catch(error => {
  console.error("Fatal error in main function:", error);
  process.exit(1);
});
