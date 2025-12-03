# 👤 User Action Layer (The "Filter")

> **How users interact with the data and provide feedback.**

---

## Table of Contents
- [`saved_deals`](#saved_deals) - The Watchlist
- [`dismissed_deals`](#dismissed_deals) - The Trash Can
- [`flipped_cars`](#flipped_cars) - The Ledger (Ground Truth)

---

## `saved_deals`

### 🎯 Purpose
**The Watchlist.**

Tracks deals the user is interested in pursuing.

### 🔑 Key Concept
> **"A saved deal is a bookmark. The user wants to remember this opportunity."**

**Use Cases:**
- User sees a great deal but isn't ready to act immediately
- User wants to compare multiple deals side-by-side
- User is waiting for more information (Carfax, inspection report)

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`user_id`** | `uuid` | Who saved this deal | `user-xyz-...` |
| **`listing_id`** | `uuid` | Links to `listings.id` | `listing-abc-...` |
| **`valuation_id`** | `uuid` | Links to `arbitrage_valuations.id` (optional) | `valuation-def-...` |
| **`notes`** | `text` | User's private notes | `"Check Carfax before buying"` |
| **`saved_at`** | `timestamp` | When user saved this | `2025-11-30 09:15:00` |

---

### 🔗 Relationships

```sql
saved_deals.user_id → users.id (Foreign Key)
saved_deals.listing_id → listings.id (Foreign Key)
saved_deals.valuation_id → arbitrage_valuations.id (Foreign Key, NULLABLE)
```

**Why is `valuation_id` nullable?**
- User might save a listing before it's been valued
- User might save based on gut feeling, not algorithmic profit

---

### 🧠 Critical Fields Explained

#### **`notes`**

Free-text field for user's private thoughts.

**Example Notes:**
- `"Need to verify clean title"`
- `"Seller said will accept $8,500"`
- `"Car is 2 hours away - schedule weekend trip"`
- `"Compare to similar listing on Craigslist"`

**Future Enhancement:**
- Parse notes with NLP to extract action items
- Auto-remind user based on keywords (e.g., "schedule" → create calendar event)

---

### 📊 Common Queries

#### 1. Get user's watchlist
```sql
SELECT
  l.title,
  l.price,
  av.projected_profit,
  sd.notes,
  sd.saved_at
FROM saved_deals sd
JOIN listings l ON sd.listing_id = l.id
LEFT JOIN arbitrage_valuations av ON sd.valuation_id = av.id
WHERE sd.user_id = 'user-xyz-...'
ORDER BY sd.saved_at DESC;
```

#### 2. Find stale saved deals (user forgot about them)
```sql
-- Deals saved more than 7 days ago
SELECT
  l.title,
  l.url,
  sd.saved_at,
  NOW() - sd.saved_at AS age
FROM saved_deals sd
JOIN listings l ON sd.listing_id = l.id
WHERE sd.user_id = 'user-xyz-...'
  AND sd.saved_at < NOW() - INTERVAL '7 days'
ORDER BY sd.saved_at ASC;
```

---

## `dismissed_deals`

### 🎯 Purpose
**The Trash Can.**

Tracks deals the user has explicitly rejected.

### 🔑 Key Concept
> **"A dismissed deal is a signal. The AI should learn not to show similar cars."**

**Use Cases:**
- User marks a deal as "Not Interested"
- User identifies a scam or misleading listing
- User has preferences (e.g., "Never show me salvage titles")

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`user_id`** | `uuid` | Who dismissed this deal | `user-xyz-...` |
| **`listing_id`** | `uuid` | Links to `listings.id` | `listing-abc-...` |
| **`reason`** | `text` | Why user dismissed it | `"Salvage title"`, `"Too far away"`, `"Scam"` |
| **`dismissed_at`** | `timestamp` | When user dismissed this | `2025-11-30 10:45:00` |

---

### 🔗 Relationships

```sql
dismissed_deals.user_id → users.id (Foreign Key)
dismissed_deals.listing_id → listings.id (Foreign Key)
```

---

### 🧠 Critical Fields Explained

#### **`reason`**

Categorical or free-text explanation for dismissal.

**Common Reasons:**
- `"Salvage title"`
- `"Too many miles"`
- `"Scam (fake photos)"`
- `"Already sold"`
- `"Overpriced"`
- `"Wrong color/trim"`

**Machine Learning Use:**
```sql
-- Find patterns in user dismissals
SELECT reason, COUNT(*) AS count
FROM dismissed_deals
WHERE user_id = 'user-xyz-...'
GROUP BY reason
ORDER BY count DESC;

-- Result: User dismisses 80% of salvage titles
-- → Update recommendation engine to hide salvage titles for this user
```

---

### 📊 Common Queries

#### 1. Hide dismissed deals from feed
```sql
-- Show deals user hasn't dismissed
SELECT l.*
FROM listings l
WHERE l.id NOT IN (
  SELECT listing_id
  FROM dismissed_deals
  WHERE user_id = 'user-xyz-...'
)
ORDER BY l.posted_at DESC;
```

#### 2. Analyze user preferences
```sql
-- What makes/models does user dismiss most?
SELECT l.make, l.model, COUNT(*) AS dismissed_count
FROM dismissed_deals dd
JOIN listings l ON dd.listing_id = l.id
WHERE dd.user_id = 'user-xyz-...'
GROUP BY l.make, l.model
ORDER BY dismissed_count DESC;
```

---

## `flipped_cars`

### 🎯 Purpose
**The Ledger (Ground Truth).**

A record of **actual completed deals**.

### 🔑 Key Concept
> **"This is real data. We use this to train future models and validate our predictions."**

**What We Track:**
- What we **predicted** the profit would be (`arbitrage_valuations.projected_profit`)
- What the **actual** profit was (`flipped_cars.actual_profit`)

**Why It Matters:**
- **Model Validation**: Are our Oracle values accurate? Are friction costs realistic?
- **Continuous Improvement**: Feed actual outcomes back into the valuation engine
- **Performance Metrics**: Show dealers their historical P&L

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`user_id`** | `uuid` | Who completed this flip | `user-xyz-...` |
| **`listing_id`** | `uuid` | Links to original listing | `listing-abc-...` |
| **`valuation_id`** | `uuid` | Links to original valuation | `valuation-def-...` |
| **`purchase_price`** | `numeric` | What user actually paid | `8500` (negotiated down from $9000) |
| **`purchase_date`** | `date` | When user bought it | `2025-11-30` |
| **`sale_price`** | `numeric` | What user sold it for | `11800` |
| **`sale_date`** | `date` | When user sold it | `2025-12-05` |
| **`actual_friction_costs`** | `jsonb` | Real costs incurred | `{"transport": 250, "recon": 350, ...}` |
| **`actual_profit`** | `numeric` | Real profit (computed) | `2700` |
| **`notes`** | `text` | User's reflection | `"Buyer paid cash, easy flip"` |
| **`created_at`** | `timestamp` | When record was created | `2025-12-06 09:00:00` |

---

### 🔗 Relationships

```sql
flipped_cars.user_id → users.id (Foreign Key)
flipped_cars.listing_id → listings.id (Foreign Key)
flipped_cars.valuation_id → arbitrage_valuations.id (Foreign Key, NULLABLE)
```

**Why is `valuation_id` nullable?**
- User might flip a car they found outside the system
- Historical deals imported before `arbitrage_valuations` existed

---

### 🧠 Critical Fields Explained

#### **`purchase_price` vs Original `listings.price`**

**Why track both?**
- **`listings.price`**: What the seller **asked** for
- **`purchase_price`**: What the buyer **actually paid** (after negotiation)

**Example:**
```sql
-- Listing: $9,000 asking price
-- User negotiated down to: $8,500
-- Savings: $500
```

This teaches the model:
- How much room there is for negotiation
- Which types of sellers are more flexible

---

#### **`actual_friction_costs` (JSONB)**

Stores the **real** costs incurred during the flip.

**Example:**
```json
{
  "transport": 250,
  "auction_fees": 380,
  "reconditioning": 350,
  "registration": 75,
  "holding_costs": 120,
  "misc": 50,
  "total": 1225
}
```

**Compare to Predicted:**
```sql
-- Predicted friction: $1,000
-- Actual friction: $1,225
-- Error: +$225 (model underestimated by 22.5%)
```

**Model Improvement:**
- Update friction cost estimates based on actuals
- Identify categories we consistently underestimate

---

#### **`actual_profit` (Computed)**

```
Actual Profit = Sale Price - Purchase Price - Total Friction Costs
```

**Example:**
```
Sale Price:         $11,800
Purchase Price:     - $8,500
Friction:           - $1,225
--------------------------
Actual Profit:      $2,075
```

**Compare to Predicted:**
```sql
-- Predicted profit (from arbitrage_valuations): $2,100
-- Actual profit (from flipped_cars): $2,075
-- Error: -$25 (1.2% error - VERY ACCURATE!)
```

---

### 📊 Model Validation Queries

#### 1. Calculate prediction accuracy
```sql
SELECT
  fc.id,
  av.projected_profit AS predicted,
  fc.actual_profit AS actual,
  fc.actual_profit - av.projected_profit AS error,
  ABS(fc.actual_profit - av.projected_profit) / NULLIF(av.projected_profit, 0) * 100 AS error_pct
FROM flipped_cars fc
JOIN arbitrage_valuations av ON fc.valuation_id = av.id
ORDER BY error_pct DESC;
```

#### 2. Average prediction accuracy
```sql
SELECT
  AVG(ABS(fc.actual_profit - av.projected_profit)) AS avg_error,
  AVG(ABS(fc.actual_profit - av.projected_profit) / NULLIF(av.projected_profit, 0) * 100) AS avg_error_pct
FROM flipped_cars fc
JOIN arbitrage_valuations av ON fc.valuation_id = av.id;
```

#### 3. User's lifetime P&L
```sql
SELECT
  user_id,
  COUNT(*) AS total_flips,
  SUM(actual_profit) AS total_profit,
  AVG(actual_profit) AS avg_profit_per_flip,
  AVG(sale_date - purchase_date) AS avg_days_to_flip
FROM flipped_cars
WHERE user_id = 'user-xyz-...'
GROUP BY user_id;
```

---

### 🎓 The Feedback Loop

```
┌─────────────────────────────────────────────────────────────┐
│  1. System predicts: "$2,100 profit" (arbitrage_valuations)│
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. User buys car, flips it, records outcome (flipped_cars) │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Actual profit: "$2,075"                                 │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Model learns:                                           │
│     - Friction costs were 22.5% higher than expected        │
│     - User negotiated $500 off asking price                 │
│     - Car sold in 5 days (liquidity tier = correct)         │
└─────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Update friction cost model for similar cars             │
│     - Increase reconditioning estimate for 2017 Civics      │
│     - Decrease transport estimate (user found cheaper)      │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎓 Summary

| Table | Purpose | Typical Size | Read Frequency | Write Frequency |
|-------|---------|--------------|----------------|-----------------|
| **`saved_deals`** | User watchlist | 100-1K rows per user | High | Medium |
| **`dismissed_deals`** | Rejected deals (training data) | 1K-10K rows per user | Medium | High |
| **`flipped_cars`** | Completed deals (ground truth) | 10-100 rows per user | Low | Very Low |

---

### 🔄 User Journey

```
1. User sees deal → Saves to watchlist (saved_deals)
2. User dismisses bad deals → Trains AI (dismissed_deals)
3. User completes flip → Records outcome (flipped_cars)
4. System learns → Improves predictions
5. Repeat
```

---

**Next:** Read [06_COMPLETE_SCHEMA_REFERENCE.md](./06_COMPLETE_SCHEMA_REFERENCE.md) for a quick lookup table of all columns.

---

**Last Updated**: 2025-11-30
