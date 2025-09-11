import fetch from "node-fetch";
import fs from "fs";

// Configuration for multiple nodes
const NODES = {
  node1: {
    address: "0x3A647735800601dFCa9a9709DE9122EB7b311E64",
    csvFile: "rewards_node1.csv",
    name: "Node 1"
  },
  node2: {
    address: "0xc858Db9Fd379d21B49B2216e8bFC6588bE3354D7",
    csvFile: "rewards_node2.csv", 
    name: "Node 2"
  }
  // Add more nodes as needed
};

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const COMBINED_REPORT_FILE = "combined_daily_report.csv";

function formatDate(date) {
  return date.toLocaleString("en-GB", { timeZone: "Europe/Zagreb" });
}

function formatDateForCoinGecko(date) {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

async function getTransactions(address) {
  const [regularTxs, internalTxs] = await Promise.all([
    getRegularTransactions(address),
    getInternalTransactions(address)
  ]);
  
  return [...regularTxs, ...internalTxs].sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));
}

async function getRegularTransactions(address) {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.result) {
    throw new Error(`Etherscan API error: ${data.message || 'Unknown error'}`);
  }
  
  return data.result.filter(tx => 
    tx.to.toLowerCase() === address.toLowerCase() && 
    parseFloat(tx.value) > 0 &&
    tx.isError === '0'
  );
}

async function getInternalTransactions(address) {
  const url = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.result) {
    console.log(`No internal transactions found for ${address}`);
    return [];
  }
  
  return data.result.filter(tx => 
    tx.to.toLowerCase() === address.toLowerCase() && 
    parseFloat(tx.value) > 0 &&
    tx.isError === '0'
  );
}

async function getPriceAt(timestamp) {
  const date = new Date(timestamp * 1000);
  const dateString = formatDateForCoinGecko(date);
  
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateString}&localization=false`;
  
  const headers = { accept: "application/json" };
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  }
  
  const res = await fetch(url, { headers });
  
  if (!res.ok) {
    console.error(`CoinGecko API error for date ${dateString}: ${res.status} ${res.statusText}`);
    if (res.status === 429) {
      console.log("Rate limited, waiting 60 seconds...");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    return null;
  }
  
  const data = await res.json();
  
  if (!data.market_data?.current_price?.eur) {
    console.error(`Missing price data for date ${dateString}`);
    return null;
  }
  
  return data.market_data.current_price.eur;
}





async function processNodeTransactions(nodeId, nodeConfig) {
  console.log(`\n🔄 Processing ${nodeConfig.name} (${nodeConfig.address})...`);
  
  try {
    // Always create the CSV file first, even if empty
    if (!fs.existsSync(nodeConfig.csvFile)) {
      fs.writeFileSync(nodeConfig.csvFile, "Date,ETH Rewards,ETH Price (EURO),ETH Rewards in EURO,Income Tax Rate,ETH for Taxes,Taxes in EURO,Transaction Hash,Node\n");
      console.log(`✅ Created CSV file for ${nodeConfig.name}`);
    }
    
    const txs = await getTransactions(nodeConfig.address);
    console.log(`Found ${txs.length} incoming transactions for ${nodeConfig.name}`);
    
    if (txs.length === 0) {
      console.log(`ℹ️ No transactions found for ${nodeConfig.name} - CSV file already created with headers`);
      return { processedCount: 0, dailyTotals: new Map() };
    }
    
    // Read existing transaction hashes
    let existingTxHashes = new Set();
    let existingDailyTotals = new Set();
    
    const content = fs.readFileSync(nodeConfig.csvFile, "utf8").split("\n").slice(1);
    for (const line of content) {
      if (line.trim().length > 0) {
        const columns = line.split('","');
        if (columns.length >= 8) {
          const txHash = columns[7]?.replace(/"/g, '');
          const dateField = columns[0]?.replace(/"/g, '');
          
          if (dateField?.includes("DAILY TOTAL")) {
            existingDailyTotals.add(dateField.split(' - ')[0]);
          } else if (txHash && txHash !== 'Transaction Hash') {
            existingTxHashes.add(txHash);
          }
        }
      }
    }
    console.log(`Found ${existingTxHashes.size} existing transaction hashes for ${nodeConfig.name}`);
    
    let rows = [];
    let processedCount = 0;
    const TAX_RATE = 0.24;
    let dailyTotals = new Map();
    
    for (const tx of txs) {
      if (existingTxHashes.has(tx.hash)) continue;
      
      const amountEth = parseFloat(tx.value) / 1e18;
      const timestamp = parseInt(tx.timeStamp);
      const date = new Date(timestamp * 1000);
      const dateFormatted = formatDate(date);
      const dateOnly = dateFormatted.split(' ')[0];
      
      console.log(`Processing new transaction ${tx.hash} from ${dateFormatted} for ${nodeConfig.name}...`);
      
      const priceEur = await getPriceAt(timestamp);
      if (priceEur === null) {
        console.log(`⚠️ Skipping transaction ${tx.hash} for ${nodeConfig.name} due to price fetch error`);
        continue;
      }
      
      const totalValueEur = amountEth * priceEur;
      const ethForTaxes = amountEth * TAX_RATE;
      const taxesInEur = totalValueEur * TAX_RATE;
      
      const csvRow = `"${dateFormatted}","${amountEth.toFixed(6)}","${priceEur.toFixed(2)}","${totalValueEur.toFixed(2)}","24%","${ethForTaxes.toFixed(6)}","${taxesInEur.toFixed(2)}","${tx.hash}","${nodeConfig.name}"`;
      rows.push(csvRow);
      
      // Track daily totals
      if (!dailyTotals.has(dateOnly)) {
        dailyTotals.set(dateOnly, {
          totalEth: 0, totalValueEur: 0, totalEthForTaxes: 0, totalTaxesEur: 0, count: 0
        });
      }
      
      const dayTotal = dailyTotals.get(dateOnly);
      dayTotal.totalEth += amountEth;
      dayTotal.totalValueEur += totalValueEur;
      dayTotal.totalEthForTaxes += ethForTaxes;
      dayTotal.totalTaxesEur += taxesInEur;
      dayTotal.count += 1;
      
      processedCount++;
      
      if (processedCount % 5 === 0) {
        console.log("Pausing to respect rate limits...");
        await new Promise(resolve => setTimeout(resolve, 12000));
      }
    }
    
    if (rows.length > 0) {
      const sortedRows = [];
      const dateGroups = new Map();
      
      for (const row of rows) {
        const dateOnly = row.split('","')[0].replace('"', '').split(' ')[0];
        if (!dateGroups.has(dateOnly)) {
          dateGroups.set(dateOnly, []);
        }
        dateGroups.get(dateOnly).push(row);
      }
      
      for (const [dateOnly, dateRows] of dateGroups) {
        sortedRows.push(...dateRows);
        
        if (dailyTotals.has(dateOnly) && !existingDailyTotals.has(dateOnly)) {
          const dayTotal = dailyTotals.get(dateOnly);
          const summaryRow = `"${dateOnly} - DAILY TOTAL","${dayTotal.totalEth.toFixed(6)}","","${dayTotal.totalValueEur.toFixed(2)}","24%","${dayTotal.totalEthForTaxes.toFixed(6)}","${dayTotal.totalTaxesEur.toFixed(2)}","","${nodeConfig.name}"`;
          sortedRows.push(summaryRow);
        }
      }
      
      fs.appendFileSync(nodeConfig.csvFile, sortedRows.join("\n") + "\n");
      console.log(`✅ Added ${rows.length} new transactions for ${nodeConfig.name}`);
    } else {
      console.log(`ℹ️ No new transactions found for ${nodeConfig.name}, but CSV file exists with headers`);
    }
    
    return { processedCount: rows.length, dailyTotals };
    
  } catch (error) {
    console.error(`❌ Error processing ${nodeConfig.name}:`, error);
    
    // Make sure CSV file exists even on error
    if (!fs.existsSync(nodeConfig.csvFile)) {
      fs.writeFileSync(nodeConfig.csvFile, "Date,ETH Rewards,ETH Price (EURO),ETH Rewards in EURO,Income Tax Rate,ETH for Taxes,Taxes in EURO,Transaction Hash,Node\n");
      console.log(`✅ Created empty CSV file for ${nodeConfig.name} after error`);
    }
    
    throw error; // Re-throw to maintain error handling in main function
  }
}






function generateCombinedDailyReport() {
  console.log("\n📊 Generating combined daily report...");
  
  const allDailyData = new Map(); // date -> { node1: data, node2: data }
  
  // Read data from each node's CSV
  for (const [nodeId, nodeConfig] of Object.entries(NODES)) {
    if (!fs.existsSync(nodeConfig.csvFile)) {
      console.log(`⚠️ ${nodeConfig.csvFile} not found, skipping...`);
      continue;
    }
    
    const content = fs.readFileSync(nodeConfig.csvFile, "utf8").split("\n").slice(1);
    
    for (const line of content) {
      if (line.trim().length > 0 && line.includes("DAILY TOTAL")) {
        const columns = line.split('","');
        const dateOnly = columns[0]?.replace(/"/g, '').split(' - ')[0];
        const ethRewards = parseFloat(columns[1]?.replace(/"/g, '') || 0);
        const eurValue = parseFloat(columns[3]?.replace(/"/g, '') || 0);
        const ethForTaxes = parseFloat(columns[5]?.replace(/"/g, '') || 0);
        const taxesEur = parseFloat(columns[6]?.replace(/"/g, '') || 0);
        
        if (dateOnly && !isNaN(ethRewards)) {
          if (!allDailyData.has(dateOnly)) {
            allDailyData.set(dateOnly, {});
          }
          
          allDailyData.get(dateOnly)[nodeId] = {
            ethRewards, eurValue, ethForTaxes, taxesEur
          };
        }
      }
    }
  }
  
  if (allDailyData.size === 0) {
    console.log("⚠️ No daily totals found to combine");
    return;
  }
  
  // Calculate combined totals
  const reportRows = [];
  const nodeIds = Object.keys(NODES);
  
  // Create header
  let header = "Date";
  for (const nodeId of nodeIds) {
    const nodeName = NODES[nodeId].name;
    header += `,${nodeName} ETH,${nodeName} EUR,${nodeName} ETH for Taxes,${nodeName} Taxes EUR`;
  }
  header += ",Total ETH,Total EUR,Total ETH for Taxes,Total Taxes EUR";
  
  reportRows.push(header);
  
  // Sort dates and generate rows
  const sortedDates = Array.from(allDailyData.keys()).sort((a, b) => {
    try {
      const [dayA, monthA, yearA] = a.split('/').map(Number);
      const [dayB, monthB, yearB] = b.split('/').map(Number);
      return new Date(yearA, monthA - 1, dayA) - new Date(yearB, monthB - 1, dayB);
    } catch (e) {
      return a.localeCompare(b);
    }
  });
  
  for (const date of sortedDates) {
    const dayData = allDailyData.get(date);
    let row = `"${date}"`;
    
    let totalEth = 0, totalEur = 0, totalEthForTaxes = 0, totalTaxesEur = 0;
    
    // Add individual node data
    for (const nodeId of nodeIds) {
      const nodeData = dayData[nodeId] || { ethRewards: 0, eurValue: 0, ethForTaxes: 0, taxesEur: 0 };
      row += `,"${nodeData.ethRewards.toFixed(6)}","${nodeData.eurValue.toFixed(2)}","${nodeData.ethForTaxes.toFixed(6)}","${nodeData.taxesEur.toFixed(2)}"`;
      
      totalEth += nodeData.ethRewards;
      totalEur += nodeData.eurValue;
      totalEthForTaxes += nodeData.ethForTaxes;
      totalTaxesEur += nodeData.taxesEur;
    }
    
    // Add combined totals
    row += `,"${totalEth.toFixed(6)}","${totalEur.toFixed(2)}","${totalEthForTaxes.toFixed(6)}","${totalTaxesEur.toFixed(2)}"`;
    reportRows.push(row);
  }
  
  // Write combined report
  fs.writeFileSync(COMBINED_REPORT_FILE, reportRows.join("\n") + "\n");
  console.log(`✅ Combined daily report saved to ${COMBINED_REPORT_FILE}`);
  console.log(`📈 Generated report for ${sortedDates.length} days across ${nodeIds.length} nodes`);
}









async function main() {
  try {
    console.log("🚀 Starting multi-node ETH staking rewards tracker...");
    console.log(`📍 Tracking ${Object.keys(NODES).length} nodes:`);
    
    for (const [nodeId, nodeConfig] of Object.entries(NODES)) {
      console.log(`   ${nodeConfig.name}: ${nodeConfig.address}`);
    }
    
    let totalNewTransactions = 0;
    const results = {};
    
    // Process each node
    for (const [nodeId, nodeConfig] of Object.entries(NODES)) {
      try {
        const result = await processNodeTransactions(nodeId, nodeConfig);
        totalNewTransactions += result.processedCount;
        results[nodeId] = result;
      } catch (error) {
        console.error(`❌ Error processing ${nodeConfig.name}:`, error.message);
        results[nodeId] = { processedCount: 0, error: error.message };
      }
    }
    
    // Generate combined report
    try {
      generateCombinedDailyReport();
    } catch (error) {
      console.error("❌ Error generating combined report:", error.message);
    }
    
    console.log(`\n📈 Final Summary:`);
    console.log(`═══════════════════════════════════════`);
    
    for (const [nodeId, nodeConfig] of Object.entries(NODES)) {
      const result = results[nodeId];
      if (result.error) {
        console.log(`${nodeConfig.name}: ❌ Error - ${result.error}`);
      } else {
        console.log(`${nodeConfig.name}: ✅ ${result.processedCount} new transactions`);
      }
    }
    
    console.log(`═══════════════════════════════════════`);
    console.log(`Total new transactions: ${totalNewTransactions}`);
    console.log(`Files generated:`);
    
    for (const [nodeId, nodeConfig] of Object.entries(NODES)) {
      if (fs.existsSync(nodeConfig.csvFile)) {
        console.log(`  ✅ ${nodeConfig.csvFile}`);
      }
    }
    
    if (fs.existsSync(COMBINED_REPORT_FILE)) {
      console.log(`  ✅ ${COMBINED_REPORT_FILE}`);
    }
    
    console.log("🎉 Multi-node tracking completed successfully!");
    
  } catch (error) {
    console.error("💥 Fatal error in main function:", error);
    process.exit(1);
  }
}

main();
