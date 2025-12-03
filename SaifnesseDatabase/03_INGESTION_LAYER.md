# 🤖 Ingestion Layer (The "Workers")

> **These tables manage the robots that go out and find the cars.**

---

## Table of Contents
- [`sources`](#sources) - The Configuration
- [`offerup_searches`](#offerup_searches) - The Triggers
- [`offerup_jobs`](#offerup_jobs) - The Execution Logs
- [`deal_finder_jobs`](#deal_finder_jobs) - The Enrichment Jobs

---

## `sources`

### 🎯 Purpose
**The Configuration.**

Defines **where** we look for listings (e.g., "OfferUp", "Facebook Marketplace", "Craigslist").

### 🔑 Key Concept
> **"A source is a website we scrape, along with the technical details needed to scrape it."**

Each source has:
- A name (e.g., `"offerup"`)
- A base URL (e.g., `"https://offerup.com"`)
- Headers, cookies, and authentication details (stored in JSON)

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`name`** | `text` | Human-readable name | `"offerup"`, `"facebook"`, `"craigslist"` |
| **`base_url`** | `text` | Root URL of the website | `"https://offerup.com"` |
| **`config`** | `jsonb` | Technical scraping details (headers, cookies, etc.) | `{ "headers": {...}, "cookies": {...} }` |
| **`active`** | `boolean` | Is this source currently enabled? | `true`, `false` |
| **`created_at`** | `timestamp` | When this source was added | `2025-11-01 10:00:00` |

---

### 🧠 Critical Fields Explained

#### **`config` (JSONB)**

Stores all the technical details needed to scrape the source:

**Example:**
```json
{
  "headers": {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9"
  },
  "cookies": {
    "session_id": "abc123...",
    "location_preference": "92705"
  },
  "rate_limit": {
    "requests_per_minute": 10,
    "delay_between_requests_ms": 2000
  },
  "pagination": {
    "type": "cursor",
    "cursor_param": "next_cursor"
  }
}
```

**Why JSON?**
- Each source has different technical requirements
- Flexible: Can add new fields without schema migrations
- Version control: Can store multiple configs and switch between them

---

#### **`active`**

Boolean flag to enable/disable scraping from this source.

**Use Cases:**
- **Temporary Pause**: If a website changes and breaks our scraper, set `active = false` until we fix it.
- **Cost Control**: If a source requires expensive proxies, we can disable it to save money.
- **Legal/TOS**: If a website sends a cease-and-desist, we can disable it immediately.

---

### 📊 Common Queries

#### 1. Get all active sources
```sql
SELECT name, base_url
FROM sources
WHERE active = true;
```

#### 2. Update scraping config for OfferUp
```sql
UPDATE sources
SET config = jsonb_set(
  config,
  '{rate_limit,requests_per_minute}',
  '5'
)
WHERE name = 'offerup';
```

---

## `offerup_searches`

### 🎯 Purpose
**The Triggers.**

Defines **what** the robots should look for when scraping OfferUp.

### 🔑 Key Concept
> **"A search is a saved query with specific criteria."**

Examples:
- "Honda Civic in 92705, Price < $5k, Year > 2015"
- "Toyota Tacoma in Los Angeles, Mileage < 100k"

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`name`** | `text` | Human-readable label | `"LA Civics Under 5k"` |
| **`params`** | `jsonb` | Search criteria | `{ "make": "Honda", "model": "Civic", "max_price": 5000 }` |
| **`active`** | `boolean` | Is this search currently running? | `true`, `false` |
| **`schedule`** | `text` | How often to run (cron format) | `"0 */2 * * *"` (every 2 hours) |
| **`created_at`** | `timestamp` | When this search was created | `2025-11-15 09:00:00` |

---

### 🧠 Critical Fields Explained

#### **`params` (JSONB)**

Stores the search criteria in a flexible JSON structure:

**Example:**
```json
{
  "make": "Honda",
  "model": "Civic",
  "min_year": 2015,
  "max_year": 2025,
  "min_price": 3000,
  "max_price": 8000,
  "max_mileage": 100000,
  "zip_code": "92705",
  "radius_miles": 50,
  "keywords": ["clean title", "single owner"]
}
```

**Why JSON?**
- Different searches may have different criteria
- Easy to add new filters without schema changes
- Can be serialized directly into API query strings

---

#### **`schedule` (Cron Format)**

Defines how often this search should run.

**Common Patterns:**
- `"0 */2 * * *"` → Every 2 hours
- `"0 8 * * *"` → Every day at 8 AM
- `"0 */15 * * *"` → Every 15 minutes (high-velocity monitoring)

**Implementation:**
Our job scheduler reads this column and triggers `offerup_jobs` accordingly.

---

### 📊 Common Queries

#### 1. Get all active searches
```sql
SELECT name, params->>'make' AS make, params->>'model' AS model
FROM offerup_searches
WHERE active = true;
```

#### 2. Create a new search
```sql
INSERT INTO offerup_searches (name, params, active, schedule)
VALUES (
  'LA Tacomas Under 15k',
  '{"make": "Toyota", "model": "Tacoma", "max_price": 15000, "zip_code": "90001", "radius_miles": 50}'::jsonb,
  true,
  '0 */2 * * *'
);
```

---

## `offerup_jobs`

### 🎯 Purpose
**The Execution Logs.**

Tracks every time a scraper runs.

### 🔑 Key Concept
> **"A job is a single execution of a search."**

When `offerup_searches` triggers a scrape, it creates a new row in `offerup_jobs` to track:
- Status (Running, Finished, Error)
- How many listings were found
- Any errors that occurred

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`search_id`** | `uuid` | Links to `offerup_searches.id` | `xyz-...` |
| **`status`** | `text` | Job state | `"running"`, `"finished"`, `"error"` |
| **`result`** | `jsonb` | Summary of results | `{ "listings_found": 15, "new_listings": 8 }` |
| **`error_message`** | `text` | Error details (if failed) | `"Network timeout after 30s"` |
| **`run_now`** | `boolean` | Flag to force immediate execution | `true`, `false` |
| **`started_at`** | `timestamp` | When the job started | `2025-11-30 08:00:00` |
| **`finished_at`** | `timestamp` | When the job completed | `2025-11-30 08:05:23` |
| **`created_at`** | `timestamp` | When the job was queued | `2025-11-30 07:59:58` |

---

### 🔗 Relationships

```sql
offerup_jobs.search_id → offerup_searches.id (Foreign Key)
```

---

### 🧠 Critical Fields Explained

#### **`status`**

Tracks the lifecycle of the job:

| Status | Meaning |
|--------|---------|
| `"pending"` | Job is queued but hasn't started |
| `"running"` | Job is currently executing |
| `"finished"` | Job completed successfully |
| `"error"` | Job failed (see `error_message`) |

**Use Cases:**
- **Monitoring**: Dashboard showing how many jobs are currently running
- **Debugging**: Filter by `status = 'error'` to find failures
- **Performance**: Calculate average job duration (`finished_at - started_at`)

---

#### **`result` (JSONB)**

Stores a summary of what the job accomplished:

**Example:**
```json
{
  "listings_found": 15,
  "new_listings": 8,
  "updated_listings": 5,
  "skipped_listings": 2,
  "pages_scraped": 3,
  "duration_ms": 23456
}
```

**Use Cases:**
- **Success Metrics**: How many new listings did we find?
- **Performance Tracking**: How long did the job take?
- **Anomaly Detection**: If `listings_found = 0`, something might be broken.

---

#### **`run_now`**

Boolean flag to force immediate execution (bypasses schedule).

**Use Cases:**
- **Manual Trigger**: User clicks "Refresh Now" in the UI
- **Testing**: Force a job to run during development
- **Incident Response**: If we detect a hot deal, trigger all related searches immediately

**Example:**
```sql
-- Force a search to run immediately
UPDATE offerup_jobs
SET run_now = true
WHERE search_id = 'xyz-...'
  AND status = 'pending';
```

---

### 📊 Common Queries

#### 1. Get all running jobs
```sql
SELECT id, status, started_at,
       NOW() - started_at AS duration
FROM offerup_jobs
WHERE status = 'running';
```

#### 2. Find failed jobs in the last 24 hours
```sql
SELECT id, error_message, started_at
FROM offerup_jobs
WHERE status = 'error'
  AND started_at > NOW() - INTERVAL '24 hours'
ORDER BY started_at DESC;
```

#### 3. Calculate average job duration
```sql
SELECT AVG(finished_at - started_at) AS avg_duration
FROM offerup_jobs
WHERE status = 'finished';
```

---

## `deal_finder_jobs`

### 🎯 Purpose
**The Enrichment Jobs.**

Tracks execution of the "Deal Finder" script, which:
1. Reads raw listings from the `listings` table
2. Calculates arbitrage opportunities (Oracle Value - Ask Price - Friction)
3. Writes results to `arbitrage_valuations`

### 🔑 Key Concept
> **"The Deal Finder transforms raw listings into intelligent opportunities."**

While `offerup_jobs` **scrapes** the internet, `deal_finder_jobs` **analyzes** the data we already have.

---

### 📋 Schema

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| **`id`** | `uuid` | Internal unique identifier | `a1b2c3d4-...` |
| **`status`** | `text` | Job state | `"running"`, `"finished"`, `"error"` |
| **`result`** | `jsonb` | Summary of results | `{ "deals_found": 12, "avg_profit": 2300 }` |
| **`error_message`** | `text` | Error details (if failed) | `"Oracle API timeout"` |
| **`run_now`** | `boolean` | Flag to force immediate execution | `true`, `false` |
| **`started_at`** | `timestamp` | When the job started | `2025-11-30 09:00:00` |
| **`finished_at`** | `timestamp` | When the job completed | `2025-11-30 09:03:45` |

---

### 🧠 Critical Fields Explained

#### **`result` (JSONB)**

Stores metrics about the enrichment run:

**Example:**
```json
{
  "listings_analyzed": 150,
  "deals_found": 12,
  "avg_profit": 2300,
  "max_profit": 5100,
  "oracle_calls": 150,
  "oracle_errors": 3,
  "duration_ms": 45000
}
```

**Use Cases:**
- **Performance Monitoring**: How long does enrichment take?
- **Quality Metrics**: What's the average profit of deals we're finding?
- **Cost Tracking**: How many Oracle API calls did we make?

---

### 📊 Common Queries

#### 1. Get the latest enrichment run
```sql
SELECT result->>'deals_found' AS deals,
       result->>'avg_profit' AS avg_profit,
       finished_at
FROM deal_finder_jobs
WHERE status = 'finished'
ORDER BY finished_at DESC
LIMIT 1;
```

#### 2. Track Oracle API usage
```sql
SELECT SUM((result->>'oracle_calls')::int) AS total_calls,
       AVG((result->>'oracle_calls')::int) AS avg_per_job
FROM deal_finder_jobs
WHERE status = 'finished'
  AND started_at > NOW() - INTERVAL '7 days';
```

---

## 🎓 Summary

| Table | Purpose | Typical Size | Read Frequency | Write Frequency |
|-------|---------|--------------|----------------|-----------------|
| **`sources`** | Website configurations | 5-20 rows | Low | Very Low |
| **`offerup_searches`** | Search criteria | 10-100 rows | Medium | Low |
| **`offerup_jobs`** | Scraping execution logs | 1K-10K rows | High | High (during scrapes) |
| **`deal_finder_jobs`** | Enrichment execution logs | 100-1K rows | Medium | Medium |

---

**Next:** Read [04_INTELLIGENCE_LAYER.md](./04_INTELLIGENCE_LAYER.md) to understand how we calculate profit from raw listings.

---

**Last Updated**: 2025-11-30
