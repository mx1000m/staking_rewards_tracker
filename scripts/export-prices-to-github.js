/**
 * Export script to migrate ETH prices from Firestore to GitHub JSON file
 * This should be run once after the populate-historical-prices migration completes
 * 
 * Usage: node scripts/export-prices-to-github.js
 * Requires: FIREBASE_SERVICE_ACCOUNT (JSON string) env var
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

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

// Path to ETH prices JSON file
const ETH_PRICES_FILE = path.join(__dirname, '..', 'data', 'eth-prices.json');

/**
 * Main function
 */
async function main() {
  console.log('Exporting ETH prices from Firestore to GitHub JSON...');
  
  try {
    // Fetch prices from Firestore
    const pricesRef = db.doc('ethPrices/daily');
    const pricesDoc = await pricesRef.get();
    
    if (!pricesDoc.exists) {
      console.log('No prices found in Firestore. Nothing to export.');
      return;
    }
    
    const firestorePrices = pricesDoc.data();
    const priceCount = Object.keys(firestorePrices).length;
    
    console.log(`Found ${priceCount} price entries in Firestore`);
    
    // Ensure data directory exists
    const dataDir = path.dirname(ETH_PRICES_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Write to JSON file with pretty formatting
    fs.writeFileSync(ETH_PRICES_FILE, JSON.stringify(firestorePrices, null, 2), 'utf8');
    
    console.log(`Successfully exported ${priceCount} price entries to ${ETH_PRICES_FILE}`);
    console.log('\nNext steps:');
    console.log('1. Review the JSON file to ensure it looks correct');
    console.log('2. Commit and push the file to GitHub:');
    console.log('   git add data/eth-prices.json');
    console.log('   git commit -m "Export ETH prices from Firestore to GitHub"');
    console.log('   git push origin main');
    console.log('3. After pushing, the frontend will automatically use GitHub prices');
  } catch (error) {
    console.error('Export failed:', error);
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

