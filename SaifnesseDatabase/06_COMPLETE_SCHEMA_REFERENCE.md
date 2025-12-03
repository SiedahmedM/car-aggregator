# 📖 Complete Schema Reference

> **Quick lookup for every table and column in the Saifnesse database.**

---

## How to Use This Reference

1. **Find your table** in the alphabetical list below
2. **Scan the columns** to understand what data it contains
3. **Check relationships** to see how tables connect
4. **Read the layer docs** for detailed explanations

---

## Table Index (Alphabetical)

- [`arbitrage_valuations`](#arbitrage_valuations) ⭐
- [`deal_finder_jobs`](#deal_finder_jobs)
- [`deal_scores`](#deal_scores) (Legacy)
- [`dismissed_deals`](#dismissed_deals)
- [`flipped_cars`](#flipped_cars)
- [`listings`](#listings)
- [`offerup_jobs`](#offerup_jobs)
- [`offerup_searches`](#offerup_searches)
- [`raw_html`](#raw_html)
- [`saved_deals`](#saved_deals)
- [`sources`](#sources)

---

## `arbitrage_valuations` ⭐

**Layer:** Intelligence (The New Engine)
**Purpose:** Calculate profit-based arbitrage opportunities
**Read More:** [04_INTELLIGENCE_LAYER.md](./04_INTELLIGENCE_LAYER.md#arbitrage_valuations)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `listing_id` | uuid | NO | - | → `listings.id` |
| `asset_type` | text | NO | - | `"Vehicle"`, `"Real Estate"`, etc. |
| `liquidity_tier` | liquidity_spectrum | NO | `MEDIUM_VELOCITY` | Time to sell |
| `complexity_tier` | complexity_index | NO | `MEDIUM_COMPLEXITY` | Difficulty to value |
| `projected_profit` | numeric | YES (computed) | - | **MOST IMPORTANT** (auto-calculated) |
| `valuation_data` | jsonb | NO | - | The "Spirit" (Oracle, friction, signals) |
| `created_at` | timestamp | NO | now() | When created |
| `updated_at` | timestamp | NO | now() | When updated |

**Indexes:**
- `idx_projected_profit` on `projected_profit DESC` (The "Bloomberg" Index)

**Foreign Keys:**
- `listing_id` → `listings.id` (ON DELETE CASCADE)

---

## `deal_finder_jobs`

**Layer:** Ingestion (Workers)
**Purpose:** Track execution of enrichment/valuation scripts
**Read More:** [03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md#deal_finder_jobs)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `status` | text | NO | `pending` | `running`, `finished`, `error` |
| `result` | jsonb | YES | - | Summary of results |
| `error_message` | text | YES | - | Error details |
| `run_now` | boolean | NO | false | Force immediate execution |
| `started_at` | timestamp | YES | - | When job started |
| `finished_at` | timestamp | YES | - | When job completed |

---

## `deal_scores`

**Layer:** Intelligence (Legacy)
**Purpose:** Statistical KNN-based deal scoring (being replaced)
**Read More:** [04_INTELLIGENCE_LAYER.md](./04_INTELLIGENCE_LAYER.md#deal_scores)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `listing_id` | uuid | NO | - | → `listings.id` |
| `score` | numeric | NO | - | Statistical score (higher = better) |
| `knn_neighbors` | jsonb | YES | - | Similar cars used for comparison |
| `avg_price` | numeric | YES | - | Average price of neighbors |
| `price_deviation` | numeric | YES | - | Deviation from average |
| `created_at` | timestamp | NO | now() | When created |

**Foreign Keys:**
- `listing_id` → `listings.id`

---

## `dismissed_deals`

**Layer:** User Action
**Purpose:** Track deals user rejected (trains AI)
**Read More:** [05_USER_ACTION_LAYER.md](./05_USER_ACTION_LAYER.md#dismissed_deals)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | - | → `users.id` |
| `listing_id` | uuid | NO | - | → `listings.id` |
| `reason` | text | YES | - | Why dismissed (`"Salvage"`, `"Scam"`, etc.) |
| `dismissed_at` | timestamp | NO | now() | When dismissed |

**Foreign Keys:**
- `user_id` → `users.id`
- `listing_id` → `listings.id`

---

## `flipped_cars`

**Layer:** User Action
**Purpose:** Ground truth (completed deals, actual profit)
**Read More:** [05_USER_ACTION_LAYER.md](./05_USER_ACTION_LAYER.md#flipped_cars)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | - | → `users.id` |
| `listing_id` | uuid | NO | - | → `listings.id` |
| `valuation_id` | uuid | YES | - | → `arbitrage_valuations.id` |
| `purchase_price` | numeric | NO | - | Actual purchase price |
| `purchase_date` | date | NO | - | When bought |
| `sale_price` | numeric | NO | - | Actual sale price |
| `sale_date` | date | NO | - | When sold |
| `actual_friction_costs` | jsonb | YES | - | Real costs (transport, recon, etc.) |
| `actual_profit` | numeric | YES (computed) | - | `sale_price - purchase_price - friction` |
| `notes` | text | YES | - | User's reflection |
| `created_at` | timestamp | NO | now() | When created |

**Foreign Keys:**
- `user_id` → `users.id`
- `listing_id` → `listings.id`
- `valuation_id` → `arbitrage_valuations.id` (nullable)

---

## `listings`

**Layer:** Core Data (The Library)
**Purpose:** Master record of all assets
**Read More:** [02_CORE_DATA_LAYER.md](./02_CORE_DATA_LAYER.md#listings)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `source` | text | NO | - | `"offerup"`, `"facebook"`, etc. |
| `remote_id` | text | NO | - | ID from source website |
| `remote_slug` | text | YES | - | URL-friendly identifier |
| `url` | text | NO | - | Full URL to listing |
| `title` | text | YES | - | Listing title |
| `price` | integer | YES | - | Asking price (USD) |
| `mileage` | integer | YES | - | Odometer reading |
| `year` | integer | YES | - | Model year |
| `make` | text | YES | - | Manufacturer |
| `model` | text | YES | - | Model name |
| `city` | text | YES | - | Location |
| `posted_at` | timestamp | YES | - | When seller posted (source time) |
| `first_seen_at` | timestamp | NO | now() | When we first scraped it |
| `last_seen_at` | timestamp | NO | now() | When we last saw it active |
| `seen_count` | integer | NO | 1 | How many times scraped |
| `is_new` | boolean | NO | true | First time seeing this? |
| `raw_payload` | jsonb | YES | - | Full original JSON from source |

**Unique Constraints:**
- `UNIQUE(source, remote_id)` (prevents duplicates)

**Indexes:**
- `idx_source_remote_id` on `(source, remote_id)`
- `idx_posted_at` on `posted_at DESC`
- `idx_price` on `price`

---

## `offerup_jobs`

**Layer:** Ingestion (Workers)
**Purpose:** Track scraper execution
**Read More:** [03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md#offerup_jobs)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `search_id` | uuid | NO | - | → `offerup_searches.id` |
| `status` | text | NO | `pending` | `running`, `finished`, `error` |
| `result` | jsonb | YES | - | Summary (`listings_found`, etc.) |
| `error_message` | text | YES | - | Error details |
| `run_now` | boolean | NO | false | Force immediate execution |
| `started_at` | timestamp | YES | - | When job started |
| `finished_at` | timestamp | YES | - | When job completed |
| `created_at` | timestamp | NO | now() | When queued |

**Foreign Keys:**
- `search_id` → `offerup_searches.id`

---

## `offerup_searches`

**Layer:** Ingestion (Workers)
**Purpose:** Define search criteria for scrapers
**Read More:** [03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md#offerup_searches)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `name` | text | NO | - | Human-readable label |
| `params` | jsonb | NO | - | Search criteria (make, model, price, etc.) |
| `active` | boolean | NO | true | Is this search enabled? |
| `schedule` | text | YES | - | Cron format (`"0 */2 * * *"`) |
| `created_at` | timestamp | NO | now() | When created |

---

## `raw_html`

**Layer:** Core Data (The Library)
**Purpose:** Store raw HTML for debugging
**Read More:** [02_CORE_DATA_LAYER.md](./02_CORE_DATA_LAYER.md#raw_html)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `listing_id` | uuid | NO | - | → `listings.id` |
| `html_content` | text | NO | - | Raw HTML string |
| `url` | text | NO | - | URL that was scraped |
| `scraped_at` | timestamp | NO | now() | When captured |

**Foreign Keys:**
- `listing_id` → `listings.id`

---

## `saved_deals`

**Layer:** User Action
**Purpose:** User's watchlist
**Read More:** [05_USER_ACTION_LAYER.md](./05_USER_ACTION_LAYER.md#saved_deals)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `user_id` | uuid | NO | - | → `users.id` |
| `listing_id` | uuid | NO | - | → `listings.id` |
| `valuation_id` | uuid | YES | - | → `arbitrage_valuations.id` |
| `notes` | text | YES | - | User's private notes |
| `saved_at` | timestamp | NO | now() | When saved |

**Foreign Keys:**
- `user_id` → `users.id`
- `listing_id` → `listings.id`
- `valuation_id` → `arbitrage_valuations.id` (nullable)

---

## `sources`

**Layer:** Ingestion (Workers)
**Purpose:** Define websites to scrape
**Read More:** [03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md#sources)

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `name` | text | NO | - | `"offerup"`, `"facebook"`, etc. |
| `base_url` | text | NO | - | Root URL (`"https://offerup.com"`) |
| `config` | jsonb | YES | - | Headers, cookies, rate limits |
| `active` | boolean | NO | true | Is this source enabled? |
| `created_at` | timestamp | NO | now() | When created |

---

## Entity Relationship Diagram

```
┌─────────────┐
│   sources   │
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ offerup_searches │
└──────┬───────────┘
       │
       ▼
┌────────────────┐       ┌──────────┐
│  offerup_jobs  │       │  users   │
└────────────────┘       └────┬─────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
┌──────────────┐       ┌─────────────┐       ┌───────────────┐
│  raw_html    │       │ saved_deals │       │dismissed_deals│
└──────┬───────┘       └──────┬──────┘       └───────┬───────┘
       │                      │                      │
       │                      │                      │
       ▼                      ▼                      ▼
┌────────────────────────────────────────────────────────┐
│                      listings                          │
└────────────┬───────────────────────┬───────────────────┘
             │                       │
             ▼                       ▼
   ┌──────────────────┐    ┌─────────────────────────┐
   │   deal_scores    │    │ arbitrage_valuations ⭐ │
   │    (Legacy)      │    └───────────┬─────────────┘
   └──────────────────┘                │
                                       ▼
                                ┌──────────────┐
                                │ flipped_cars │
                                └──────────────┘
```

---

## Custom Types (Enums)

### `liquidity_spectrum`

Classifies how fast an asset sells.

| Value | Meaning |
|-------|---------|
| `HIGH_VELOCITY` | < 7 days |
| `MEDIUM_VELOCITY` | < 30 days |
| `LOW_VELOCITY` | < 6 months |
| `ILLIQUID` | 6+ months |

### `complexity_index`

Classifies how difficult an asset is to value.

| Value | Meaning |
|-------|---------|
| `LOW_COMPLEXITY` | Simple (Year/Make/Model) |
| `MEDIUM_COMPLEXITY` | Requires inspection |
| `HIGH_COMPLEXITY` | Proprietary modeling |

---

## Most Important Queries

### 1. Top Deals (The "Golden Path")
```sql
SELECT
  l.title,
  l.price AS ask_price,
  av.projected_profit,
  av.liquidity_tier,
  l.url
FROM arbitrage_valuations av
JOIN listings l ON av.listing_id = l.id
WHERE av.projected_profit > 2000
  AND av.liquidity_tier = 'HIGH_VELOCITY'
ORDER BY av.projected_profit DESC
LIMIT 10;
```

### 2. Model Accuracy (Predicted vs Actual)
```sql
SELECT
  AVG(ABS(fc.actual_profit - av.projected_profit)) AS avg_error,
  AVG(ABS(fc.actual_profit - av.projected_profit) / av.projected_profit * 100) AS avg_error_pct
FROM flipped_cars fc
JOIN arbitrage_valuations av ON fc.valuation_id = av.id;
```

### 3. Scraper Health Check
```sql
SELECT
  status,
  COUNT(*) AS count,
  AVG(EXTRACT(EPOCH FROM (finished_at - started_at))) AS avg_duration_sec
FROM offerup_jobs
WHERE started_at > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

---

## Table Size Estimates

| Table | Typical Rows | Growth Rate |
|-------|--------------|-------------|
| `listings` | 100K - 1M | High (scraping) |
| `arbitrage_valuations` | 10K - 100K | Medium (enrichment) |
| `raw_html` | 10K - 100K | High (scraping) |
| `offerup_jobs` | 1K - 10K | Medium (scheduled) |
| `deal_scores` | 10K - 100K | Low (legacy) |
| `saved_deals` | 100 - 1K per user | Low |
| `dismissed_deals` | 1K - 10K per user | Medium |
| `flipped_cars` | 10 - 100 per user | Very Low |

---

**Last Updated**: 2025-11-30
