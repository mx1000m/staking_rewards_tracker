/**
 * Legacy package entrypoint. The old Etherscan → CSV flow was removed; rewards are
 * synced with Dune + scripts/beacon-sync.ts into Firestore and shown in app/ (Vite).
 */
console.log(
  "eth-tracker: Etherscan-based CSV tracking was removed. Use `cd app && npm run dev` for the web app, " +
    "and GitHub Actions for scripts/beacon-sync.ts (Dune) and scripts/daily-sync.js (ETH prices JSON only)."
);
process.exit(0);
