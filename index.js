import fetch from "node-fetch";
import fs from "fs";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const ETH_ADDRESS = "0x829C0F59FF906fd617F84f6790AF18f440D0C108";
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
  
  // Demo (Beta) tier uses the regular API endpoint with x-cg-demo-api-key header
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  const headers = {
    accept: "application/json"
  };
  
  // Add Demo API key header if available
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  }
  
  console.log(`Fetching price for ${dateString}...`);
  const res = await fetch(url, { headers });
  
  if (!res.ok) {
    console.error(`CoinGecko API error for date ${dateString}: ${res.status} ${res.statusText}`);
    
    // For Demo tier, 401 usually means invalid API key or quota exceeded
    if (res.status === 401) {
      console.error("Authentication failed - check your Demo API key");
      // Try without API key as fallback
      console.log("Trying without API key as fallback...");
      const fallbackRes = await fetch(`https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`, {
        headers: { accept: "application/json" }
      });
      
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        if (fallbackData.market_data && fallbackData.market_data.current_price && fallbackData.market_data.current_price.eur) {
          console.log("Fallback successful");
          return fallbackData.market_data.current_price.eur;
        }
      }
    }
    
    if (res.status === 429) {
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
        if (line.trim().length > 0) {
          existingRows.add(line.split(",")[0]); // store date as unique key
        }
      }
      console.log(`Found ${existingRows.size} existing entries`);
    }
    
    let rows = [];
    let processedCount = 0;
    
    for (const tx of txs) {
      const amountEth = parseFloat(tx.value) / 1e18;
      const timestamp = parseInt(tx.timeStamp);
      const date = new Date(timestamp * 1000);
      const dateFormatted = formatDate(date);
      
      if (!existingRows.has(dateFormatted)) {
        console.log(`Processing transaction from ${dateFormatted}...`);
        
        const priceEur = await getPriceAt(timestamp);
        
        if (priceEur === null) {
          console.log(`Skipping transaction from ${dateFormatted} due to price fetch error`);
          continue;
        }
        
        const totalValue = (amountEth * priceEur).toFixed(2);
        rows.push(`${dateFormatted},${amountEth.toFixed(6)},${priceEur.toFixed(2)},${totalValue}`);
        
        processedCount++;
        
        // Add delay between API calls to respect rate limits (free tier allows ~10-50 calls per minute)
        if (processedCount % 5 === 0) {
          console.log("Pausing to respect rate limits...");
          await new Promise(resolve => setTimeout(resolve, 12000)); // 12 second delay
        }
      }
    }
    
    // Create CSV file with header if it doesn't exist
    if (!fs.existsSync(CSV_FILE)) {
      fs.writeFileSync(CSV_FILE, "Date,Amount ETH,ETH Price (EUR),Value (EUR)\n");
    }
    
    if (rows.length > 0) {
      fs.appendFileSync(CSV_FILE, rows.join("\n") + "\n");
      console.log(`✅ Added ${rows.length} new transactions`);
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
