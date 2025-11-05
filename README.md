# Staking Rewards Tracker (v2 plan)

This repo currently serves a static site from `frontend/` via GitHub Pages. A new React app scaffold is provided in `app/` for the v2 experience (auth + onboarding wizard).

## Secrets required (for Node script)
- `ETHERSCAN_API_KEY` (required): used by `index.js` to fetch transactions.
- `COINGECKO_API_KEY` (optional): sent as `x-cg-demo-api-key` to increase rate limits.

Add these at: Settings → Secrets and variables → Actions → New repository secret.

## Etherscan "Sign in"
Etherscan does not provide OAuth. Each user must create their own API key and paste it in the app. The wizard collects the key and stores it client-side (or later to a backend of your choice).

## React app (v2)
- Location: `app/` (Vite + React + TS). Base path is configured for GitHub Pages under `vite.config.ts`.
- Run locally:
```bash
cd app
npm i
npm run dev
```

## Deploy v2 (manual)
A manual Pages workflow can be added to build `app/` and deploy `dist/`. For now, v1 remains live. When ready, switch Pages to the React build workflow.


