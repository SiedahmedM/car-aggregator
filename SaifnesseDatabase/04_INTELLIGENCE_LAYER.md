# 🧠 Intelligence Layer (The "Brain")

> **These tables transform raw listings into actionable opportunities.**

---

## Table of Contents
- [`deal_scores`](#deal_scores) - The Old Algorithm (Legacy)
- [`arbitrage_valuations`](#arbitrage_valuations) - The New Engine ⭐

---

## `deal_scores`

### ⚠️ STATUS: **LEGACY / BEING REPLACED**

### 🎯 Purpose
**The Old Algorithm.**

Attempts to score deals based on **statistical averages** using K-Nearest Neighbors (KNN).

### 🔑 Key Concept
> **"Compares a car to similar cars nearby and calculates deviation from average price."**

**How it works:**
1. Find 5-10 cars with similar year/make/model/mileage
2. Calculate the average price of those cars
3. If the listing is below average, flag it as a "deal"

### ❌ Limitation
**It is purely statistical. It doesn't understand "Profit" or "Liquidity," only "Deviation from Average."**

**Problems:**
- Doesn't account for **wholesale value** (what a dealer can actually sell it for)
- Doesn't account for **friction costs** (transport, reconditioning, auction fees)
- Doesn't account for **seller distress signals** (desperation, scam probability)
- Doesn't understand **liquidity** (how fast the car will turn)

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`listing_id`** | `uuid` | Links to `listings.id` | `xyz-...` |
| **`score`** | `numeric` | Statistical score (higher = better deal) | `8.5`, `3.2` |
| **`knn_neighbors`** | `jsonb` | The similar cars used for comparison | `[{...}, {...}]` |
| **`avg_price`** | `numeric` | Average price of similar cars | `10500` |
| **`price_deviation`** | `numeric` | How far below average (positive = good deal) | `1500` (car is $1500 below average) |
| **`created_at`** | `timestamp` | When this score was calculated | `2025-11-30 08:00:00` |

---

### 🔗 Relationships

```sql
deal_scores.listing_id → listings.id (Foreign Key)
```

---

### 🧠 How KNN Works (Simplified)

**Example:**
```sql
-- Listing we're scoring
SELECT * FROM listings WHERE id = 'xyz-...';
-- Result: 2017 Honda Civic, 85k miles, asking $9,000

-- Find similar cars
SELECT * FROM listings
WHERE make = 'Honda'
  AND model = 'Civic'
  AND year BETWEEN 2015 AND 2019
  AND mileage BETWEEN 70000 AND 100000
ORDER BY random()
LIMIT 5;

-- Results:
-- 1. 2016 Civic, 90k miles, $10,200
-- 2. 2018 Civic, 78k miles, $11,500
-- 3. 2017 Civic, 82k miles, $10,800
-- 4. 2019 Civic, 95k miles, $12,000
-- 5. 2016 Civic, 88k miles, $10,000

-- Average price of neighbors: $10,900
-- Our car's price: $9,000
-- Deviation: $1,900 below average → Good deal!
```

---

### 📊 Common Queries

#### 1. Get top deals by statistical score
```sql
SELECT l.title, l.price, ds.avg_price, ds.price_deviation, ds.score
FROM deal_scores ds
JOIN listings l ON ds.listing_id = l.id
WHERE ds.score > 7
ORDER BY ds.score DESC;
```

---

### 🔄 Migration Path

**Current State:**
- `deal_scores` still runs in parallel with `arbitrage_valuations`
- Some legacy UI components still reference it

**Future State:**
- Once `arbitrage_valuations` proves superior, we'll deprecate `deal_scores`
- Will keep the table for historical analysis ("how did the old algorithm perform?")

---

## `arbitrage_valuations`

### ⭐ STATUS: **ACTIVE / THE FUTURE**

### 🎯 Purpose
**The Universal Arbitrage Engine.**

Separates the **Value** of an asset from the **Specs** of the asset.

### 🔑 Key Concept
> **"We don't just find cheap cars. We find profitable arbitrage opportunities."**

**The Formula:**
```
Projected Profit = Oracle Value - Ask Price - Friction Costs
```

**Components:**
- **Oracle Value**: What a dealer can actually sell the car for (Manheim MMR, KBB Wholesale)
- **Ask Price**: What the seller is asking
- **Friction Costs**: Transport ($300), Reconditioning ($200), Auction Fees ($400), etc.

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`listing_id`** | `uuid` | Links to `listings.id` | `xyz-...` |
| **`asset_type`** | `text` | What kind of asset | `"Vehicle"`, `"Single Family Home"` |
| **`liquidity_tier`** | `liquidity_spectrum` | How fast it sells | `"HIGH_VELOCITY"`, `"MEDIUM_VELOCITY"`, etc. |
| **`complexity_tier`** | `complexity_index` | How hard to value | `"LOW_COMPLEXITY"`, `"MEDIUM_COMPLEXITY"`, etc. |
| **`projected_profit`** | `numeric` | **THE MOST IMPORTANT NUMBER** (computed) | `2100`, `5300`, `-400` |
| **`valuation_data`** | `jsonb` | The "Spirit" (Oracle values, friction, signals) | `{...}` |
| **`created_at`** | `timestamp` | When this valuation was created | `2025-11-30 09:00:00` |
| **`updated_at`** | `timestamp` | When this valuation was last updated | `2025-11-30 21:00:00` |

---

### 🔗 Relationships

```sql
arbitrage_valuations.listing_id → listings.id (Foreign Key, ON DELETE CASCADE)
```

**Note:** If a listing is deleted, its valuation is automatically deleted (CASCADE).

---

### 🧠 Critical Fields Explained

#### **`asset_type`**

The category of asset being valued.

**Current Values:**
- `"Vehicle"` (cars, trucks, motorcycles)

**Future Values:**
- `"Single Family Home"`
- `"Multi-Family Property"`
- `"Heavy Equipment"` (tractors, excavators)
- `"Contracts"` (structured settlements, annuities)

**Why Universal?**
- Allows us to expand beyond cars without rewriting the database
- All arbitrage logic is the same: Oracle Value - Ask Price - Friction

---

#### **`liquidity_tier` (Enum: `liquidity_spectrum`)**

Classifies assets by **how fast they sell**.

| Tier | Time to Sell | Example Assets |
|------|--------------|----------------|
| **`HIGH_VELOCITY`** | < 7 days | Popular cars (Honda Civic, Toyota Camry), iPhones |
| **`MEDIUM_VELOCITY`** | < 30 days | Luxury watches, boats, specialty cars |
| **`LOW_VELOCITY`** | < 6 months | Real estate, commercial equipment |
| **`ILLIQUID`** | 6+ months | Distressed properties, exotic assets |

**Why It Matters:**
- **Velocity = Risk**: High-velocity assets are lower risk (money back faster)
- **UI Prioritization**: Show high-velocity deals first (dealers want quick flips)
- **Financing**: High-velocity deals may qualify for shorter-term loans

**Example:**
```sql
-- Show me only high-velocity deals (quick flips)
SELECT l.title, av.projected_profit, av.liquidity_tier
FROM arbitrage_valuations av
JOIN listings l ON av.listing_id = l.id
WHERE av.liquidity_tier = 'HIGH_VELOCITY'
  AND av.projected_profit > 2000
ORDER BY av.projected_profit DESC;
```

---

#### **`complexity_tier` (Enum: `complexity_index`)**

Classifies assets by **how hard they are to value**.

| Tier | Difficulty | Example Assets | Valuation Method |
|------|-----------|----------------|------------------|
| **`LOW_COMPLEXITY`** | Simple, predictable | Mass-market cars (Year/Make/Model) | Oracle API (Manheim MMR) |
| **`MEDIUM_COMPLEXITY`** | Requires inspection | Luxury cars, condition-sensitive assets | Oracle API + Condition Adjustment |
| **`HIGH_COMPLEXITY`** | Proprietary modeling | Commercial Real Estate, unique assets | Custom ML models |

**Why It Matters:**
- **Confidence Level**: Low-complexity valuations are more reliable
- **Verification Need**: High-complexity assets may require on-site inspection
- **Pricing Strategy**: Can charge higher fees for high-complexity deals

---

#### **`projected_profit` (GENERATED COLUMN)**

**THE MOST IMPORTANT NUMBER IN THE DATABASE.**

This is a **computed column** (automatically calculated from `valuation_data`):

```sql
projected_profit numeric GENERATED ALWAYS AS
  ((valuation_data->'arbitrage_metrics'->>'net_projected_profit')::numeric)
STORED
```

**Why Computed?**
- **Single Source of Truth**: Always in sync with `valuation_data`
- **Indexed**: Can sort/filter by profit without parsing JSON
- **Performance**: Pre-calculated, no runtime computation needed

**Example:**
```sql
-- The "Bloomberg" Index (fastest query in the database)
CREATE INDEX idx_projected_profit
ON arbitrage_valuations(projected_profit DESC);

-- Show me the top 10 most profitable deals
SELECT l.title, l.price, av.projected_profit
FROM arbitrage_valuations av
JOIN listings l ON av.listing_id = l.id
ORDER BY av.projected_profit DESC
LIMIT 10;
```

---

#### **`valuation_data` (JSONB)**

**The "Spirit" of the deal.**

Stores all the intelligence in a flexible JSON structure.

**Full Schema:**
```json
{
  "asset_metadata": {
    "universal_id": "VIN_OR_ADDRESS",
    "title": "2017 Honda Civic",
    "asset_type": "Vehicle",
    "condition": "Good"
  },
  "valuation_engine": {
    "ask_price": 9000,
    "oracle_source": "MANHEIM_MMR",
    "oracle_value_base": 12000,
    "oracle_value_adjusted": 11500,
    "condition_adjustment": -500,
    "friction_costs": {
      "transport": 300,
      "auction_fees": 400,
      "reconditioning": 200,
      "holding_costs": 100,
      "total_friction": 1000
    }
  },
  "arbitrage_metrics": {
    "gross_spread": 3000,
    "net_projected_profit": 2100,
    "roi_percent": 23.3,
    "liquidity_rating": "HIGH",
    "confidence_score": 0.85
  },
  "signals": {
    "seller_distress_level": 8,
    "seller_keywords": ["moving", "must sell fast"],
    "scam_probability": 0.05,
    "days_on_market": 3,
    "price_drop_history": [
      { "date": "2025-11-25", "price": 9500 },
      { "date": "2025-11-28", "price": 9000 }
    ]
  },
  "verification": {
    "needs_inspection": false,
    "carfax_available": true,
    "images_count": 12
  }
}
```

---

### 📊 Key JSONB Queries

#### 1. Extract specific values
```sql
-- Get Oracle source and profit for all valuations
SELECT
  listing_id,
  valuation_data->'valuation_engine'->>'oracle_source' AS oracle,
  valuation_data->'arbitrage_metrics'->>'net_projected_profit' AS profit
FROM arbitrage_valuations;
```

#### 2. Filter by seller distress
```sql
-- Find deals where seller is desperate (distress > 7)
SELECT l.title, l.url, av.projected_profit
FROM arbitrage_valuations av
JOIN listings l ON av.listing_id = l.id
WHERE (av.valuation_data->'signals'->>'seller_distress_level')::int > 7
  AND av.projected_profit > 1500
ORDER BY av.projected_profit DESC;
```

#### 3. Filter by low scam probability
```sql
-- Find safe deals (scam probability < 10%)
SELECT l.title, l.price, av.projected_profit
FROM arbitrage_valuations av
JOIN listings l ON av.listing_id = l.id
WHERE (av.valuation_data->'signals'->>'scam_probability')::numeric < 0.10
  AND av.projected_profit > 2000;
```

---

### 🎨 The UI Experience

When a dealer queries `arbitrage_valuations`, they see:

**Primary:** `+$2,100` (projected_profit) in **GIANT GREEN TEXT**

**Secondary:** Velocity bar (HIGH_VELOCITY → "Turns in < 7 days")

**Tertiary:** Asset name ("2017 Honda Civic")

**Signals:**
- 🚨 Seller distress: 8/10 ("Moving out of state!")
- ✅ Low scam risk: 5%
- 📉 Price dropped $500 in 3 days

---

### 🔄 Workflow: From Listing to Valuation

```sql
-- Step 1: Scraper writes to listings
INSERT INTO listings (source, remote_id, price, year, make, model, ...)
VALUES ('offerup', 'ou-12345', 9000, 2017, 'Honda', 'Civic', ...);

-- Step 2: Deal Finder reads listings
SELECT * FROM listings WHERE id NOT IN (
  SELECT listing_id FROM arbitrage_valuations
);

-- Step 3: For each listing, call Oracle API
-- (Manheim MMR returns: $12,000 wholesale value)

-- Step 4: Calculate profit
-- Oracle: $12,000
-- Ask: $9,000
-- Friction: $1,000 (transport $300 + fees $400 + recon $200 + holding $100)
-- Profit: $12,000 - $9,000 - $1,000 = $2,000

-- Step 5: Write to arbitrage_valuations
INSERT INTO arbitrage_valuations (
  listing_id,
  asset_type,
  liquidity_tier,
  complexity_tier,
  valuation_data
) VALUES (
  'xyz-...',
  'Vehicle',
  'HIGH_VELOCITY',
  'LOW_COMPLEXITY',
  '{
    "valuation_engine": {
      "ask_price": 9000,
      "oracle_value_base": 12000,
      "friction_costs": { "total_friction": 1000 }
    },
    "arbitrage_metrics": {
      "net_projected_profit": 2000
    }
  }'::jsonb
);

-- Step 6: User queries for top deals
SELECT * FROM arbitrage_valuations
WHERE projected_profit > 2000
ORDER BY projected_profit DESC;
```

---

## 🎓 Comparison: Old vs New

| Feature | `deal_scores` (Old) | `arbitrage_valuations` (New) |
|---------|---------------------|------------------------------|
| **Philosophy** | Statistical deviation | Actual profit calculation |
| **Data Source** | Similar listings | Oracle APIs (Manheim MMR, KBB) |
| **Friction Costs** | ❌ Ignored | ✅ Included |
| **Liquidity** | ❌ Not tracked | ✅ Classified (HIGH/MEDIUM/LOW) |
| **Seller Psychology** | ❌ Not tracked | ✅ Distress signals extracted |
| **Scalability** | Cars only | Universal (cars, real estate, etc.) |
| **Profit Accuracy** | Low (statistical guess) | High (based on real wholesale values) |

---

## 🎓 Summary

| Table | Purpose | Status | Typical Size |
|-------|---------|--------|--------------|
| **`deal_scores`** | Statistical KNN scoring | Legacy (being phased out) | 10K-100K rows |
| **`arbitrage_valuations`** | Profit-based arbitrage engine | **Active (The Future)** | 10K-100K rows |

---

**Next:** Read [05_USER_ACTION_LAYER.md](./05_USER_ACTION_LAYER.md) to understand how users interact with deals.

---

**Last Updated**: 2025-11-30
