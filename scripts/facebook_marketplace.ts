import { chromium, Browser, Page, LaunchOptions, BrowserContext } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
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

// Debug + capture utilities -------------------------------------------------
const DEBUG_DIR = process.env.FB_DEBUG_DIR || 'debug/facebook'
const FB_CAPTURE_RAW = (process.env.FB_CAPTURE_RAW ?? '0') === '1'
const FB_CAPTURE_ON_ZERO = (process.env.FB_CAPTURE_ON_ZERO ?? '1') !== '0'
const FB_USE_STORAGE_STATE = (process.env.FB_USE_STORAGE_STATE ?? '0') === '1'
const FB_STORAGE_STATE = process.env.FB_STORAGE_STATE || 'secrets/fb_state.json'

function ensureDir(p: string) {
  return fs.mkdir(p, { recursive: true }).catch(() => {})
}

function debug(...args: any[]) {
  if (FB_DEBUG) console.log('[FB:DEBUG]', ...args)
}
function info(...args: any[]) {
  console.log('[FB]', ...args)
}
function warn(...args: any[]) {
  console.warn('[FB:WARN]', ...args)
}

function sanitize(s: string): string {
  if (!s) return s
  return s
    .replace(/(fb_dtsg|lsd|jazoest|__user|__a|__req|__csr|dpr|spin_r|spin_b|spin_t)=([^&\n]+)/gi, '$1=[REDACTED]')
    .replace(/"fb_dtsg"\s*:\s*"[^"]+"/gi, '"fb_dtsg":"[REDACTED]"')
    .replace(/"lsd"\s*:\s*"[^"]+"/gi, '"lsd":"[REDACTED]"')
    .replace(/[A-Fa-f0-9]{20,}/g, '[HEX]')
}

async function writeDebugFile(name: string, content: string | Buffer, opts: { redacted?: boolean } = {}) {
  if (!FB_CAPTURE_RAW) return
  await ensureDir(DEBUG_DIR)
  const p = path.join(DEBUG_DIR, name)
  if (typeof content === 'string' && !opts.redacted) content = sanitize(content)
  await fs.writeFile(p, content)
  debug('wrote', p)
}

const metrics = {
  graphqlRequests: 0,
  graphqlResponses: 0,
  graphqlResponsesOk: 0,
  graphqlErrors: 0,
  graphqlEdges: 0,
  ssrEdges: 0,
  normalized: 0,
  deduped: 0,
  domCandidates: 0,
}

// Last-run signals -----------------------------------------------------------
let lastLoginWallDetected = false

// Session/attempt helpers and toggles ---------------------------------------
function nextSessionId(prev?: string): string {
  const base = (prev || 'la01').trim()
  const m = base.match(/^(.*?)(\d+)$/)
  if (m) return m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0')
  return base + Math.random().toString(36).slice(2, 6)
}

const FB_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.FB_MAX_ATTEMPTS || '3', 10) || 3)
const FB_ROTATE_ON_ZERO = (process.env.FB_ROTATE_ON_ZERO ?? '1') !== '0'
const FB_MIN_ROWS_SUCCESS = Math.max(1, parseInt(process.env.FB_MIN_ROWS_SUCCESS || '1', 10) || 1)
const FB_WARMUP_HOME = (process.env.FB_WARMUP_HOME ?? '1') !== '0'
const FB_WARMUP_MS = Math.max(500, parseInt(process.env.FB_WARMUP_MS || '1500', 10) || 1500)
const FB_BLOCK_ASSETS = (process.env.FB_BLOCK_ASSETS ?? '1') !== '0'

const gqlRegex = /https:\/\/(www|web|m)\.facebook\.com\/api\/graphql(?:\/|\?|$)/i

async function installGraphQLRoutes(context: BrowserContext) {
  await context.route(gqlRegex, async (route) => {
    try {
      const req = route.request()
      let post = ''
      try { post = req.postData() || '' } catch {}
      let docId = '', friendly = '', varKeys: string[] = []
      if (post) {
        const kv = new URLSearchParams(post)
        docId = kv.get('doc_id') || ''
        friendly = kv.get('fb_api_req_friendly_name') || ''
        const varsRaw = kv.get('variables')
        if (varsRaw) { try { varKeys = Object.keys(JSON.parse(varsRaw) || {}) } catch {} }
      }
      if (typeof debug === 'function') debug('GQL->', { method: req.method(), docId, friendly, varKeys, size: post.length })
    } catch (e) { if (typeof warn === 'function') warn('GQL route error', (e as Error).message) }
    finally { await route.continue() }
  })
}

async function installCatchAllRoute(context: BrowserContext) {
  if (!FB_BLOCK_ASSETS) return
  await context.route('**/*', async (route) => {
    const rt = route.request().resourceType()
    if (rt === 'image' || rt === 'media' || rt === 'font') return route.abort()
    // IMPORTANT: do not swallow other routes (like GraphQL)
    return route.fallback()
  })
}

async function warmupHome(page: Page) {
  if (!FB_WARMUP_HOME) return
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 45_000 })
    await page.waitForTimeout(FB_WARMUP_MS)
  } catch (e) {
    if (typeof warn === 'function') warn('Warmup failed', (e as Error).message)
  }
}

// Scroll window or inner container (Marketplace often uses an inner scroller)
async function smartScroll(page: Page) {
  await page.evaluate(() => {
    const candidates: (Element | null)[] = [
      document.querySelector('[role="main"]'),
      document.querySelector('[data-pagelet="MainFeed"]'),
      document.scrollingElement,
      document.documentElement,
      document.body
    ]
    for (const el of candidates) {
      const sc = el as HTMLElement | null
      if (!sc) continue
      const before = sc.scrollTop
      sc.scrollTo({ top: sc.scrollHeight })
      if (sc.scrollTop !== before) return
    }
    window.scrollTo(0, document.body.scrollHeight)
  })
}

// Login wall detection/dismissal --------------------------------------------
async function isLoginWallVisible(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]')
  const loginInput = page.locator('input[name="email"]')
  const banner = page.getByText('See more on Facebook', { exact: false })
  return (await dialog.count()) > 0 || (await loginInput.count()) > 0 || (await banner.count()) > 0
}

async function dismissLoginWall(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]')
  if (!(await dialog.count())) return false
  const close = dialog.locator('[aria-label="Close"], [aria-label="Dismiss"], [data-testid="x_dialog_close_button"]')
  if (await close.count()) {
    await close.first().click().catch(() => {})
    await page.waitForTimeout(500)
  } else {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(500)
  }
  return !(await isLoginWallVisible(page))
}

async function hasXsFromCookiesExport(): Promise<boolean | null> {
  if (!FB_COOKIES_PATH) return null
  try {
    const raw = await fs.readFile(FB_COOKIES_PATH, 'utf8')
    const json = JSON.parse(raw)
    const arr: any[] = Array.isArray(json?.cookies) ? json.cookies : (Array.isArray(json) ? json : [])
    const xs = arr.find((c: any) => c?.name === 'xs' && c?.value && c?.value !== 'deleted')
    return !!xs
  } catch {
    return null
  }
}

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
    const data = body?.data || {}

    // 1) Try known shapes (old + Comet variants)
    const candidates: any[][] = []

    const pushIfArray = (arr: any) => { if (Array.isArray(arr) && arr.length) candidates.push(arr) }

    // Old shape:
    pushIfArray(data?.marketplace_search?.feed_units?.edges)
    // Comet shapes frequently nest under viewer:
    pushIfArray(data?.viewer?.marketplace_search?.feed_units?.edges)
    pushIfArray(data?.viewer?.marketplace_feed?.feed_units?.edges)
    pushIfArray(data?.viewer?.marketplace_category_content?.feed_units?.edges)
    // Other plausible keys seen in experiments:
    pushIfArray(data?.marketplace_feed?.feed_units?.edges)
    pushIfArray(data?.marketplace_category_content?.feed_units?.edges)

    // Modular feed experiments:
    const mf = data?.modularFeed
    if (mf) {
      const loose = Array.isArray(mf?.looseTiles) ? mf.looseTiles : []
      const items = Array.isArray(mf?.items) ? mf.items : []
      const all = [...loose, ...items]
      if (all.length) return all.map((x: any) => ({ node: x }))
    }

    if (candidates.length) {
      return candidates.flat().map((e) => (e && e.node ? e : { node: e }))
    }

    // 2) Generic deep scan: find any object with an "edges" array
    const found: any[] = []
    const visit = (x: any) => {
      if (!x || typeof x !== 'object') return
      if (Array.isArray(x)) { x.forEach(visit); return }
      if (Array.isArray((x as any).edges) && (x as any).edges.length) {
        found.push(...(x as any).edges)
      }
      for (const k of Object.keys(x)) visit((x as any)[k])
    }
    visit(data)

    if (found.length) {
      return found.map((e) => (e && e.node ? e : { node: e }))
    }
  } catch {
    // fall through
  }
  return []
}

function countFeedUnitsDeep(data: any): number {
  let c = 0
  const visit = (x: any) => {
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach(visit); return }
    if ((x as any).feed_units?.edges && Array.isArray((x as any).feed_units.edges)) {
      c += (x as any).feed_units.edges.length
    }
    for (const k of Object.keys(x)) visit((x as any)[k])
  }
  visit(data)
  return c
}

function normalizeEdge(edge: any): ListingRow | null {
  try {
    const node = edge?.node ?? edge
    // Try a few common nesting variants
    const listing = node?.listing || node?.product?.listing || node?.target?.listing || node?.marketplace_listing || node?.story?.marketplace_listing || (node?.__typename === 'MarketplaceFeedUnit' ? node?.listing : null) || node
    if (!listing) { if (FB_DEBUG) debug('normalizeEdge: missing listing in node variant'); return null }
    const remoteId: string | undefined = String(listing.id || listing.listing_id || '')
    if (!remoteId) { if (FB_DEBUG) debug('normalizeEdge: missing id'); return null }

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

async function extractDomListings(page: Page): Promise<ListingRow[]> {
  return await page.$$eval('a[href*="/marketplace/item/"]', (els) => {
    const nowISO = new Date().toISOString()
    const out: any[] = []
    for (const el of els as HTMLAnchorElement[]) {
      const href = el.href || el.getAttribute('href') || ''
      const m = href.match(/\/marketplace\/item\/(\d+)/)
      if (!m) continue
      const id = m[1]
      const title = (el.getAttribute('aria-label') || el.textContent || '').trim() || null
      out.push({
        source: 'facebook',
        remote_id: id,
        remote_slug: null,
        url: href.startsWith('http') ? href : `https://www.facebook.com/marketplace/item/${id}`,
        title,
        price: null, year: null, make: null, model: null, mileage: null, city: null,
        posted_at: null,
        first_seen_at: nowISO,
      })
    }
    return out
  }) as unknown as ListingRow[]
}

async function interceptFacebookGraphQL(sessionId?: string): Promise<ListingRow[]> {
  let browser: Browser | null = null
  lastLoginWallDetected = false
  const collected: RawGQLEdge[] = []
  try {
    // Proxy (sticky session)
    const proxyServer = process.env.FB_PROXY_SERVER // e.g. http://pr.oxylabs.io:7777
    const proxyUserBase = process.env.FB_PROXY_USERNAME // e.g. customer-...-cc-US-city-los_angeles
    const proxyPass = process.env.FB_PROXY_PASSWORD
    const proxySession = sessionId || process.env.FB_PROXY_SESSION_ID || Math.random().toString(36).slice(2, 10)
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
      storageState: FB_USE_STORAGE_STATE ? FB_STORAGE_STATE : undefined,
    })
    // Install routes in correct order (GQL first, then catch-all)
    await installGraphQLRoutes(context)
    await installCatchAllRoute(context)
    
    // Load cookies if provided (supports Playwright storageState or array export from common extensions)
    if (!FB_USE_STORAGE_STATE && FB_COOKIES_PATH) {
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
          // Map to Playwright cookie shape with coerced domain to .facebook.com
          const mapped = cookies.map((c: any) => {
            // Normalize domain -> .facebook.com to cover www/m subdomains
            let host = c.domain || (c.url ? new URL(c.url).hostname : 'facebook.com')
            host = host.replace(/^https?:\/\//, '')
            host = host.replace(/^(www\.|m\.)/, '')
            let domain = host.startsWith('.') ? host : `.${host}`
            if (!/\.facebook\.com$/i.test(domain)) domain = '.facebook.com'

            const sameSiteMap: Record<string, any> = { lax: 'Lax', none: 'None', strict: 'Strict', Lax: 'Lax', None: 'None', Strict: 'Strict' }

            return {
              name: c.name,
              value: c.value,
              domain,
              path: c.path || '/',
              httpOnly: !!c.httpOnly,
              secure: c.secure !== false,
              sameSite: sameSiteMap[c.sameSite] || undefined,
              expires: typeof c.expires === 'number' ? c.expires : undefined,
            }
          })
          await context.addCookies(mapped)
          if (FB_DEBUG) {
            const hasCUser = (Array.isArray(mapped) ? mapped : []).some((c: any) => c?.name === 'c_user' && c?.value)
            debug('Cookies added:', { count: Array.isArray(mapped) ? mapped.length : 0, hasCUser })
          }
          // Verify both c_user and xs ended up for www.facebook.com
          try {
            const ck = await context.cookies('https://www.facebook.com')
            const hasCUser = ck.some((k) => k.name === 'c_user' && k.value)
            const hasXS = ck.some((k) => k.name === 'xs' && k.value && k.value !== 'deleted')
            console.log('[FB:DEBUG] Cookie check:', { hasCUser, hasXS, count: ck.length })
          } catch {}
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
    let loginWallCaptured = false

    page.on('requestfailed', (req) => {
      const u = req.url()
      const f = req.failure()
      warn('requestfailed', { url: u.slice(0, 160), method: req.method(), errorText: f?.errorText })
    })

    page.on('console', async (msg) => {
      const type = msg.type()
      if (type === 'error' || type === 'warning') {
        const text = sanitize(msg.text())
        warn('console.' + type, text.slice(0, 500))
        if (FB_CAPTURE_RAW) await writeDebugFile(`console_${type}_${Date.now()}.txt`, text)
      }
    })

    

    page.on('response', async (resp) => {
      const url = resp.url()
      if (!url.includes('/api/graphql')) return
      metrics.graphqlResponses += 1
      const status = resp.status()
      let text = ''
      try { text = await resp.text() } catch (e) {
        warn('GQL resp text error', (e as Error).message)
        return
      }
      if (text.startsWith('for (;;);')) text = text.slice('for (;;);'.length)

      let body: any = null
      try { body = JSON.parse(text) } catch (e) {
        warn('GQL resp JSON parse error', (e as Error).message)
        await writeDebugFile(`graphql_resp_parsefail_${Date.now()}_${metrics.graphqlResponses}.txt`, text)
        return
      }

      if (status >= 200 && status < 300) metrics.graphqlResponsesOk += 1

      if (body?.errors) {
        metrics.graphqlErrors += 1
        debug('GQL errors:', sanitize(JSON.stringify(body.errors)).slice(0, 800))
      }

      const dataKeys = body?.data ? Object.keys(body.data) : []
      const feedType = body?.data?.marketplace_search ? 'marketplace_search'
                   : body?.data?.modularFeed ? 'modularFeed'
                   : (dataKeys[0] || 'unknown')

      const edges = extractEdgesFromBody(body)
      metrics.graphqlEdges += edges.length

      const feedUnitsDeep = countFeedUnitsDeep(body?.data)
      debug('GQL<-', { status, url, dataKeys, feedType, edges: edges.length, feedUnitsDeep })

      if (edges.length === 0 || FB_CAPTURE_RAW) {
        await writeDebugFile(`graphql_resp_${Date.now()}_${metrics.graphqlResponses}.json`, JSON.stringify(body, null, 2), { redacted: true })
      }

      if (edges.length) {
        collected.push(...edges)
        if (FB_DEBUG) console.log('[FB] edges+', edges.length, 'total=', collected.length)
      }
    })

    // Warm-up home then proceed
    await warmupHome(page)
    // Check login wall on home
    if (await isLoginWallVisible(page)) {
      console.warn('[FB:WARN] Login wall visible on home. Cookies likely invalid.')
      lastLoginWallDetected = true
      return []
    }
    // Small pre-navigation wait to avoid robotic cadence
    await page.waitForTimeout(randInt(250, 1250))
    await page.goto(FB_CATEGORY_URL, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForTimeout(randInt(250, 1250))
    info('Page loaded:', await page.url())
    // Check login wall after navigation; try a single dismiss
    if (await isLoginWallVisible(page)) {
      console.warn('[FB:WARN] Login wall or limited view detected.')
      if (!(await dismissLoginWall(page))) {
        lastLoginWallDetected = true
        return []
      }
    }
    // Initial small human-like mouse movement
    try {
      await page.mouse.move(randInt(100, 400), randInt(100, 300))
      await page.waitForTimeout(randInt(150, 400))
      await page.mouse.move(randInt(500, 900), randInt(200, 600))
    } catch {}
    for (let i = 0; i < SCROLL_PAGES; i++) {
      await smartScroll(page)
      await page.waitForTimeout(randInt(SCROLL_MIN_MS, SCROLL_MAX_MS))

      const stats = await page.evaluate(() => ({
        h: document.body.scrollHeight,
        inner: window.innerHeight,
      }))
      debug(`Scroll ${i + 1}/${SCROLL_PAGES}`, { bodyH: stats.h, innerH: stats.inner, collected: collected.length })

      if (i === Math.floor(SCROLL_PAGES / 2) && collected.length === 0) {
        warn('Mid-run: still 0 edges collected; possible auth/visibility restriction or API change.')
      }
      // occasional small up-scroll to mimic reading
      if (Math.random() < 0.25) {
        await page.evaluate(() => window.scrollBy(0, -Math.floor(window.innerHeight * 0.3)))
        await page.waitForTimeout(randInt(350, 900))
      }
      // Lightweight periodic login wall check to be resource-efficient
      if (!loginWallCaptured && (i === 0 || i % 3 === 0)) {
        try {
          if (await isLoginWallVisible(page)) {
            warn('Login wall or limited view detected (mid-scroll).')
            await writeDebugFile('login_wall_mid.html', await page.content(), { redacted: true })
            try { await page.screenshot({ path: path.join(DEBUG_DIR, 'login_wall_mid.png'), fullPage: true }) } catch {}
            loginWallCaptured = true
          }
        } catch {}
      }
      if (collected.length >= MAX_ITEMS) break
    }

    // final short wait for trailing network
    await page.waitForTimeout(randInt(900, 1600))

    // If nothing intercepted yet, fallback: parse SSR-embedded __bbox blocks
    if (collected.length === 0) {
      try {
        info('No GraphQL edges captured; attempting SSR fallback...')
        const scripts = await page.$$eval('script', (els) => els.map((e) => e.textContent || ''))
        debug('SSR: scanning script tags', scripts.length)

        const edgesFallback: any[] = []
        let bboxFound = 0

        const pushEdgesFromJson = (json: any) => {
          try {
            const result = json?.__bbox?.result
            const data = result?.data
            if (!data) return

            // 1) Old path
            const edgesOld = data?.marketplace_search?.feed_units?.edges
            if (Array.isArray(edgesOld) && edgesOld.length) {
              edgesFallback.push(...edgesOld)
              return
            }

            // 2) Modular feed path
            const mf = data?.modularFeed
            if (mf) {
              const loose = Array.isArray(mf.looseTiles) ? mf.looseTiles : []
              const items = Array.isArray(mf.items) ? mf.items : []
              const all = [...loose, ...items]
              if (all.length) {
                for (const x of all) edgesFallback.push({ node: x })
                return
              }
            }

            // 3) Generic: feed_units.*.edges under any key
            for (const k of Object.keys(data)) {
              const v = (data as any)[k]
              const edges = v?.feed_units?.edges
              if (Array.isArray(edges) && edges.length) {
                edgesFallback.push(...edges)
              }
            }
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
              try {
                const parsed = JSON.parse(frag)
                bboxFound++
                if (FB_CAPTURE_RAW || metrics.graphqlEdges === 0) {
                  if (bboxFound === 1 || FB_CAPTURE_RAW) {
                    await writeDebugFile(`ssr_bbox_${Date.now()}_${bboxFound}.json`, JSON.stringify(parsed, null, 2), { redacted: true })
                  }
                }
                pushEdgesFromJson(parsed)
              } catch {}
              idx = txt.indexOf('{"__bbox"', end)
            } else {
              break
            }
          }
        }
        debug('SSR: bbox objects', bboxFound)
        if (edgesFallback.length) {
          metrics.ssrEdges += edgesFallback.length
          collected.push(...edgesFallback.map((e) => ({ node: e?.node || e })))
          debug('SSR __bbox edges+', edgesFallback.length, 'total=', collected.length)
        }
      } catch (e) {
        warn('SSR parse failed', (e as Error).message)
      }
    }

    // If still nothing, inspect DOM and optionally capture artifacts
    if (collected.length === 0) {
      const domCounts = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
        const articles = Array.from(document.querySelectorAll('[role="article"]'))
        return { anchors: anchors.length, articles: articles.length }
      })
      metrics.domCandidates = domCounts.anchors + domCounts.articles
      debug('DOM candidates', domCounts)

      if (FB_CAPTURE_ON_ZERO) {
        await writeDebugFile('last.html', await page.content(), { redacted: true })
        await ensureDir(DEBUG_DIR)
        try { await page.screenshot({ path: path.join(DEBUG_DIR, 'last.png'), fullPage: true }) } catch {}
      }
    }

    // Belt-and-suspenders: optional DOM-anchor fallback when all else fails
    if (collected.length === 0 && (process.env.FB_DOM_ANCHOR_FALLBACK === '1')) {
      try {
        const anchors = await page.$$eval('a[href*="/marketplace/item/"]', (as) =>
          (as as Element[]).map((a) => {
            const el = a as HTMLAnchorElement
            const href = el.href || el.getAttribute('href') || ''
            const m = href.match(/\/item\/(\d+)/)
            return m ? { id: m[1], url: href.startsWith('http') ? href : 'https://www.facebook.com' + href } : null
          }).filter(Boolean)
        ) as Array<{ id: string; url: string }>
        const now = new Date().toISOString()
        const rows: ListingRow[] = anchors.map((a) => ({
          source: 'facebook',
          remote_id: a.id,
          remote_slug: null,
          url: a.url,
          title: null,
          price: null,
          year: null,
          make: null,
          model: null,
          mileage: null,
          city: null,
          posted_at: null,
          first_seen_at: now,
        }))
        info('DOM anchor fallback rows', rows.length)
        return rows.slice(0, MAX_ITEMS)
      } catch (e) {
        warn('DOM anchor fallback failed', (e as Error).message)
      }
    }

    // --- Normalize & dedupe ---
    let rows = collected.map((e) => {
      const r = normalizeEdge(e)
      return r || null
    }).filter(Boolean) as ListingRow[]
    metrics.normalized = rows.length

    const seen = new Set<string>()
    rows = rows.filter((r) =>
      seen.has(r.remote_id) ? false : (seen.add(r.remote_id), true)
    )
    metrics.deduped = rows.length

    info('Summary', {
      gqlReq: metrics.graphqlRequests,
      gqlResp: metrics.graphqlResponses,
      gqlOK: metrics.graphqlResponsesOk,
      gqlErr: metrics.graphqlErrors,
      gqlEdges: metrics.graphqlEdges,
      ssrEdges: metrics.ssrEdges,
      normalized: metrics.normalized,
      deduped: metrics.deduped,
      domCandidates: metrics.domCandidates,
    })

    if (!rows.length) {
      warn('No rows from GraphQL/SSR; attempting DOM fallback...')
      const domRows = await extractDomListings(page)
      if (domRows.length) {
        info(`DOM fallback recovered ${domRows.length} items`)
        rows = domRows
      }
    }

    // rows is now unique list
    return rows.slice(0, MAX_ITEMS)
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
  const baseSession = (process.env.FB_PROXY_SESSION_ID || 'la01').trim()
  let session = baseSession

  console.log('[FB] Starting Marketplace capture...', { headless: HEADLESS, pages: SCROLL_PAGES, proxy: usingProxy ? 'on' : 'off', cookies: !!FB_COOKIES_PATH })

  let allRows: ListingRow[] = []
  for (let attempt = 1; attempt <= FB_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // rotate sticky session between attempts
      session = nextSessionId(session)
      if (FB_DEBUG) console.log('[FB] Rotating sticky session ->', session)
    }

    const rows = await interceptFacebookGraphQL(session)
    if (FB_DEBUG) console.log(`[FB] Attempt ${attempt}: captured ${rows.length} rows`)
    if (rows.length === 0) {
      // If a login wall was detected, don't waste attempts rotating
      if (lastLoginWallDetected) {
        console.warn('[FB:WARN] Login wall detected; rotation unlikely to help. Please refresh cookies.')
        break
      }
      // Inspect cookies export to see if XS exists; if not, advise refresh
      const hasXS = await hasXsFromCookiesExport()
      if (hasXS === false) {
        console.warn('[FB:WARN] XS cookie missing/invalid. Rotation will not fix this. Please refresh cookies.')
        break
      }
    }
    if (rows.length >= FB_MIN_ROWS_SUCCESS) {
      allRows = rows
      break // success
    }

    if (!FB_ROTATE_ON_ZERO) { allRows = rows; break } // no auto-rotate configured
    // else: loop to next attempt with rotated session
  }

  console.log(`[FB] Captured ${allRows.length} candidate items`)
  const res = await upsertListings(allRows)
  console.log(JSON.stringify({ ok: true, source: 'facebook', inserted: res.inserted, skipped: res.skipped }))
}

// CLI
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => { console.error('[FB] Failed:', e); process.exit(1) })
}
