import fetch from "node-fetch";
import fs from "fs";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const ETH_ADDRESS = "0x829C0F59FF906fd617F84f6790AF18f440D0C108";
const CSV_FILE = "rewards.csv";

function formatDate(date) {
  return date.toLocaleString("en-GB", { timeZone: "Europe/Zagreb" });
}

async function getTransactions() {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${ETH_ADDRESS}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result.filter(tx => tx.to.toLowerCase() === ETH_ADDRESS.toLowerCase());
}





async function getPriceAt(date) {
  const url = `https://pro-api.coingecko.com/api/v3/coins/ethereum/history?date=${date}&localization=false`;

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-cg-pro-api-key": process.env.COINGECKO_API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`CoinGecko API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (!data.market_data || !data.market_data.current_price) {
    console.error("DEBUG CoinGecko response:", JSON.stringify(data, null, 2));
    throw new Error("Missing market_data in CoinGecko response");
  }

  return data.market_data.current_price.eur;
}








async function main() {
  const txs = await getTransactions();

  // Read existing CSV rows (if file exists)
  let existingRows = new Set();
  if (fs.existsSync(CSV_FILE)) {
    const content = fs.readFileSync(CSV_FILE, "utf8").split("\n").slice(1); // skip header
    for (const line of content) {
      if (line.trim().length > 0) {
        existingRows.add(line.split(",")[0]); // store date as unique key
      }
    }
  }

  let rows = [];

  for (const tx of txs) {
    const amountEth = parseFloat(tx.value) / 1e18;
    const timestamp = parseInt(tx.timeStamp);
    const date = new Date(timestamp * 1000);
    const dateFormatted = formatDate(date);

    if (!existingRows.has(dateFormatted)) {
      const priceEur = await getPriceAt(timestamp);
      const totalValue = (amountEth * priceEur).toFixed(2);
      rows.push(`${dateFormatted},${amountEth.toFixed(6)},${priceEur},${totalValue}`);
    }
  }

  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, "Date,Amount ETH,ETH Price (EUR),Value (EUR)\n");
  }

  if (rows.length > 0) {
    fs.appendFileSync(CSV_FILE, rows.join("\n") + "\n");
    console.log(`✅ Added ${rows.length} new transactions`);
  } else {
    console.log("ℹ️ No new transactions found");
  }
}

main();
