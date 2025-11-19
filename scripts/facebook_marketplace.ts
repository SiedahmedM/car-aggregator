import { chromium, Browser, Page, LaunchOptions, BrowserContext } from 'playwright'
import fs from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

// Env + Supabase ------------------------------------------------------------
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!
if (!SUPA_URL || !SUPA_KEY) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE')
const supaSvc = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const HEADLESS = (process.env.FB_HEADLESS ?? 'true').toLowerCase() === 'true'
const SCROLL_PAGES = Math.max(4, parseInt(process.env.FB_SCROLL_PAGES || '8', 10) || 8)
const SCROLL_MIN_MS = Math.max(2500, parseInt(process.env.FB_SCROLL_MIN_MS || '3000', 10) || 3000)
const SCROLL_MAX_MS = Math.max(SCROLL_MIN_MS + 1000, parseInt(process.env.FB_SCROLL_MAX_MS || '7000', 10) || 7000)
const MAX_ITEMS = Math.max(20, parseInt(process.env.FB_MAX_ITEMS || '120', 10) || 120)
const FB_CATEGORY_URL = process.env.FB_CATEGORY_URL || 'https://www.facebook.com/marketplace/category/vehicles'
// Default to a local secrets file (git-ignored). Override via FB_COOKIES_PATH.
const FB_COOKIES_PATH = process.env.FB_COOKIES_PATH || 'secrets/facebook_cookies.json'

type RawGQLEdge = any
const FB_DEBUG = (process.env.FB_DEBUG ?? 'false').toLowerCase() === 'true'

type ListingRow = {
  source: 'facebook'
  remote_id: string
  remote_slug?: string | null
  url: string
  title: string | null
  price: number | null
  year: number | null
  make: string | null
  model: string | null
  mileage: number | null
  city: string | null
  posted_at: string | null
  first_seen_at: string
}

function parseIntSafe(s: any): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null
  if (typeof s === 'string') {
    const m = s.replace(/[^0-9]/g, '')
    if (!m) return null
    const n = parseInt(m, 10)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseTitleForYmm(title?: string | null): { year: number | null; make: string | null; model: string | null } {
  if (!title) return { year: null, make: null, model: null }
  const m = title.match(/^(\d{4})\s+([A-Za-z]+)\s+([^|•]+)/)
  if (!m) return { year: null, make: null, model: null }
  const year = parseInt(m[1], 10)
  const make = m[2]?.toLowerCase() || null
  const model = m[3]?.trim().toLowerCase() || null
  return { year: Number.isFinite(year) ? year : null, make, model }
}

function extractEdgesFromBody(body: any): RawGQLEdge[] {
  try {
    // Old path
    const edges = body?.data?.marketplace_search?.feed_units?.edges
    if (Array.isArray(edges)) return edges
  } catch {}
  // Modular feed experiments: items/looseTiles
  try {
    const mf = body?.data?.modularFeed
    const loose = Array.isArray(mf?.looseTiles) ? mf.looseTiles : []
    const items = Array.isArray(mf?.items) ? mf.items : []
    const all = [...loose, ...items]
    if (all.length) return all.map((x: any) => ({ node: x }))
  } catch {}
  return []
}

function normalizeEdge(edge: any): ListingRow | null {
  try {
    const node = edge?.node ?? edge
    // Try a few common nesting variants
    const listing = node?.listing || node?.product?.listing || node?.target?.listing || node?.marketplace_listing || node?.story?.marketplace_listing || (node?.__typename === 'MarketplaceFeedUnit' ? node?.listing : null) || node
    if (!listing) return null
    const remoteId: string | undefined = String(listing.id || listing.listing_id || '')
    if (!remoteId) return null

    const title: string | null = listing.marketplace_listing_title || listing.title || null
    const priceRaw = listing?.listing_price?.amount ?? listing?.listing_price?.formatted_amount ?? null
    const mileageRaw = listing?.vehicle_odometer_data?.vehicle_mileage ?? listing?.vehicle_odometer_data?.vehicle_mileage_text ?? null
    const permalink: string | null = listing?.story_permalink || listing?.marketplace_item_permalink || null

    const { year: yearGuess, make: makeGuess, model: modelGuess } = parseTitleForYmm(title)
    const year = parseIntSafe(listing?.year) ?? yearGuess
    const make: string | null = (listing?.make || makeGuess || null)?.toLowerCase?.() ?? null
    const model: string | null = (listing?.model || modelGuess || null)?.toLowerCase?.() ?? null
    const price = parseIntSafe(priceRaw)
    const mileage = parseIntSafe(mileageRaw)
    const postedAt: string | null = listing?.creation_time ? new Date(listing.creation_time * 1000).toISOString() : null
    const city: string | null = listing?.location?.reverse_geocode?.city || listing?.location?.city || null

    const row: ListingRow = {
      source: 'facebook',
      remote_id: remoteId,
      remote_slug: null,
      url: permalink || `https://www.facebook.com/marketplace/item/${remoteId}`,
      title: title || null,
      price: price,
      year: year,
      make,
      model,
      mileage,
      city,
      posted_at: postedAt,
      first_seen_at: new Date().toISOString(),
    }
    return row
  } catch {
    return null
  }
}

function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }

async function interceptFacebookGraphQL(): Promise<ListingRow[]> {
  let browser: Browser | null = null
  const collected: RawGQLEdge[] = []
  try {
    // Proxy (sticky session)
    const proxyServer = process.env.FB_PROXY_SERVER // e.g. http://pr.oxylabs.io:7777
    const proxyUserBase = process.env.FB_PROXY_USERNAME // e.g. customer-...-cc-US-city-los_angeles
    const proxyPass = process.env.FB_PROXY_PASSWORD
    const proxySession = process.env.FB_PROXY_SESSION_ID || Math.random().toString(36).slice(2, 10)
    const launchOpts: LaunchOptions = { headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] }
    if (proxyServer && proxyUserBase && proxyPass) {
      launchOpts.proxy = { server: proxyServer, username: `${proxyUserBase}-session-${proxySession}`, password: proxyPass }
    }
    browser = await chromium.launch(launchOpts)
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      timezoneId: 'America/Los_Angeles',
      locale: 'en-US',
      geolocation: process.env.OU_LAT && process.env.OU_LNG ? { latitude: Number(process.env.OU_LAT), longitude: Number(process.env.OU_LNG) } : undefined,
      permissions: ['geolocation'],
    })
    // Load cookies if provided (supports Playwright storageState or array export from common extensions)
    if (FB_COOKIES_PATH) {
      try {
        const raw = await fs.readFile(FB_COOKIES_PATH, 'utf8')
        const json = JSON.parse(raw)
        let cookies: any[] = []
        if (Array.isArray(json?.cookies)) {
          // Playwright storage state format
          cookies = json.cookies
        } else if (Array.isArray(json)) {
          // Array of cookie objects from a cookie editor/extension
          cookies = json
        }
        if (Array.isArray(cookies) && cookies.length) {
          // Map to Playwright cookie shape
          const mapped = cookies.map((c: any) => {
            const sameSiteMap: Record<string, any> = { lax: 'Lax', none: 'None', strict: 'Strict', Lax: 'Lax', None: 'None', Strict: 'Strict' }
            const cookie: any = {
              name: c.name,
              value: c.value,
              domain: c.domain || (c.url ? new URL(c.url).hostname : '.facebook.com'),
              path: c.path || '/',
              httpOnly: !!c.httpOnly,
              secure: c.secure !== false,
              sameSite: sameSiteMap[c.sameSite] || undefined,
              expires: typeof c.expires === 'number' ? c.expires : undefined,
            }
            // Playwright requires either url or domain/path; we supply domain/path
            return cookie
          })
          await context.addCookies(mapped)
          if (FB_DEBUG) console.log('[FB] Loaded cookies:', mapped.length)
        }
      } catch (e) {
        console.warn('[FB] Failed to load cookies:', (e as Error).message)
      }
    }
    await context.addInitScript(() => {
      // @ts-ignore
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    const page: Page = await context.newPage()

    page.on('response', async (resp) => {
      const url = resp.url()
      if (!url.includes('/api/graphql')) return
      try {
        // FB often prefixes JSON with a guard: for (;;);{...}
        let text = await resp.text()
        if (text.startsWith('for (;;);')) text = text.slice('for (;;);'.length)
        const body = JSON.parse(text)
        const edges = extractEdgesFromBody(body)
        if (edges.length) {
          collected.push(...edges)
          if (FB_DEBUG) console.log('[FB] edges+', edges.length, 'total=', collected.length)
        }
      } catch {}
    })

    // Small pre-navigation wait to avoid robotic cadence
    await page.waitForTimeout(randInt(250, 1250))
    await page.goto(FB_CATEGORY_URL, { waitUntil: 'load', timeout: 60_000 })
    // Initial small human-like mouse movement
    try {
      await page.mouse.move(randInt(100, 400), randInt(100, 300))
      await page.waitForTimeout(randInt(150, 400))
      await page.mouse.move(randInt(500, 900), randInt(200, 600))
    } catch {}
    for (let i = 0; i < SCROLL_PAGES; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(randInt(SCROLL_MIN_MS, SCROLL_MAX_MS))
      // occasional small up-scroll to mimic reading
      if (Math.random() < 0.25) {
        await page.evaluate(() => window.scrollBy(0, -Math.floor(window.innerHeight * 0.3)))
        await page.waitForTimeout(randInt(350, 900))
      }
      if (collected.length >= MAX_ITEMS) break
    }

    // If nothing intercepted yet, fallback: parse SSR-embedded __bbox blocks
    if (collected.length === 0) {
      try {
        const scripts = await page.$$eval('script', (els) => els.map((e) => e.textContent || ''))
        const edgesFallback: any[] = []
        const pushEdgesFromJson = (json: any) => {
          try {
            const edges = json?.__bbox?.result?.data?.marketplace_search?.feed_units?.edges
            if (Array.isArray(edges) && edges.length) edgesFallback.push(...edges)
          } catch {}
        }
        for (const txt of scripts) {
          if (!txt || (!txt.includes('__bbox') && !txt.includes('marketplace_search'))) continue
          let idx = txt.indexOf('{"__bbox"')
          while (idx !== -1) {
            // Brace matching to extract JSON object
            let depth = 0
            let inStr = false
            let esc = false
            let end = -1
            for (let i = idx; i < txt.length; i++) {
              const ch = txt[i]
              if (inStr) {
                if (esc) esc = false
                else if (ch === '\\') esc = true
                else if (ch === '"') inStr = false
              } else {
                if (ch === '"') inStr = true
                else if (ch === '{') depth++
                else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
              }
            }
            if (end !== -1) {
              const frag = txt.slice(idx, end)
              try { const parsed = JSON.parse(frag); pushEdgesFromJson(parsed) } catch {}
              idx = txt.indexOf('{"__bbox"', end)
            } else {
              break
            }
          }
        }
        if (edgesFallback.length) {
          collected.push(...edgesFallback.map((e) => ({ node: e?.node || e })))
          if (FB_DEBUG) console.log('[FB] SSR __bbox edges+', edgesFallback.length)
        }
      } catch (e) {
        if (FB_DEBUG) console.warn('[FB] SSR parse failed', (e as Error).message)
      }
    }

    // Normalize
    const rows = collected.map(normalizeEdge).filter(Boolean) as ListingRow[]
    // De-dupe by remote_id
    const seen = new Set<string>()
    const uniq = rows.filter((r) => (seen.has(r.remote_id) ? false : (seen.add(r.remote_id), true)))
    return uniq.slice(0, MAX_ITEMS)
  } finally {
    try { await browser?.close() } catch {}
  }
}

async function upsertListings(rows: ListingRow[]) {
  if (!rows.length) return { inserted: 0, skipped: 0 }
  const batched = [] as ListingRow[][]
  for (let i = 0; i < rows.length; i += 50) batched.push(rows.slice(i, i + 50))
  let inserted = 0
  let skipped = 0
  for (const chunk of batched) {
    const { error } = await supaSvc
      .from('listings')
      .upsert(chunk as any, { onConflict: 'remote_id,source' })
    if (error) {
      console.error('[FB] upsert error', error.message)
      // Best effort fallback: try without conflict target
      const { error: err2 } = await supaSvc.from('listings').upsert(chunk as any)
      if (err2) console.error('[FB] upsert fallback error', err2.message)
    } else {
      inserted += chunk.length
    }
  }
  return { inserted, skipped }
}

async function main() {
  const usingProxy = !!(process.env.FB_PROXY_SERVER && process.env.FB_PROXY_USERNAME)
  console.log('[FB] Starting Marketplace capture...', { headless: HEADLESS, pages: SCROLL_PAGES, proxy: usingProxy ? 'on' : 'off', cookies: !!FB_COOKIES_PATH })
  const rows = await interceptFacebookGraphQL()
  console.log(`[FB] Captured ${rows.length} candidate items`)
  const res = await upsertListings(rows)
  console.log(JSON.stringify({ ok: true, source: 'facebook', inserted: res.inserted, skipped: res.skipped }))
}

// CLI
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => { console.error('[FB] Failed:', e); process.exit(1) })
}
