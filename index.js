import fetch from "node-fetch";
import fs from "fs";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const ETH_ADDRESS = "0x3A647735800601dFCa9a9709DE9122EB7b311E64";
const CSV_FILE = "rewards.csv";

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

async function getTransactions() {
  // Get both regular and internal transactions
  const [regularTxs, internalTxs] = await Promise.all([
    getRegularTransactions(),
    getInternalTransactions()
  ]);
  
  return [...regularTxs, ...internalTxs].sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));
}

async function getRegularTransactions() {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${ETH_ADDRESS}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.result) {
    throw new Error(`Etherscan API error: ${data.message || 'Unknown error'}`);
  }
  
  // Filter for incoming transactions only (where our address is the recipient)
  return data.result.filter(tx => 
    tx.to.toLowerCase() === ETH_ADDRESS.toLowerCase() && 
    parseFloat(tx.value) > 0 &&
    tx.isError === '0' // Only successful transactions
  );
}

async function getInternalTransactions() {
  const url = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${ETH_ADDRESS}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.result) {
    console.log("No internal transactions found or API error");
    return [];
  }
  
  // Filter for incoming internal transactions only
  return data.result.filter(tx => 
    tx.to.toLowerCase() === ETH_ADDRESS.toLowerCase() && 
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

async function main() {
  try {
    console.log("Fetching transactions...");
    const txs = await getTransactions();
    console.log(`Found ${txs.length} incoming transactions`);
    
    // Read existing CSV rows (if file exists)
    let existingRows = new Set();
    if (fs.existsSync(CSV_FILE)) {
      const content = fs.readFileSync(CSV_FILE, "utf8").split("\n").slice(1); // skip header
      for (const line of content) {
        if (line.trim().length > 0 && !line.includes("DAILY TOTAL")) {
          existingRows.add(line.split(",")[0].replace(/"/g, "")); // store date as unique key, remove quotes
        }
      }
      console.log(`Found ${existingRows.size} existing entries`);
    }
    
    let rows = [];
    let processedCount = 0;
    const TAX_RATE = 0.24; // 24% tax rate
    
    // Group transactions by date for daily summaries
    let dailyTotals = new Map();
    
    for (const tx of txs) {
      const amountEth = parseFloat(tx.value) / 1e18;
      const timestamp = parseInt(tx.timeStamp);
      const date = new Date(timestamp * 1000);
      const dateFormatted = formatDate(date);
      const dateOnly = dateFormatted.split(' ')[0]; // Get just the date part (DD/MM/YYYY)
      
      if (!existingRows.has(dateFormatted)) {
        console.log(`Processing transaction from ${dateFormatted}...`);
        
        const priceEur = await getPriceAt(timestamp);
        
        if (priceEur === null) {
          console.log(`Skipping transaction from ${dateFormatted} due to price fetch error`);
          continue;
        }
        
        const totalValueEur = amountEth * priceEur;
        const ethForTaxes = amountEth * TAX_RATE;
        const taxesInEur = totalValueEur * TAX_RATE;
        
        // Create individual transaction row
        const csvRow = `"${dateFormatted}","${amountEth.toFixed(6)}","${priceEur.toFixed(2)}","${totalValueEur.toFixed(2)}","24%","${ethForTaxes.toFixed(6)}","${taxesInEur.toFixed(2)}"`;
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
    }
    
    // Create CSV file with new header structure if it doesn't exist
    if (!fs.existsSync(CSV_FILE)) {
      fs.writeFileSync(CSV_FILE, "Date,ETH Rewards,ETH Price (EURO),ETH Rewards in EURO,Income Tax Rate,ETH for Taxes,Taxes in EURO\n");
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
      
      // Add rows and daily summaries
      for (const [dateOnly, dateRows] of dateGroups) {
        // Add all transactions for this date
        sortedRows.push(...dateRows);
        
        // Add daily summary row if there are totals for this date
        if (dailyTotals.has(dateOnly)) {
          const dayTotal = dailyTotals.get(dateOnly);
          const summaryRow = `"${dateOnly} - DAILY TOTAL","${dayTotal.totalEth.toFixed(6)}","","${dayTotal.totalValueEur.toFixed(2)}","24%","${dayTotal.totalEthForTaxes.toFixed(6)}","${dayTotal.totalTaxesEur.toFixed(2)}"`;
          sortedRows.push(summaryRow);
        }
      }
      
      fs.appendFileSync(CSV_FILE, sortedRows.join("\n") + "\n");
      console.log(`✅ Added ${rows.length} new transactions with daily summaries`);
    } else {
      console.log("ℹ️ No new transactions found");
    }
    
    // Log summary
    const totalRows = existingRows.size + rows.length;
    console.log(`📊 Total entries in CSV: ${totalRows}`);
    
  } catch (error) {
    console.error("Error in main function:", error);
    process.exit(1);
  }
}

main();
