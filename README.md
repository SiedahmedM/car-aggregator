This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

---

## Local Run (Aggregator)

1) Set environment variables in `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=...                    # your Supabase URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...               # anon key (client)
SUPABASE_SERVICE_ROLE=...                       # service role key (server only)
```

2) Install and start:

```
npm install
npm run dev
```

Open http://localhost:3000 for the dashboard.

### Job Endpoint

Fetch Craigslist RSS, parse details (price, city, mileage, title status, VIN), and upsert into Supabase:

```
curl -s http://localhost:3000/api/jobs/craigslist
```

Returns JSON like `{ "ok": true, "inserted": 12, "skipped": 48 }`.

### Vercel Cron

Configure a Cron job to hit the endpoint every 5 minutes:

- Path: `/api/jobs/craigslist`
- Schedule: `*/5 * * * *`
- Region: your project region

Ensure your `public.sources` table contains enabled Craigslist RSS feed URLs.

---

## OfferUp Saved Searches (UI-triggered)

This adds a simple Saved Searches page and a lightweight job queue to run the existing Playwright OfferUp scraper with user-provided filters.

- UI: Visit `/offerup` to create searches for today (name, year/price/model filters, etc.). Click "Run Now" on any search or "Run All". If there are no searches for today, running will use the most recent day's saved searches.
- API: `/api/offerup/searches` (GET/POST), `/api/offerup/run` (POST).
- Worker: `npm run offerup:worker` claims a pending job from `public.offerup_jobs` and runs `scripts/offerup.ts` with env-based filter flags.

### Database schema

Run the SQL in `scripts/schema.sql` on your Supabase database (ensure `pgcrypto` is enabled for `gen_random_uuid()`):

```
psql "$SUPABASE_CONNECTION" -f scripts/schema.sql
```

Tables created:
- `public.offerup_searches(date_key, name, params jsonb, active)`
- `public.offerup_jobs(search_id, status, params jsonb, result, error)`

### OfferUp script filters

The OfferUp script now honors optional env vars (applied before upsert):
- `OU_FILTER_MIN_YEAR`, `OU_FILTER_MAX_YEAR`
- `OU_FILTER_MIN_PRICE`, `OU_FILTER_MAX_PRICE`
- `OU_FILTER_MODELS` (comma-separated substrings)
- `OU_FILTER_POSTED_WITHIN_HOURS` (e.g. 24)

The worker maps saved-search params to these env vars and executes the script via `tsx`.

Notes:
- Running Playwright in serverless (e.g., Vercel) is not recommended. Keep the worker on a long-lived host/VM/container with Chrome dependencies installed.
- Geolocation/UA settings remain as in `scripts/offerup.ts`; adjust `OU_LAT`, `OU_LNG`, `OU_RADIUS_MILES` per search if needed.
