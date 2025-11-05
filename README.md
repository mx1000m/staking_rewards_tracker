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

### Firebase Authentication Setup (for Google/GitHub sign-in)

1. **Create a Firebase project:**
   - Go to https://console.firebase.google.com/
   - Click "Add project" → Follow the wizard
   - Enable Google Analytics (optional)

2. **Enable Authentication:**
   - In Firebase Console → Authentication → Get Started
   - Enable "Google" sign-in provider
   - Enable "GitHub" sign-in provider (requires GitHub OAuth app setup)

3. **Get your Firebase config:**
   - Firebase Console → Project Settings → Your apps → Web app
   - Copy the `firebaseConfig` object

4. **Set environment variables:**
   Create `app/.env.local` with:
   ```
   VITE_FIREBASE_API_KEY=your-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
   VITE_FIREBASE_APP_ID=your-app-id
   ```

5. **For GitHub OAuth (optional):**
   - Create a GitHub OAuth App: https://github.com/settings/developers
   - Set Authorization callback URL to: `https://YOUR-PROJECT-ID.firebaseapp.com/__/auth/handler`
   - Add Client ID and Client Secret to Firebase → Authentication → GitHub provider

## Deploy v2 (manual)
A manual Pages workflow can be added to build `app/` and deploy `dist/`. For now, v1 remains live. When ready, switch Pages to the React build workflow.


