# Backend Database Implementation Guide

This document outlines the steps and schema required to move the **Gemini Quant Bot** from memory-based mock data to a persistent database.

## 1. Recommended Database: Firebase Firestore
Firestore is recommended for this project due to its real-time capabilities (perfect for price updates) and seamless integration with the existing environment.

### 📜 Entity Schemas

#### **Collection: `trades`**
Stores every executed trade for the History view.
* `id`: string (UUID)
* `symbol`: string (e.g., "BTC/USDT")
* `type`: string ("BUY" | "SELL")
* `entryPrice`: number
* `exitPrice`: number
* `pnl`: number
* `amount`: number
* `strategy`: string
* `timestamp`: serverTimestamp
* `status`: string ("OPEN" | "CLOSED")

#### **Collection: `pnl_snapshots`**
Used to drive the performance line chart.
* `timestamp`: number (Unix)
* `totalValue`: number
* `pnlPercent`: number

#### **Collection: `settings` (Document: `bot_config`)**
Stores user preferences and active state.
* `isAutoPilot`: boolean
* `riskLevel`: number
* `maxSlippage`: number
* `symbols`: string[] (Active symbols to scan)

---

## 🛠 To-Do List for Implementation

### Phase 1: Setup
- [ ] Run the tool `set_up_firebase` to initialize your project.
- [ ] Connect the `firebase-applet-config.json` inside `server.ts`.
- [ ] Initialize Firebase Admin SDK in the backend.

### Phase 2: Refactoring API Endpoints
- [ ] **GET `/api/trade-history`**: Update to fetch from `firestore.collection('trades')`.
- [ ] **POST `/api/execute`**: Update logic to write a new document to `trades` upon execution.
- [ ] **GET `/api/pnl-history`**: Query the `pnl_snapshots` collection ordered by timestamp.

### Phase 3: Background Tasks
- [ ] Implement a "Cron" or interval job that takes a snapshot of the total wallet balance every hour and saves it to `pnl_snapshots`.
- [ ] Add field validation to ensure trade amounts never exceed a safety threshold.

---

## 🔒 Security Rules (Firestore)
When deploying, ensure your `firestore.rules` protect your API keys and only allow the bot (or authenticated admin) to write to the execution logs.

```javascript
service cloud.firestore {
  match /databases/{database}/documents {
    match /trades/{tradeId} {
      allow read: if request.auth != null;
      allow write: if false; // Only server-side writes via Admin SDK
    }
  }
}
```
