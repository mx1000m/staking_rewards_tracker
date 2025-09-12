// Configuration
const CONFIG = {
    GITHUB_USERNAME: 'mx1000m', // Replace with your GitHub username
    GITHUB_REPO: 'Staking_Rewards',          // Replace with your repository name
    CSV_FILES: {
        node1: 'RewardsNode1.csv',
        node2: 'RewardsNode2.csv'
    }
};

// Global state
let currentData = {
    node1: [],
    node2: []
};
let currentTransaction = null;

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

async function initializeApp() {
    // Check if token exists
    const token = localStorage.getItem('githubToken');
    if (!token) {
        showTokenSetup();
    } else {
        hideTokenSetup();
        await loadData();
    }
}

function showTokenSetup() {
    document.getElementById('tokenSetup').style.display = 'block';
    document.getElementById('dashboard').style.display = 'none';
}

function hideTokenSetup() {
    document.getElementById('tokenSetup').style.display = 'none';
}

function saveToken() {
    const token = document.getElementById('githubToken').value.trim();
    if (!token) {
        alert('Please enter a valid GitHub token');
        return;
    }
    
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
        alert('Please enter a valid GitHub token (should start with ghp_ or github_pat_)');
        return;
    }
    
    localStorage.setItem('githubToken', token);
    hideTokenSetup();
    loadData();
}

async function loadData() {
    showLoading();
    try {
        // Load both CSV files
        const [node1Data, node2Data] = await Promise.all([
            loadCSVData('node1'),
            loadCSVData('node2')
        ]);
        
        currentData.node1 = node1Data;
        currentData.node2 = node2Data;
        
        updateDashboard();
        hideLoading();
        
    } catch (error) {
        console.error('Error loading data:', error);
        alert('Error loading data. Please check your GitHub token and repository settings.');
        hideLoading();
    }
}

async function loadCSVData(nodeKey) {
    const csvFile = CONFIG.CSV_FILES[nodeKey];
    const url = `https://raw.githubusercontent.com/${CONFIG.GITHUB_USERNAME}/${CONFIG.GITHUB_REPO}/main/${csvFile}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${csvFile}: ${response.status}`);
        }
        
        const csvText = await response.text();
        return parseCSV(csvText);
    } catch (error) {
        console.warn(`Could not load ${csvFile}:`, error);
        return [];
    }
}

function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length <= 1) return [];
    
    const headers = lines[0].split(',').map(h => h.replace(/"/g, ''));
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse CSV line handling quoted values
        const values = parseCSVLine(line);
        if (values.length >= headers.length) {
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            data.push(row);
        }
    }
    
    return data;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        
        if (char === '"' && !inQuotes) {
            inQuotes = true;
        } else if (char === '"' && inQuotes) {
            if (nextChar === '"') {
                current += '"';
                i++; // Skip next quote
            } else {
                inQuotes = false;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current);
    return result;
}

function updateDashboard() {
    // Calculate totals
    const totals = calculateTotals();
    
    // Update summary cards with both EUR and ETH amounts
    document.getElementById('totalRewards').innerHTML = `
        €${totals.totalRewards.toFixed(2)}
        <div class="eth-amount">${totals.totalRewardsEth.toFixed(6)} ETH</div>
    `;
    document.getElementById('totalTaxes').innerHTML = `
        €${totals.totalTaxes.toFixed(2)}
        <div class="eth-amount">${totals.totalTaxesEth.toFixed(6)} ETH</div>
    `;
    document.getElementById('unpaidTaxes').innerHTML = `
        €${totals.unpaidTaxes.toFixed(2)}
        <div class="eth-amount">${totals.unpaidTaxesEth.toFixed(6)} ETH</div>
    `;
    
    // Update node stats
    updateNodeStats('node1', totals.node1);
    updateNodeStats('node2', totals.node2);
    
    // Update tables
    updateTransactionTable('node1');
    updateTransactionTable('node2');
    
    document.getElementById('dashboard').style.display = 'block';
}

function calculateTotals() {
    const node1Totals = calculateNodeTotals(currentData.node1);
    const node2Totals = calculateNodeTotals(currentData.node2);
    
    return {
        totalRewards: node1Totals.rewards + node2Totals.rewards,
        totalRewardsEth: node1Totals.rewardsEth + node2Totals.rewardsEth,
        totalTaxes: node1Totals.taxes + node2Totals.taxes,
        totalTaxesEth: node1Totals.taxesEth + node2Totals.taxesEth,
        unpaidTaxes: node1Totals.unpaidTaxes + node2Totals.unpaidTaxes,
        unpaidTaxesEth: node1Totals.unpaidTaxesEth + node2Totals.unpaidTaxesEth,
        node1: node1Totals,
        node2: node2Totals
    };
}

function calculateNodeTotals(data) {
    let rewards = 0;
    let rewardsEth = 0;
    let taxes = 0;
    let taxesEth = 0;
    let unpaidTaxes = 0;
    let unpaidTaxesEth = 0;
    
    data.forEach(row => {
        // Skip daily totals for individual calculations
        if (row.Date && row.Date.includes('DAILY TOTAL')) {
            return;
        }
        
        const rewardAmount = parseFloat(row['ETH Rewards in EURO']) || 0;
        const ethRewardAmount = parseFloat(row['ETH Rewards']) || 0;
        const taxAmount = parseFloat(row['Taxes in EURO']) || 0;
        const ethTaxAmount = parseFloat(row['ETH for Taxes']) || 0;
        const isPaid = row['Tax Status'] === 'Paid';
        
        rewards += rewardAmount;
        rewardsEth += ethRewardAmount;
        taxes += taxAmount;
        taxesEth += ethTaxAmount;
        
        if (!isPaid && taxAmount > 0) {
            unpaidTaxes += taxAmount;
            unpaidTaxesEth += ethTaxAmount;
        }
    });
    
    return { rewards, rewardsEth, taxes, taxesEth, unpaidTaxes, unpaidTaxesEth };
}

function updateNodeStats(nodeKey, stats) {
    // Update all amounts with both EUR and ETH
document.getElementById(`${nodeKey}TotalRewards`).innerHTML = `
    <span style="color: #4b9f53;">€${stats.rewards.toFixed(2)}</span>
    <div class="eth-amount" style="color: #4b9f53;">${stats.rewardsEth.toFixed(6)} ETH</div>
`;
    document.getElementById(`${nodeKey}TotalTaxes`).innerHTML = `
        <span style="color: #e8a23b;">€${stats.taxes.toFixed(2)}</span>
        <div class="eth-amount" style="color: #e8a23b;">${stats.taxesEth.toFixed(6)} ETH</div>
    `;  
    document.getElementById(`${nodeKey}UnpaidTaxes`).innerHTML = `
        <span style="color: #dd514b;">€${stats.unpaidTaxes.toFixed(2)}</span>
        <div class="eth-amount" style="color: #dd514b;">${stats.unpaidTaxesEth.toFixed(6)} ETH</div>
    `;
    
    // Update separate ETH elements if they exist
    const ethElement = document.getElementById(`${nodeKey}TotalRewardsEth`);
    if (ethElement) {
        ethElement.textContent = `${stats.rewardsEth.toFixed(6)} ETH`;
    }
}

function updateTransactionTable(nodeKey) {
    const tableContainer = document.getElementById(`${nodeKey}Table`);
    const data = currentData[nodeKey];
    
    if (!data || data.length === 0) {
        tableContainer.innerHTML = '<p style="text-align: center; color: #7f8c8d; padding: 20px;">No transactions found</p>';
        return;
    }
    
    let tableHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>ETH Rewards</th>
                    <th>ETH Price (EUR)</th>
                    <th>Rewards in EUR</th>
                    <th>Tax Rate</th>
                    <th>ETH for Taxes</th>
                    <th>Tax Amount (EUR)</th>
                    <th>Transaction Hash</th>
                    <th>Tax Status</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // Sort by date (newest first)
    const sortedData = [...data].sort((a, b) => {
        const dateA = new Date(a.Date.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
        const dateB = new Date(b.Date.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
        return dateB - dateA;
    });
    
    sortedData.forEach((row, index) => {
        const isDailyTotal = row.Date && row.Date.includes('DAILY TOTAL');
        const ethRewards = parseFloat(row['ETH Rewards']) || 0;
        const ethPrice = parseFloat(row['ETH Price (EURO)']) || 0;
        const rewardsEur = parseFloat(row['ETH Rewards in EURO']) || 0;
        const taxAmountEur = parseFloat(row['Taxes in EURO']) || 0;
        const txHash = row['Transaction Hash'] || '';
        const taxStatus = row['Tax Status'] || 'Unpaid';
        const taxTxHash = row['Tax Transaction Hash'] || '';
        
        const rowClass = isDailyTotal ? 'daily-total-row' : '';
        const statusClass = taxStatus === 'Paid' ? 'status-paid' : 'status-unpaid';

    
        tableHTML += `
            <tr class="${rowClass}">
                <td>${row.Date}</td>
                <td><span style="color: #4b9f53;">𖢻&nbsp;${ethRewards.toFixed(6)}</span></td>
                <td>${ethPrice > 0 ? `€&nbsp;${ethPrice.toFixed(2)}` : ''}</td>
                <td><span style="color: #4b9f53;">€&nbsp;${rewardsEur.toFixed(2)}</td>
                <td>${row['Income Tax Rate'] || ''}</td>
                <td><span style="color: #e8a23b;">𖢻&nbsp;${parseFloat(row['ETH for Taxes'] || 0).toFixed(6)}</td>
                 <td><span style="color: #e8a23b;">€&nbsp;${taxAmountEur.toFixed(2)}</td>
                <td class="tx-hash">
                    ${txHash ? `<a href="https://etherscan.io/tx/${txHash}" target="_blank" class="tx-hash-link">${txHash.substring(0, 5)}...${txHash.substring(txHash.length - 4)}<i class="fas fa-external-link-alt"></i></a>` : ''}
                </td>
                <td>
                    <span class="${statusClass}">
                        <i class="fas ${taxStatus === 'Paid' ? 'fa-check' : 'fa-clock'}"></i>
                        ${taxStatus}
                    </span>
                    ${taxTxHash ? `<br><small>Tax TX: <a href="https://etherscan.io/tx/${taxTxHash}" target="_blank" class="tx-hash-link">${taxTxHash.substring(0, 6)}...${taxTxHash.substring(taxTxHash.length - 4)} <i class="fas fa-external-link-alt"></i></a></small>` : ''}
                </td>
                <td>
    ${!isDailyTotal && taxStatus === 'Unpaid' && taxAmountEur > 0 ? 
        `<button class="mark-paid-btn" onclick="openTaxModal('${nodeKey}', ${index})">Mark as Paid</button>` : 
        (taxStatus === 'Paid' ? 
            `<button class="mark-paid-btn" disabled style="background: #6c757d; cursor: not-allowed;">Paid</button>` : 
            '')}
</td>
            </tr>
        `;
    });
    
    tableHTML += '</tbody></table>';
    tableContainer.innerHTML = tableHTML;
}

function showNode(nodeNumber) {
    // Update tabs
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[onclick="showNode(${nodeNumber})"]`).classList.add('active');
    
    // Update content
    document.querySelectorAll('.node-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`node${nodeNumber}`).classList.add('active');
}

function openTaxModal(nodeKey, rowIndex) {
    const data = currentData[nodeKey];
    const sortedData = [...data].sort((a, b) => {
        const dateA = new Date(a.Date.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
        const dateB = new Date(b.Date.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
        return dateB - dateA;
    });
    
    const transaction = sortedData[rowIndex];
    currentTransaction = { nodeKey, transaction, rowIndex };
    
    const ethRewards = parseFloat(transaction['ETH Rewards']) || 0;
    const ethForTaxes = parseFloat(transaction['ETH for Taxes']) || 0;
    
    document.getElementById('modalReward').textContent = `${ethRewards.toFixed(6)} ETH`;
    document.getElementById('modalTaxAmount').textContent = `${ethForTaxes.toFixed(6)} ETH`;
    document.getElementById('taxTxHash').value = '';
    
    document.getElementById('taxModal').style.display = 'block';
}

function closeTaxModal() {
    document.getElementById('taxModal').style.display = 'none';
    currentTransaction = null;
}

async function markAsPaid() {
    if (!currentTransaction) return;
    
    const taxTxHash = document.getElementById('taxTxHash').value.trim();
    const token = localStorage.getItem('githubToken');
    
    if (!token) {
        alert('GitHub token not found. Please set up your token again.');
        return;
    }
    
    try {
        // Show loading state
        const markButton = document.querySelector('.btn-primary');
        const originalText = markButton.textContent;
        markButton.textContent = 'Updating...';
        markButton.disabled = true;
        
        // Update the transaction in our data
        const { nodeKey, transaction } = currentTransaction;
        const csvFile = CONFIG.CSV_FILES[nodeKey];
        
        // Get current file content and SHA
        const fileInfo = await getFileInfo(csvFile, token);
        const updatedCSV = updateCSVContent(fileInfo.content, transaction, taxTxHash);
        
        // Update file on GitHub
        await updateGitHubFile(csvFile, updatedCSV, fileInfo.sha, token);
        
        // Reload data
        await loadData();
        
        // Close modal
        closeTaxModal();
        
        alert('Transaction marked as paid successfully!');
        
    } catch (error) {
        console.error('Error marking as paid:', error);
        alert('Error updating transaction. Please try again.');
        
        // Reset button
        const markButton = document.querySelector('.btn-primary');
        markButton.textContent = 'Mark as Paid';
        markButton.disabled = false;
    }
}

async function getFileInfo(filename, token) {
    const url = `https://api.github.com/repos/${CONFIG.GITHUB_USERNAME}/${CONFIG.GITHUB_REPO}/contents/${filename}`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    
    if (!response.ok) {
        throw new Error(`Failed to get file info: ${response.status}`);
    }
    
    const data = await response.json();
    return {
        content: atob(data.content), // Decode base64
        sha: data.sha
    };
}

function updateCSVContent(csvContent, targetTransaction, taxTxHash) {
    const lines = csvContent.split('\n');
    const targetTxHash = targetTransaction['Transaction Hash'];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(targetTxHash) && targetTxHash) { // Make sure we have a valid hash to match
            // Parse the line and update tax status
            const values = parseCSVLine(line);
            if (values.length >= 10) {
                values[8] = 'Paid'; // Tax Status column
                values[9] = taxTxHash; // Tax Transaction Hash column
                
                // Rebuild the line with proper CSV formatting
                lines[i] = values.map(val => `"${val}"`).join(',');
                break;
            }
        }
    }
    
    return lines.join('\n');
}

async function updateGitHubFile(filename, content, sha, token) {
    const url = `https://api.github.com/repos/${CONFIG.GITHUB_USERNAME}/${CONFIG.GITHUB_REPO}/contents/${filename}`;
    
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: `Mark transaction as paid - ${new Date().toISOString()}`,
            content: btoa(content), // Encode to base64
            sha: sha
        })
    });
    
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to update file: ${response.status} - ${errorData.message || 'Unknown error'}`);
    }
    
    return response.json();
}

function showLoading() {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('dashboard').style.display = 'none';
}

function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('taxModal');
    if (event.target === modal) {
        closeTaxModal();
    }
}
