# 📊 Saifnesse Database Architecture (v1.0)
## Current State: The Hybrid Model

---

## I. Overview

This database is currently a **Data Aggregation System**. Its primary function is to ingest chaotic, unstructured car listings from the internet (OfferUp, Facebook Marketplace, etc.), normalize them, and store them.

> **We are currently transitioning this system from a "Passive Library" to an "Active Arbitrage Engine."**

---

## II. The Architecture Layers

Our database is organized into **5 logical layers**, each serving a specific purpose in the arbitrage pipeline:

```
┌─────────────────────────────────────────────────────────────┐
│                   USER ACTION LAYER                         │
│          (saved_deals, dismissed_deals, flipped_cars)       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ (User Feedback Loop)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               INTELLIGENCE LAYER (The Brain)                │
│         Old: deal_scores  |  New: arbitrage_valuations     │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ (Valuation Logic)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               CORE DATA LAYER (The Library)                 │
│                  (listings, raw_html)                       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ (Scraping Results)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              INGESTION LAYER (The Workers)                  │
│      (sources, offerup_searches, offerup_jobs, etc.)        │
└─────────────────────────────────────────────────────────────┘
```

---

## III. The Data Flow (Mental Model)

### Step 1: Configuration
- **Robots** (`offerup_jobs`, `deal_finder_jobs`) read instructions from **Triggers** (`offerup_searches`)
- **Sources** (`sources` table) define where to look (OfferUp, Facebook, Craigslist)

### Step 2: Scraping
- Robots scrape the web and dump raw data into:
  - `raw_html` (the evidence locker)
  - `listings` (the normalized master record)

### Step 3: Intelligence (OLD WAY)
- The **Old Brain** (`deal_scores`) uses K-Nearest Neighbors to statistically compare cars
- **Limitation**: Purely statistical. Doesn't understand "Profit" or "Liquidity"

### Step 4: Intelligence (NEW WAY) ✨
- The **New Engine** (`arbitrage_valuations`) reads `listings`
- Calculates **Profit** (Oracle Value - Ask Price - Friction Costs)
- Calculates **Velocity** (Liquidity Tier: HIGH_VELOCITY, MEDIUM_VELOCITY, etc.)
- Writes the **Truth** into `arbitrage_valuations`

### Step 5: User Interaction
- The User queries `arbitrage_valuations` to see the **"Golden Path"** of deals
- User marks deals as:
  - `saved_deals` (Watchlist)
  - `dismissed_deals` (Trash Can - trains the AI)
  - `flipped_cars` (Completed Deals - Ground Truth for future models)

---

## IV. The Evolutionary Path

### **Phase 1: The Passive Library (Past)**
- Just stored listings in a table
- Sorted by date
- No intelligence

### **Phase 2: The Statistical Analyzer (Current - Transitioning Out)**
- `deal_scores` table uses K-Nearest Neighbors
- Compares cars to statistical averages
- Doesn't understand **Profit**, only **Deviation**

### **Phase 3: The Arbitrage Engine (Current - Building Now)** ⭐
- `arbitrage_valuations` table separates **Value** from **Specs**
- Uses external **Oracles** (Manheim MMR, KBB)
- Calculates **Projected Profit** and **Liquidity Tier**
- **Universal**: Can value Cars, Real Estate, Equipment (anything)

---

## V. Key Design Principles

### 1. The Sidecar Pattern
> **Raw Data** (`listings`) is separate from **Intelligence** (`arbitrage_valuations`)

**Why?**
- Allows us to re-calculate valuations without re-scraping
- Enables multiple valuation strategies simultaneously
- Future-proof: Can add new valuation models without touching raw data

### 2. The Universal Schema
> **We classify assets by Physics, not by Name**

Instead of:
- ❌ `car_listings`, `boat_listings`, `house_listings`

We use:
- ✅ `listings` (universal) + `asset_type` column
- ✅ `liquidity_tier` (TIME dimension: How fast does it sell?)
- ✅ `complexity_tier` (DIFFICULTY dimension: How hard to value?)

### 3. The JSONB Brain
> **Flexible Intelligence via `valuation_data`**

The `arbitrage_valuations.valuation_data` column stores the "Spirit" of the deal:
- Oracle values
- Friction costs (transport, reconditioning, fees)
- Distress signals (seller psychology)
- Scam probability

**This allows us to evolve the valuation logic without schema migrations.**

---

## VI. The Most Important Tables (Quick Reference)

| Table | Purpose | Read Frequency | Write Frequency |
|-------|---------|----------------|-----------------|
| `listings` | Master record of all assets | Very High | High |
| `arbitrage_valuations` | The profit calculation | **EXTREMELY HIGH** | Medium |
| `offerup_jobs` | Scraper execution logs | Medium | High (during scrapes) |
| `saved_deals` | User watchlist | High | Low |
| `flipped_cars` | Ground truth (completed deals) | Low | Very Low |

---

## VII. The Future Vision

This database will eventually power:

1. **The Wedge**: Vehicle arbitrage (private-to-wholesale)
2. **The Verification Layer**: "Ghost Buyer" infrastructure (remote inspections)
3. **The Universal Ledger**: Arbitrage for all assets (Real Estate, Equipment, Contracts)

> **The database you see today is 10% of what it will become. But the architecture is already designed to handle it.**

---

**Next Steps:**
- Read [02_CORE_DATA_LAYER.md](./02_CORE_DATA_LAYER.md) to understand the `listings` and `raw_html` tables
- Or jump to [04_INTELLIGENCE_LAYER.md](./04_INTELLIGENCE_LAYER.md) to understand the new `arbitrage_valuations` engine

---

**Last Updated**: 2025-11-30
