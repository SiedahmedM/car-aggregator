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

// ---------- Optional filter knobs (applied before upsert) ----------
// These allow the script to be driven by saved-search parameters.
const F_MIN_YEAR = parseInt(process.env.OU_FILTER_MIN_YEAR || '', 10) || null;
const F_MAX_YEAR = parseInt(process.env.OU_FILTER_MAX_YEAR || '', 10) || null;
const F_MIN_PRICE = parseInt(process.env.OU_FILTER_MIN_PRICE || '', 10) || null;
const F_MAX_PRICE = parseInt(process.env.OU_FILTER_MAX_PRICE || '', 10) || null;
const F_MODELS = (process.env.OU_FILTER_MODELS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// Hours ago window, e.g. 24 means only posted within last 24h
const F_POSTED_WITHIN_HOURS = parseInt(process.env.OU_FILTER_POSTED_WITHIN_HOURS || '', 10) || null;

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

function sanitizeInteger(value: unknown, opts?: { min?: number; max?: number }): number|null {
  const { min, max } = opts || {};
  if (value == null) return null;
  let n: number | null = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    n = Math.trunc(value);
  } else if (typeof value === 'string') {
    // allow numeric strings; strip non-digits except leading minus
    const cleaned = value.trim();
    if (!/^[-+]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(cleaned)) {
      const digits = cleaned.replace(/[^\d-]/g, '');
      if (!digits) return null;
      n = parseInt(digits, 10);
    } else {
      const asNum = Number(cleaned);
      if (!Number.isFinite(asNum)) return null;
      n = Math.trunc(asNum);
    }
  }
  if (n == null || !Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

function sanitizeYear(y?: number|null): number|null {
  if (y == null || !Number.isFinite(y)) return null;
  const n = Math.trunc(y);
  if (n < 1950 || n > 2100) return null;
  return n;
}

type FeedItem = {
  id: string;
  url: string;
  city: string | null;
  distanceMi: number | null;
  title?: string | null;
  price?: number | null;
  mileage?: number | null;
  postedAt?: string | null;
};

function matchesFilters(row: {
  price: number|null;
  year: number|null;
  model: string|null;
  posted_at: string|null;
}): boolean {
  const { price, year, model, posted_at } = row;
  if (F_MIN_YEAR != null && (year == null || year < F_MIN_YEAR)) return false;
  if (F_MAX_YEAR != null && (year == null || year > F_MAX_YEAR)) return false;
  if (F_MIN_PRICE != null && (price == null || price < F_MIN_PRICE)) return false;
  if (F_MAX_PRICE != null && (price == null || price > F_MAX_PRICE)) return false;
  if (F_MODELS.length) {
    const m = (model || '').toLowerCase();
    if (!F_MODELS.some(x => m.includes(x))) return false;
  }
  if (F_POSTED_WITHIN_HOURS != null) {
    const since = Date.now() - F_POSTED_WITHIN_HOURS * 60 * 60 * 1000;
    const t = posted_at ? Date.parse(posted_at) : NaN;
    if (!Number.isFinite(t) || t < since) return false;
  }
  return true;
}

// Prefer client-feed JSON tiles if available
function parseLooseTiles(payload: any): FeedItem[] {
  const tiles =
    payload?.props?.pageProps?.searchFeedResponse?.looseTiles ??
    payload?.searchFeedResponse?.looseTiles ??
    payload?.data?.searchFeedResponse?.looseTiles ??
    [];
  return tiles
    .filter((t: any) => t?.tileType === 'LISTING' && t?.listing)
    .map((t: any) => {
      const L = t.listing;
      const id = L?.listingId || L?.id;
      const slug = L?.slug || L?.listingId;
      const url = slug ? `https://offerup.com/item/detail/${slug}` : null;
      const city = (L?.locationName || L?.sellerLocationName || '')
        .replace(/\s+CA?$/i, '')
        .split(',')[0]
        .trim() || null;
      const distanceMi = L?.distanceMiles != null ? Math.round(Number(L.distanceMiles)) : null;
      const title = L?.title ?? null;
      const price = sanitizeInteger(L?.price, { min: 0, max: 500000 });
      const mileage = sanitizeInteger(L?.vehicleMiles, { min: 500, max: 1500000 });
      // Try a variety of likely timestamp fields if present
      const postedAt =
        (typeof L?.createdAt === 'string' ? L.createdAt : null)
        || (typeof L?.postedAt === 'string' ? L.postedAt : null)
        || (typeof L?.createdDate === 'string' ? L.createdDate : null)
        || (typeof L?.createdTime === 'string' ? L.createdTime : null)
        || (typeof L?.createdAtMs === 'number' ? new Date(L.createdAtMs).toISOString() : null)
        || (typeof L?.postedDateMs === 'number' ? new Date(L.postedDateMs).toISOString() : null);
      if (!id || !url) return null;
      return { id: String(id), url, city, distanceMi, title, price, mileage, postedAt } as FeedItem;
    })
    .filter(Boolean) as FeedItem[];
}

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
    const price = sanitizeInteger(L?.price, { min: 0, max: 500000 });
    const mileage = sanitizeInteger(L?.vehicleMiles, { min: 500, max: 1500000 });
    const postedAt =
      (typeof L?.createdAt === 'string' ? L.createdAt : null)
      || (typeof L?.postedAt === 'string' ? L.postedAt : null)
      || (typeof L?.createdDate === 'string' ? L.createdDate : null)
      || (typeof L?.createdTime === 'string' ? L.createdTime : null)
      || (typeof L?.createdAtMs === 'number' ? new Date(L.createdAtMs).toISOString() : null)
      || (typeof L?.postedDateMs === 'number' ? new Date(L.postedDateMs).toISOString() : null);
    items.push({ id: String(id), url, city, distanceMi, title, price, mileage, postedAt });
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

  // Overwrite OfferUp location cookie up front (prefer manual source)
  await ctx.addCookies([{
    name: 'ou.location',
    value: JSON.stringify({
      city: 'Cypress', state: 'CA', zipCode: '90630',
      longitude: LNG, latitude: LAT, source: 'manual'
    }),
    domain: 'offerup.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax'
  }]);

  // Context-level route to ensure we rewrite GraphQL feed requests before any page navigation
  await ctx.route('**/api/graphql', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();

    const headers = { ...req.headers() } as Record<string, string>;
    delete (headers as any)['userdata'];

    let body: any;
    try {
      body = (req as any).postDataJSON?.() ?? JSON.parse(req.postData() || '{}');
    } catch {
      return route.continue({ headers });
    }

    if (body?.operationName !== 'GetModularFeed') {
      return route.continue({ headers });
    }

    const params = body?.variables?.searchParams;
    if (Array.isArray(params)) {
      let sawLat = false, sawLon = false;
      for (const p of params) {
        if (p?.key === 'lat') { p.value = String(LAT); sawLat = true; }
        if (p?.key === 'lon') { p.value = String(LNG); sawLon = true; }
      }
      if (!sawLat) params.push({ key: 'lat', value: String(LAT) });
      if (!sawLon) params.push({ key: 'lon', value: String(LNG) });
    }

    console.log('[GraphQL rewrite] lat/lon =>', LAT, LNG);
    await route.continue({ headers, postData: JSON.stringify(body) });
  });

  const page = await ctx.newPage();
  // capture the client feed early
  let apiFeedJson: any = null;
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      if (!resp.url().includes('offerup.com')) return;

      // safer than text+JSON.parse because responses can be gzipped
      const body = await resp.json().catch(() => null);
      if (!body) return;
      const s = JSON.stringify(body);
      if (s.includes('"looseTiles"') && s.includes('"listingId"')) {
        apiFeedJson = body;
        // persist the client feed response for debugging
        await fs.writeFile('offerup_feed_resp.json', JSON.stringify(body, null, 2));
        console.log('Saved client feed response → offerup_feed_resp.json');
      }
    } catch {}
  });

  // log the matching request (url + body) so we know how to rewrite it later
  page.on('request', async (req) => {
    try {
      if (!req.url().includes('offerup.com')) return;
      const pd = req.postData();
      if (pd && /looseTiles|searchFeed/i.test(pd)) {
        await fs.writeFile('offerup_feed_req.json', JSON.stringify({
          url: req.url(),
          method: req.method(),
          headers: req.headers(),
          postData: pd,
        }, null, 2));
        console.log('Saved client feed request → offerup_feed_req.json');
      }
    } catch {}
  });

  // (Removed page-level graphql route; handled at context-level above)

  // Route and force coordinates for the client feed request (adjusts to changing endpoints)
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.url().includes('/api/graphql')) {
      return route.continue();
    }
    if (req.url().includes('offerup.com') && req.method() === 'POST') {
      const pd = req.postData();
      if (pd && /looseTiles|searchFeed/i.test(pd)) {
        try {
          const body = JSON.parse(pd);
          if (body && typeof body === 'object') {
            // GraphQL-style variables
            if (body.variables) {
              if (body.variables.location) {
                body.variables.location.latitude = LAT;
                body.variables.location.longitude = LNG;
              }
              if (body.variables.lat !== undefined) body.variables.lat = LAT;
              if (body.variables.lng !== undefined) body.variables.lng = LNG;
              if (body.variables.latitude !== undefined) body.variables.latitude = LAT;
              if (body.variables.longitude !== undefined) body.variables.longitude = LNG;
            }
            // Plain JSON shape
            if (body.location) {
              body.location.latitude = LAT;
              body.location.longitude = LNG;
            }
          }
          await route.continue({ postData: JSON.stringify(body) });
          return;
        } catch {
          // fall through if payload isn't JSON
        }
      }
    }
    await route.continue();
  });

// ---------- Prime on homepage only ----------
await pRetry(async () => {
  await page.goto('https://offerup.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const accept = page.getByRole('button', { name: /accept/i });
  if (await accept.count()) await accept.first().click().catch(() => {});
  // optional: resolve navigator.geolocation (won't hurt)
  await page.evaluate(() => new Promise<void>(res => {
    try { navigator.geolocation.getCurrentPosition(() => res(), () => res()); } catch { res(); }
  }));
  await page.waitForTimeout(700);
}, { retries: 2, minTimeout: 800 });

// ---------- Category ----------
console.log('Navigating category:', SEARCH_URL);
await pRetry(async () => {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const sorry = page.getByText(/Sorry this page doesn(?:'|’|ʼ)t exist/i);
  if (await sorry.count()) {
    console.warn('Category 404-ish. Retrying via home → category link.');
    await page.goto('https://offerup.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.click('a[href*="/explore/k/cars-trucks"]', { timeout: 8_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
  }

  // Give client time to refresh feed post-initialization
  await page.waitForSelector('[data-testid="feed-item-card"], a[href*="/item/detail/"]', { timeout: 45_000 });
  await page.waitForTimeout(1_500);
}, { retries: 3, factor: 1.6, minTimeout: 1_200 });

  // explicitly wait for the client feed JSON to arrive (best effort)
  await page.waitForResponse(async (resp) => {
    try {
      if (!resp.url().includes('/api/graphql')) return false;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return false;
      const body = await resp.json().catch(() => null);
      if (!body) return false;
      return JSON.stringify(body).includes('"looseTiles"');
    } catch { return false; }
  }, { timeout: 20_000 }).catch(() => {});

  


  // ---------- Scroll to load ----------
  for (let i=0;i<SCROLLS;i++){
    await page.mouse.wheel(0, 3500);
    await sleep(700 + jitter());
    await page.waitForSelector('[data-testid="feed-item-card"], a[href*="/item/detail/"]', { timeout: 15000 }).catch(() => {});
  }

  // ---------- Prefer client feed over SSR if available ----------
  let feed: FeedItem[] = [];
  if (apiFeedJson) {
    const clientFeed = parseLooseTiles(apiFeedJson);
    if (clientFeed.length) feed = clientFeed;
  }
  if (!feed.length) {
    feed = await readNextData(page);
  }

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
  // Optional: log a few cities to confirm we’re local before filtering
  const sampleCities = Array.from(new Set(feed.map(f => f.city).filter(Boolean))).slice(0, 10);
  console.log('Sample feed cities:', sampleCities);

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

  // Tiny helper for detail parsing (title/price/city/VIN and mild heuristics)
  const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
  function parseMileageFromText(text?: string|null): number|null {
    if (!text) return null;
    // capture patterns like "120,000 miles" or "85k miles"
    const milesWord = text.match(/(\d{1,3}(?:,\d{3})+|\d{2,3})\s*miles\b/i);
    if (milesWord) {
      const num = milesWord[1].replace(/,/g, '');
      const n = parseInt(num, 10);
      if (Number.isFinite(n) && n >= 500) return n; // avoid catching distances
    }
    const kWord = text.match(/(\d{2,3})\s*k\s*miles\b/i);
    if (kWord) {
      const n = parseInt(kWord[1], 10) * 1000;
      if (Number.isFinite(n) && n >= 500) return n;
    }
    return null;
  }
  async function parseDetail(detail: Page) {
    const title = (await detail.locator('h1').first().textContent().catch(()=>null))?.trim() || null;
    let priceText = await detail.locator('[data-testid="listing-price"]').first().textContent().catch(()=>null);
    if (!priceText) priceText = await detail.locator('text=Price').locator('..').textContent().catch(()=>null);
    const price = sanitizeInteger(priceText ? priceText.replace(/[^\d]/g, '') : null, { min: 0, max: 500000 });

    let city =
      (await detail.locator('[data-testid="buyer-location"]').first().textContent().catch(()=>null))?.trim()
      || (await detail.locator('div:has-text("mi")').first().textContent().catch(()=>null))?.trim()
      || null;
    if (city) city = city.replace(/\s+ca?$/i, '').split(',')[0].trim();

    let desc = await detail.locator('[data-testid="post-description"]').first().textContent().catch(()=>null);
    if (!desc) desc = await detail.locator('section:has-text("Description")').first().textContent().catch(()=>null);
    const vin = (desc?.match(VIN_RE)?.[0]?.toUpperCase()) || null;
    const mileage = parseMileageFromText(desc || undefined);

    // posted_at from time element, ld+json, or detail __NEXT_DATA__
    let posted_at: string | null = null;
    const timeAttr = await detail.locator('time[datetime]').first().getAttribute('datetime').catch(() => null);
    if (timeAttr) {
      posted_at = new Date(timeAttr).toISOString();
    } else {
      const ldJson = await detail.locator('script[type="application/ld+json"]').first().textContent().catch(() => null);
      if (ldJson) {
        try {
          const j = JSON.parse(ldJson);
          const d = j?.datePosted || j?.datePublished || j?.dateCreated;
          if (typeof d === 'string') posted_at = new Date(d).toISOString();
        } catch {}
      }
      if (!posted_at) {
        const nd = await detail.locator('#__NEXT_DATA__').first().textContent().catch(() => null);
        if (nd) {
          try {
            const j = JSON.parse(nd);
            // shallow scan for plausible timestamp fields
            const stack: any[] = [j];
            while (stack.length && !posted_at) {
              const cur = stack.pop();
              if (cur && typeof cur === 'object') {
                for (const [k, v] of Object.entries(cur)) {
                  if (typeof v === 'object' && v) stack.push(v);
                  if (typeof v === 'string' && /(created|posted|publish).*(at|time|date|timestamp)/i.test(k)) {
                    const t = new Date(v);
                    if (!isNaN(t.getTime())) { posted_at = t.toISOString(); break; }
                  }
                  if (typeof v === 'number' && /(created|posted|publish).*(ms|time|timestamp)/i.test(k)) {
                    const t = new Date(v);
                    if (!isNaN(t.getTime())) { posted_at = t.toISOString(); break; }
                  }
                }
              }
            }
          } catch {}
        }
      }
    }

    const blob = `${title ?? ''}\n${desc ?? ''}`.toLowerCase();
    let title_status: 'clean'|'salvage'|null = null;
    if (/\b(clean\s*title|clean-title|clean\s*ttl)\b/.test(blob)) title_status = 'clean';
    if (/\b(salvage|rebuilt|branded)\b/.test(blob)) title_status = 'salvage';

    // Year/Make/Model from title
    let year: number|null = null, make: string|null = null, model: string|null = null;
    if (title) {
      const y = title.match(/\b(19|20)\d{2}\b/);
      if (y) year = sanitizeYear(parseInt(y[0], 10));
      const t = title.replace(/\b(19|20)\d{2}\b/, '').trim();
      const parts = t.split(/\s+/);
      make = parts[0] || null;
      model = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }

    return { title, price, city, vin, title_status, year, make, model, mileage, posted_at };
  }

  // Build quick lookup from feed by slug/id for fallbacks
  const feedById = new Map<string, FeedItem>();
  for (const f of feed) {
    if (f.id) feedById.set(f.id, f);
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
      const feedItem = feedById.get(remote_id);
      // Fallbacks from client feed when detail parsing is missing
      const price = data.price ?? feedItem?.price ?? null;
      const city = data.city ?? feedItem?.city ?? null;
      const mileage = data.mileage ?? feedItem?.mileage ?? null;
      const posted_at = data.posted_at ?? feedItem?.postedAt ?? null;
      // Enrich title_status from feed title when available
      let title_status = data.title_status;
      if (!title_status && (feedItem?.title || '').toLowerCase()) {
        const t = (feedItem?.title || '').toLowerCase();
        if (/salvage/.test(t)) title_status = 'salvage';
        else if (/clean\s*title|clean-title|clean\s*ttl/.test(t)) title_status = 'clean';
      }

      // Apply filters before upsert
      const candidate = {
        source: 'offerup',
        remote_id,
        url,
        title: data.title,
        price: sanitizeInteger(price, { min: 0, max: 500000 }),
        city,
        mileage: sanitizeInteger(mileage, { min: 500, max: 1500000 }),
        title_status,
        vin: data.vin,
        year: sanitizeYear(data.year),
        make: data.make,
        model: data.model,
        posted_at,
      } as const;

      if (!matchesFilters({
        price: candidate.price ?? null,
        year: candidate.year ?? null,
        model: candidate.model ?? null,
        posted_at: candidate.posted_at ?? null,
      })) {
        skipped++;
        continue;
      }

      const up = await supaSvc.from('listings').upsert(candidate, { onConflict: 'source,remote_id' });

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
