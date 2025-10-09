// scripts/offerup.ts
import { chromium, Page } from 'playwright';
import pRetry from 'p-retry';
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

// ---------- Supabase (env-driven; DO NOT hardcode secrets) ----------
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!;
if (!SUPA_URL || !SUPA_KEY) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE in env.');
}
const supaSvc = createClient(SUPA_URL, SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- Env knobs ----------
const SEARCH_URL = process.env.OFFERUP_URL || 'https://offerup.com/explore/k/cars-trucks';
const MAX = parseInt(process.env.OU_MAX_ITEMS || '40', 10);
const SCROLLS = parseInt(process.env.OU_SCROLL_PASSES || '6', 10);
const HEADLESS = (process.env.OU_HEADLESS ?? 'true').toLowerCase() === 'true';
const LAT = Number(process.env.OU_LAT ?? '33.8166');
const LNG = Number(process.env.OU_LNG ?? '-118.0373');
const RADIUS = parseInt(process.env.OU_RADIUS_MILES || '35', 10);
const allowedCities = (process.env.OU_ALLOWED_CITIES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---------- Helpers ----------
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min=200, max=450) { return Math.floor(Math.random()*(max-min+1))+min; }
function parseMi(s?: string|null): number|null {
  if (!s) return null;
  const m = s.match(/(\d{1,3})\s*mi\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function normCity(raw?: string|null): string|null {
  if (!raw) return null;
  let c = raw.replace(/\u2022/g, '•'); // normalize bullet
  c = c.includes('•') ? c.split('•').pop()!.trim() : c;
  c = c.split(',')[0].trim();
  c = c.replace(/\s+ca?$/i, '').trim();
  return c || null;
}

type FeedItem = {
  id: string;
  url: string;
  city: string | null;
  distanceMi: number | null;
  title?: string | null;
  price?: number | null;
};

// Parse OfferUp's embedded Next.js JSON for clean tiles
async function readNextData(page: Page): Promise<FeedItem[]> {
  const raw = await page.locator('#__NEXT_DATA__').first().textContent().catch(() => null);
  if (!raw) return [];
  const json = JSON.parse(raw);
  const tiles = json?.props?.pageProps?.searchFeedResponse?.looseTiles || [];
  const items: FeedItem[] = [];
  for (const t of tiles) {
    if (t?.tileType !== 'LISTING' || !t?.listing) continue;
    const L = t.listing;
    const id = L?.listingId || L?.id;
    const slug = L?.slug || L?.listingId;
    if (!id || !slug) continue;
    const url = `https://offerup.com/item/detail/${slug}`;
    // locationName may be like 'Cypress, CA'
    const city = normCity(L?.locationName || L?.sellerLocationName || null);
    // distanceMiles may be numeric in JSON
    const distanceMi = L?.distanceMiles != null ? Math.round(Number(L.distanceMiles)) : null;
    const title = L?.title ?? null;
    const price = L?.price != null ? Math.round(Number(L.price)) : null;
    items.push({ id: String(id), url, city, distanceMi, title, price });
  }
  return items;
}

// Fallback extractor: scrape anchors & aria-label text for location
async function readFromAria(page: Page): Promise<FeedItem[]> {
  const anchors = await page.$$('[data-testid="feed-item-card"] a[href*="/item/detail/"], a[href*="/item/detail/"]');
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const a of anchors) {
    const href = await a.getAttribute('href');
    if (!href || !/\/item\/detail\/[a-z0-9-]+/i.test(href)) continue;
    const url = new URL(href, 'https://offerup.com').toString();
    const id = url.match(/\/item\/detail\/([^/?#]+)/)?.[1] || null;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // aria-label often contains "... in City, ST" or includes distance
    const aria = (await a.getAttribute('aria-label')) || '';
    const titleAttr = aria.replace(/\s+/g, ' ').trim();
    const distanceMi = parseMi(titleAttr);
    const city = normCity(titleAttr);
    out.push({ id, url, city, distanceMi });
  }
  return out;
}

async function confirmGeo(p: Page) {
  await p.evaluate(() => new Promise<void>(res => {
    try { navigator.geolocation.getCurrentPosition(() => res(), () => res()); }
    catch { res(); }
  }));
  await p.waitForTimeout(700);
}

  async function setOfferUpLocation(page: Page, zip: string) {
    // Go to the location page & wait for the location input to be interactive
    await page.goto('https://offerup.com/location', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Location input (try several possibilities)
    const input =
      page.getByRole('textbox', { name: /location/i }).first()
        .or(page.locator('input[placeholder*="City"], input[placeholder*="zip"], input[aria-label*="Location"]').first());

    await input.waitFor({ state: 'visible', timeout: 15_000 });
    await input.click({ timeout: 5_000 });
    await input.fill(zip, { timeout: 5_000 });

    // Wait a moment for suggestions to populate, then press Enter
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');

    // Some builds show a confirm/apply button — click if present
    const apply = page.getByRole('button', { name: /(apply|use|save)/i }).first();
    if (await apply.count()) {
      await apply.click({ timeout: 5_000 }).catch(() => {});
    }

    // Give the app a beat to persist & rehydrate its location store
    await page.waitForTimeout(1200);
  }

async function run() {
  // ---------- Browser/Context ----------
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    geolocation: { latitude: LAT, longitude: LNG },
    permissions: ['geolocation'],
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    viewport: { width: 430, height: 860 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
  });
  await ctx.grantPermissions(['geolocation'], { origin: 'https://offerup.com' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await ctx.newPage();

  // ---------- Prime & Nudge ----------
  await pRetry(async () => {
    await page.goto('https://offerup.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const accept = page.locator('button:has-text("Accept")');
    if (await accept.count().catch(() => 0)) await accept.first().click({ timeout: 3000 }).catch(() => {});
    await confirmGeo(page);
  }, { retries: 2, minTimeout: 800 });

  await pRetry(async () => {
    await page.goto('https://offerup.com/location', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await confirmGeo(page);
  }, { retries: 2, minTimeout: 800 });

  // NEW: force zip 90630 using the UI
  await pRetry(async () => { await setOfferUpLocation(page, '90630'); }, { retries: 2, minTimeout: 800 });

  // ---------- Category ----------
  console.log('Navigating category:', SEARCH_URL);
await pRetry(async () => {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // One regex that matches both straight and curly apostrophes:
  const sorry = page.getByText(/Sorry this page doesn(?:'|’|ʼ)t exist/i);

  if ((await sorry.count()) > 0) {
    console.warn('Category 404-ish. Retrying via home → category link.');
    await page.goto('https://offerup.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.click('a[href*="/explore/k/cars-trucks"]', { timeout: 8_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
  }

  // Re-confirm geo & wait for feed to render
  await confirmGeo(page);
  await page.waitForSelector('[data-testid="feed-item-card"], a[href*="/item/detail/"]', {
    timeout: 45_000,
  });
  await page.waitForTimeout(1_000);
}, { retries: 3, factor: 1.6, minTimeout: 1_200 });


  // ---------- Scroll to load ----------
  for (let i=0;i<SCROLLS;i++){
    await page.mouse.wheel(0, 3500);
    await sleep(700 + jitter());
    await page.waitForSelector('[data-testid="feed-item-card"], a[href*="/item/detail/"]', { timeout: 15000 }).catch(() => {});
  }

  // ---------- Prefer __NEXT_DATA__ ----------
  let feed: FeedItem[] = await readNextData(page);

  // ---------- Fallback to aria-label scraping ----------
  if (!feed.length) {
    const fallback = await readFromAria(page);
    feed = fallback;
  }

  // Diagnostics if still nothing
  if (!feed.length) {
    await page.screenshot({ path: 'offerup_feed.png', fullPage: true });
    await fs.writeFile('offerup_feed.html', await page.content());
    console.log('No feed items. Wrote offerup_feed.png and offerup_feed.html for debugging.');
  }

  // ---------- Filter by radius / cities (safety net) ----------
  let candidates = feed.filter(c => (c.distanceMi == null ? true : c.distanceMi <= RADIUS));
  if (allowedCities.length) {
    candidates = candidates.filter(c => (c.city ? allowedCities.includes(c.city.toLowerCase()) : true));
  }

  // Dedupe and cap
  const seen = new Set<string>();
  let links = candidates.filter(c => {
    const id = c.id || c.url.match(/\/item\/detail\/([^/?#]+)/)?.[1];
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(c => c.url);

  if (links.length > MAX) links = links.slice(0, MAX);

  console.log(`Feed items: ${feed.length}; after filter: ${links.length}`);

  // ---------- Detail loop & insert ----------
  let inserted = 0, skipped = 0, errors = 0;

  // Tiny helper for detail parsing (minimal; title/price/city/VIN heuristics)
  const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
  async function parseDetail(detail: Page) {
    const title = (await detail.locator('h1').first().textContent().catch(()=>null))?.trim() || null;
    let priceText = await detail.locator('[data-testid="listing-price"]').first().textContent().catch(()=>null);
    if (!priceText) priceText = await detail.locator('text=Price').locator('..').textContent().catch(()=>null);
    const price = priceText ? (parseInt(priceText.replace(/[^\d]/g, '')) || null) : null;

    let city =
      (await detail.locator('[data-testid="buyer-location"]').first().textContent().catch(()=>null))?.trim()
      || (await detail.locator('div:has-text("mi")').first().textContent().catch(()=>null))?.trim()
      || null;
    if (city) city = city.replace(/\s+ca?$/i, '').split(',')[0].trim();

    let desc = await detail.locator('[data-testid="post-description"]').first().textContent().catch(()=>null);
    if (!desc) desc = await detail.locator('section:has-text("Description")').first().textContent().catch(()=>null);
    const vin = (desc?.match(VIN_RE)?.[0]?.toUpperCase()) || null;

    const blob = `${title ?? ''}\n${desc ?? ''}`.toLowerCase();
    const title_status = /salvage/.test(blob)
      ? 'salvage'
      : (/clean\s*title|clean-title|clean\s*ttl/.test(blob) ? 'clean' : null);

    // Year/Make/Model from title
    let year: number|null = null, make: string|null = null, model: string|null = null;
    if (title) {
      const y = title.match(/\b(19|20)\d{2}\b/);
      if (y) year = parseInt(y[0], 10);
      const t = title.replace(/\b(19|20)\d{2}\b/, '').trim();
      const parts = t.split(/\s+/);
      make = parts[0] || null;
      model = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }

    return { title, price, city, vin, title_status, year, make, model };
  }

  for (const url of links) {
    const remote_id = url.match(/\/item\/detail\/([^/?#]+)/)?.[1] || null;
    if (!remote_id) { skipped++; continue; }

    // exists?
    const { data: exists, error: exErr } = await supaSvc
      .from('listings')
      .select('id')
      .eq('source', 'offerup')
      .eq('remote_id', remote_id)
      .limit(1)
      .maybeSingle();

    if (exErr) { console.warn('exists check error', exErr.message); errors++; continue; }
    if (exists) { skipped++; continue; }

    const detail = await ctx.newPage();
    try {
      await pRetry(async () => {
        await detail.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await Promise.race([
          detail.waitForSelector('[data-testid="listing-price"]', { timeout: 8000 }),
          detail.waitForSelector('h1', { timeout: 8000 }),
        ]).catch(() => {});
      }, { retries: 2, minTimeout: 1200, factor: 1.5 });

      await sleep(700 + jitter());
      const data = await parseDetail(detail);

      const up = await supaSvc.from('listings').upsert({
        source: 'offerup',
        remote_id,
        url,
        title: data.title,
        price: data.price,
        city: data.city,
        mileage: null,
        title_status: data.title_status,
        vin: data.vin,
        year: data.year,
        make: data.make,
        model: data.model,
        posted_at: null,
      }, { onConflict: 'source,remote_id' });

      if (up.error) {
        console.warn('upsert error', up.error.message, url);
        errors++;
      } else {
        inserted++;
      }
    } catch (e: any) {
      console.warn('detail error', e?.message, url);
      errors++;
    } finally {
      await detail.close();
      await sleep(220 + jitter());
    }
  }

  console.log(JSON.stringify({ ok: true, inserted, skipped, errors }, null, 2));
  await browser.close();
}

run().catch(async (err) => {
  console.error('offerup script failed:', err);
  try {
    await fs.writeFile('offerup_error.txt', String(err?.stack || err));
  } catch {}
  process.exit(1);
});

