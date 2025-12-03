# 📦 Core Data Layer (The "Library")

> **These tables store the raw assets. They are the "Content."**

---

## Table of Contents
- [`listings`](#listings) - The Master Record
- [`raw_html`](#raw_html) - The Evidence Locker

---

## `listings`

### 🎯 Purpose
**The Master Record.** Every car found on the internet ends up here.

This table normalizes data from different sources (OfferUp, Facebook, Craigslist) into a single, unified format.

### 🔑 Key Concept
> **"One Source of Truth for All Assets"**

No matter where a car comes from (OfferUp, Facebook, Craigslist), it gets stored in the same schema. This allows us to query across all sources simultaneously.

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier (Primary Key) | `a1b2c3d4-...` |
| **`source`** | `text` | Where we found it | `"offerup"`, `"facebook"`, `"craigslist"` |
| **`remote_id`** | `text` | The ID from the source website | `"fb-12345"`, `"ou-98765"` |
| **`remote_slug`** | `text` | URL-friendly identifier from source | `"2017-honda-civic-92705"` |
| **`url`** | `text` | Full URL to the original listing | `"https://offerup.com/item/..."` |
| **`title`** | `text` | Listing title | `"2017 Honda Civic - Clean Title"` |
| **`price`** | `integer` | Asking price in USD | `9000` |
| **`mileage`** | `integer` | Odometer reading | `87000` |
| **`year`** | `integer` | Model year | `2017` |
| **`make`** | `text` | Manufacturer | `"Honda"` |
| **`model`** | `text` | Model name | `"Civic"` |
| **`city`** | `text` | Location | `"Irvine"` |
| **`posted_at`** | `timestamp` | When listing was created (source time) | `2025-11-29 14:30:00` |
| **`first_seen_at`** | `timestamp` | When **we** first scraped it | `2025-11-30 08:00:00` |
| **`last_seen_at`** | `timestamp` | When **we** last saw it active | `2025-11-30 21:00:00` |
| **`seen_count`** | `integer` | How many times we've seen it | `3` |
| **`is_new`** | `boolean` | Is this the first time we've seen it? | `true`, `false` |
| **`raw_payload`** | `jsonb` | Full original JSON from source | `{ ... }` |

---

### 🔗 Relationships

```sql
-- Foreign Keys IN
(none - this is the root table)

-- Foreign Keys OUT
arbitrage_valuations.listing_id → listings.id
deal_scores.listing_id → listings.id
saved_deals.listing_id → listings.id
dismissed_deals.listing_id → listings.id
```

---

### 🧠 Critical Fields Explained

#### **`source` + `remote_id`** (Composite Unique Key)
These two fields together form a **unique constraint**:
```sql
UNIQUE(source, remote_id)
```

**Why?**
- Prevents duplicate listings when scrapers run multiple times
- Allows upsert logic: "If this `(source, remote_id)` exists, update it. Otherwise, insert."

**Example:**
```sql
-- First scrape
INSERT INTO listings (source, remote_id, price, ...)
VALUES ('offerup', 'ou-12345', 9000, ...)
ON CONFLICT (source, remote_id) DO UPDATE SET price = EXCLUDED.price;

-- Second scrape (same listing, price changed)
-- This will UPDATE the existing row, not create a duplicate
```

---

#### **`first_seen_at` vs `last_seen_at` vs `posted_at`**

| Field | Source | Purpose |
|-------|--------|---------|
| `posted_at` | From the listing itself (OfferUp timestamp) | When the **seller** created the listing |
| `first_seen_at` | Our scraper | When **we** first discovered it |
| `last_seen_at` | Our scraper | When **we** last confirmed it still exists |

**Use Case: Primitive Liquidity Tracking**

If a car is no longer being updated in our database, it probably sold:
```sql
-- Cars that haven't been seen in 3+ days (likely sold)
SELECT * FROM listings
WHERE last_seen_at < NOW() - INTERVAL '3 days';
```

---

#### **`seen_count`**

Tracks how many times we've encountered this listing during scrapes.

**Use Cases:**
- **Seller Desperation Signal**: If `seen_count` is high (e.g., 10+), the car has been on the market for weeks. Seller may be desperate → higher chance of negotiation.
- **Stale Listing Detection**: High `seen_count` but low interest → might be overpriced or damaged.

**Example:**
```sql
-- Listings that have been reposted 5+ times (seller is desperate)
SELECT title, price, seen_count, first_seen_at
FROM listings
WHERE seen_count >= 5
ORDER BY seen_count DESC;
```

---

#### **`is_new`**

Boolean flag indicating if this is the first time we've seen this listing.

**Use Cases:**
- **Alert Systems**: Show dealers **only** new listings since last check
- **Feed Prioritization**: Prioritize new listings in the UI (fresh inventory)

**Example:**
```sql
-- Show me only brand-new listings from the last scrape
SELECT * FROM listings
WHERE is_new = true
ORDER BY first_seen_at DESC;
```

---

#### **`raw_payload`**

Stores the **full original JSON** from the source website.

**Why Keep It?**
1. **Debugging**: If we discover we missed a field (e.g., "transmission type"), we can extract it from `raw_payload` without re-scraping.
2. **Schema Evolution**: As we add new columns, we can backfill data from existing `raw_payload` values.
3. **Legal Evidence**: If a seller claims fraud, we have proof of what they originally posted.

**Example:**
```json
{
  "listingId": "ou-12345",
  "title": "2017 Honda Civic",
  "price": 9000,
  "seller": {
    "name": "John Doe",
    "rating": 4.8,
    "responseTime": "< 1 hour"
  },
  "images": ["https://...", "https://..."],
  "description": "Moving out of state, must sell fast!"
}
```

Later, we realize we want to track `seller.responseTime`:
```sql
-- Backfill seller response time from raw_payload
UPDATE listings
SET seller_response_time = (raw_payload->'seller'->>'responseTime')
WHERE raw_payload->'seller'->>'responseTime' IS NOT NULL;
```

---

### 📊 Common Queries

#### 1. Find all cars under $10k with low mileage
```sql
SELECT title, price, mileage, url
FROM listings
WHERE price < 10000
  AND mileage < 100000
  AND is_new = true
ORDER BY price ASC;
```

#### 2. Find cars that disappeared (likely sold)
```sql
SELECT title, price, first_seen_at, last_seen_at,
       (last_seen_at - first_seen_at) AS time_on_market
FROM listings
WHERE last_seen_at < NOW() - INTERVAL '2 days'
ORDER BY time_on_market ASC;
```

#### 3. Track price changes for a specific car
```sql
-- Requires audit log or raw_payload history (future feature)
-- For now, we only keep the latest price
```

---

## `raw_html`

### 🎯 Purpose
**The Evidence Locker.**

Stores the raw HTML strings captured during scraping (for OfferUp detail pages, etc.).

### 🔑 Key Concept
> **"If the parser breaks, we can replay the HTML to fix the data without re-scraping."**

Web scraping is fragile. Websites change their HTML structure frequently. When that happens, our parsers break. Instead of losing data, we:
1. Store the raw HTML in this table
2. Fix the parser
3. Re-run the parser on stored HTML to extract missing fields

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`listing_id`** | `uuid` | Links to `listings.id` | `xyz-...` |
| **`html_content`** | `text` | The raw HTML string | `"<html><body>...</body></html>"` |
| **`url`** | `text` | The URL that was scraped | `"https://offerup.com/item/..."` |
| **`scraped_at`** | `timestamp` | When we captured it | `2025-11-30 08:15:00` |

---

### 🔗 Relationships

```sql
raw_html.listing_id → listings.id (Foreign Key)
```

---

### 📊 Common Use Cases

#### 1. Debugging a broken parser
```sql
-- Get the HTML for a specific listing
SELECT html_content
FROM raw_html
WHERE listing_id = 'xyz-...';
```

Then, manually inspect the HTML to see why the parser failed.

#### 2. Backfilling missing data
```sql
-- Get all HTML for listings missing mileage
SELECT rh.html_content, l.id
FROM raw_html rh
JOIN listings l ON rh.listing_id = l.id
WHERE l.mileage IS NULL;
```

Run the fixed parser on these HTML strings to extract the missing mileage values.

---

### ⚠️ Storage Considerations

HTML strings are **large** (typically 50KB - 500KB per page).

**Current Strategy:**
- Store HTML only for listings that passed initial filters
- Automatically delete HTML older than 30 days (configurable)

**Future Optimization:**
- Compress HTML using `gzip` before storage
- Store in cheaper object storage (S3) instead of Postgres

---

## 🎓 Summary

| Table | Role | Size (Typical) | Read Frequency | Write Frequency |
|-------|------|----------------|----------------|-----------------|
| **`listings`** | Master record of all assets | 100K - 1M rows | **Very High** | High (during scrapes) |
| **`raw_html`** | Debugging backup | 10K - 100K rows | Low (only when debugging) | High (during scrapes) |

---

**Next:** Read [03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md) to understand how scrapers populate these tables.

---

**Last Updated**: 2025-11-30
