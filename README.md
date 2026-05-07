# Staking Rewards Tracker (v2 plan)

This repo currently serves a static site from `frontend/` via GitHub Pages. A new React app scaffold is provided in `app/` for the v2 experience (auth + onboarding wizard).

## Secrets (GitHub Actions)
- **`COINGECKO_API_KEY`**: used by `scripts/daily-sync.js` for `data/eth-prices.json` (daily UTC close).
- **`DUNE_API_KEY`**, **`DUNE_QUERY_ID_CL`**, **`DUNE_QUERY_ID_EL`** (or **`DUNE_QUERY_ID_EL_FALLBACK`**): used by `scripts/beacon-sync.ts` for reward rows in Firestore.
- **`FIREBASE_SERVICE_ACCOUNT`**: required for `beacon-sync` (and any script that still uses Admin SDK).
- **`BOOTSTRAP_VALIDATOR_PUBLIC_KEY`** (optional): full BLS pubkey `0x` + 96 hex; merged onto Firestore trackers that are missing `validatorPublicKey` when `beacon-sync` runs (no Beacon HTTP API).

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

6. **Enable Firestore Database (for cross-device sync):**
   - Firebase Console → Firestore Database → Create Database
   - Choose "Start in production mode" (we'll add security rules next)
   - Select a location (choose closest to your users)
   - Click "Enable"

7. **Set Firestore Security Rules:**
   - Firebase Console → Firestore Database → Rules
   - Replace with:
   ```javascript
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Users can only access their own data
       match /users/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
         
         match /trackers/{trackerId} {
           allow read, write: if request.auth != null && request.auth.uid == userId;
           
           match /transactions/{transactionId} {
             allow read, write: if request.auth != null && request.auth.uid == userId;
           }
         }
       }
     }
   }
   ```
   - Click "Publish"

8. **Authorize your domain:**
   - Firebase Console → Authentication → Settings → Authorized domains
   - Add `mx1000m.github.io` (or your GitHub Pages domain)
   - Add `localhost` for local development

## Firestore Data Model (Option B: Full History)

The app stores **full transaction history + paid decisions** in Firestore for cross-device sync:

**Structure:**
```
users/{uid}/
  trackers/{trackerId}/
    - name, walletAddress, currency, taxRate, validatorPublicKey, mevMode, …
    transactions/{transactionHash}/
      - date, time, ethAmount, ethPrice, rewardsInCurrency
      - taxRate, taxesInEth, taxesInCurrency
      - status ("Unpaid" or "✓ Paid"), swapHash (optional)
      - timestamp
```

**Capacity Analysis (100 users, 1-5 nodes each):**
- **Daily writes**: ~325/day (1.6% of 20,000 limit) ✅
- **Daily reads**: ~1,750/day (3.5% of 50,000 limit) ✅
- **Storage**: ~55 MB/year (5.5% of 1 GiB limit) ✅

**Smart Caching Strategy:**
- IndexedDB caches transactions locally for instant display
- Firestore syncs only new transactions (delta fetch) to minimize reads
- "Mark as Paid" status syncs to Firestore for cross-device access
- Tracker metadata syncs to Firestore on create/update

## Rewards data flow

- **Dune + `beacon-sync`**: daily CL/EL reward rows written to Firestore (`transactions` subcollection).
- **App**: loads that year’s rows from Firestore; IndexedDB caches locally; EUR/USD comes from `data/eth-prices.json` (updated by `daily-sync.js` via CoinGecko).

## Deploy v2 (manual)
A manual Pages workflow can be added to build `app/` and deploy `dist/`. For now, v1 remains live. When ready, switch Pages to the React build workflow.


