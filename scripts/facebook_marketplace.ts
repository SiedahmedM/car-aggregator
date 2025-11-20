import { chromium, Browser, Page, LaunchOptions, BrowserContext, Route } from 'playwright'
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
const FB_DEBUG = (() => {
  const v = (process.env.FB_DEBUG ?? '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
})()

// Debug + capture utilities -------------------------------------------------
const DEBUG_DIR = process.env.FB_DEBUG_DIR || 'debug/facebook'
const FB_CAPTURE_RAW = (process.env.FB_CAPTURE_RAW ?? '0') === '1'
const FB_CAPTURE_ON_ZERO = (process.env.FB_CAPTURE_ON_ZERO ?? '1') !== '0'
const FB_USE_STORAGE_STATE = (process.env.FB_USE_STORAGE_STATE ?? '0') === '1'
const FB_STORAGE_STATE = process.env.FB_STORAGE_STATE || 'secrets/fb_state.json'

// Target filtering defaults (override via env at runtime)
const TARGET_MAKE  = (process.env.FB_MAKE  || 'Honda').toLowerCase()
const TARGET_MODEL = (process.env.FB_MODEL || 'Civic').toLowerCase()
const TARGET_LIMIT = Number.isFinite(parseInt(process.env.FB_LIMIT || '', 10))
  ? parseInt(process.env.FB_LIMIT!, 10)
  : 20

// Vehicles and Honda/Civic taxonomy IDs you observed in GraphQL
const VEHICLES_CATEGORY_ID = '546583916084032' // "Vehicles" (string form)
const VEHICLES_CATEGORY_ID_NUM = 546583916084032 // numeric form for queries expecting numbers
const HONDA_MAKE_ID        = '308436969822020' // "Honda"
const CIVIC_MODEL_ID       = '337357940220456' // "Civic"

// Target filter & count (doc_id variables alignment)
const TARGET = {
  limit: 20,
  vehicleType: 'car_truck',
  sortBy: 'creation_time_descend' as const,
}

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

// Single-install GraphQL interceptor ----------------------------------------
let gqlInterceptorInstalled = false
let marketplacePatchDisabled = false
let marketplacePatchTried = false

export async function installMarketplaceGraphQLInterceptor(context: BrowserContext) {
  if (gqlInterceptorInstalled) return () => Promise.resolve()
  gqlInterceptorInstalled = true

  const graphqlPattern = '**/api/graphql/**'

  const handler = async (route: Route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.continue()

    const headers = req.headers()
    const ct = headers['content-type'] || ''
    if (!ct.includes('application/x-www-form-urlencoded')) return route.continue()

    const body = req.postData() || ''
    const params = new URLSearchParams(body)
    // Count and log request metadata for visibility
    try { metrics.graphqlRequests += 1 } catch {}
    const docIdMeta = params.get('doc_id') || params.get('docId') || ''
    const friendlyHeaderMeta = headers['x-fb-friendly-name'] || ''
    const friendlyParamMeta = params.get('fb_api_req_friendly_name') || ''
    const friendlyMeta = friendlyHeaderMeta || friendlyParamMeta
    try { debug('GQL-> req', { friendly: friendlyMeta, docId: docIdMeta, size: body.length }) } catch {}
    const friendlyHeader = headers['x-fb-friendly-name'] || ''
    // Some builds set friendly name only in form fields; check both
    const bodyForFriendly = req.postData() || ''
    const pForFriendly = new URLSearchParams(bodyForFriendly)
    const friendlyParam = pForFriendly.get('fb_api_req_friendly_name') || ''
    const isTarget = friendlyHeader === 'CometMarketplaceCategoryContentPaginationQuery' || friendlyParam === 'CometMarketplaceCategoryContentPaginationQuery'
    if (!isTarget) {
      // allow other handlers (catch-all) to process
      return route.fallback?.() ?? route.continue()
    }
    if (marketplacePatchDisabled) {
      // Skip patching for this session to avoid UI error banner
      return route.continue()
    }

    const rawVars = params.get('variables') || '{}'
    let variables: any
    try { variables = JSON.parse(rawVars) } catch { return route.fallback?.() ?? route.continue() }
    const beforeVars = variables && typeof variables === 'object' ? JSON.parse(JSON.stringify(variables)) : null
    marketplacePatchTried = true

    // Inject filters and sort (try to match existing container/shape)
    const setSort = () => {
      const trySet = (obj: any): boolean => {
        if (!obj || typeof obj !== 'object') return false
        if ('filterSortingParams' in obj) {
          const f = obj.filterSortingParams || {}
          f.sort_by_filter = 'CREATION_TIME'
          f.sort_order = 'DESCEND'
          // also set comet-style keys as a backup
          f.sortBy = 'creation_time_descend'
          f.sort_by = 'creation_time_descend'
          obj.filterSortingParams = f
          return true
        }
        if ('sort_by_filter' in obj || 'sort_order' in obj) {
          obj.sort_by_filter = 'CREATION_TIME'
          obj.sort_order = 'DESCEND'
          return true
        }
        if ('sortBy' in obj || 'sort_by' in obj) {
          obj.sortBy = 'creation_time_descend'; obj.sort_by = 'creation_time_descend'
          return true
        }
        for (const k of Object.keys(obj)) { const v = (obj as any)[k]; if (v && typeof v === 'object') { if (trySet(v)) return true } }
        return false
      }
      if (!trySet(variables)) variables.filterSortingParams = { sort_by_filter: 'CREATION_TIME', sort_order: 'DESCEND', sortBy: 'creation_time_descend', sort_by: 'creation_time_descend' }
    }
    setSort()
    variables.topLevelVehicleType = 'car_truck'

    const WANT_MAKE = (process.env.FB_FILTER_MAKE || 'honda').toLowerCase()
    const WANT_MODEL = (process.env.FB_FILTER_MODEL || 'civic').toLowerCase()
    const MAP_STRING_TO_ID: Record<string, string> = { honda: '308436969822020', civic: '337357940220456' }
    const makeId = MAP_STRING_TO_ID[WANT_MAKE] || WANT_MAKE
    const modelId = MAP_STRING_TO_ID[WANT_MODEL] || WANT_MODEL

    // Prefer Comet's { name, values } input shape; fall back key/value if that's what vars use
    // Find vertical fields container recursively and upsert values
    const patchVerticals = (root: any) => {
      const keys = ['stringVerticalFields','verticalFields','appliedVerticalFields']
      const visit = (obj: any): boolean => {
        if (!obj || typeof obj !== 'object') return false
        for (const k of keys) {
          if (Array.isArray(obj[k])) {
            const arr = obj[k]
            const usesNameValues = arr.length === 0 ? true : (('name' in (arr[0]||{})) || ('values' in (arr[0]||{})))
            const upsertNV = (name: string, values: string[]) => {
              let i = arr.findIndex((f: any) => f?.name === name)
              if (i < 0) arr.push({ name, values })
              else arr[i] = { name, values }
            }
            const upsertKV = (key: string, value: string) => {
              let i = arr.findIndex((f: any) => f?.key === key)
              if (i < 0) arr.push({ key, value })
              else arr[i] = { key, value }
            }
            if (usesNameValues) {
              upsertNV('topLevelVehicleType', ['car_truck'])
              upsertNV('make', [makeId])
              upsertNV('model', [modelId])
            } else {
              upsertKV('topLevelVehicleType', 'car_truck')
              upsertKV('make', makeId)
              upsertKV('model', modelId)
            }
            return true
          }
        }
        for (const k of Object.keys(obj)) { const v = obj[k]; if (v && typeof v === 'object') { if (visit(v)) return true } }
        return false
      }
      if (!visit(root)) {
        // create minimal container if not found at any depth
        root.stringVerticalFields = [
          { name: 'topLevelVehicleType', values: ['car_truck'] },
          { name: 'make', values: [makeId] },
          { name: 'model', values: [modelId] },
        ]
      }
    }
    patchVerticals(variables)

    // Scope to Vehicles if the var exists in this query variant
    const setCategory = (obj: any): boolean => {
      if (!obj || typeof obj !== 'object') return false
      if (Array.isArray(obj.categoryIDArray)) { obj.categoryIDArray = [VEHICLES_CATEGORY_ID_NUM]; return true }
      if (obj.filters && Array.isArray(obj.filters.categoryIDArray)) { obj.filters.categoryIDArray = [VEHICLES_CATEGORY_ID]; return true }
      for (const k of Object.keys(obj)) { const v = obj[k]; if (v && typeof v === 'object') { if (setCategory(v)) return true } }
      return false
    }
    setCategory(variables)

    const desiredCount = Math.max(30, Number(process.env.FB_LIMIT || 30))
    variables.count = Math.max(variables.count || 0, desiredCount)

    if (typeof debug === 'function') {
      debug('[PATCH]', {
        topLevelVehicleType: 'car_truck',
        make: makeId,
        model: modelId,
        sortBy: variables.filterSortingParams?.sortBy,
        count: variables.count,
      })
      try {
        await writeDebugFile(`gql_vars_before_${Date.now()}.json`, JSON.stringify(beforeVars ?? {}, null, 2), { redacted: true })
        await writeDebugFile(`gql_vars_after_${Date.now()}.json`, JSON.stringify(variables ?? {}, null, 2), { redacted: true })
      } catch {}
    }

    params.set('variables', JSON.stringify(variables))
    return await route.continue({ postData: params.toString() })
  }

  await context.route(graphqlPattern, handler)

  return async () => {
    await context.unroute(graphqlPattern, handler)
    gqlInterceptorInstalled = false
  }
}

async function installCatchAllRoute(context: BrowserContext) {
  if (!FB_BLOCK_ASSETS) return
  await context.route('**/*', async (route) => {
    const req = route.request()
    const rt = req.resourceType()
    if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'websocket') return route.abort()
    // Optional host-level guard for chat/gateway sockets that can churn
    try {
      const h = new URL(req.url()).hostname
      if (/(^|\.)edge-chat\.facebook\.com$/i.test(h) || /(^|\.)gateway\.facebook\.com$/i.test(h)) {
        return route.abort()
      }
    } catch {}
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
  // Heuristic: actual login UI shows an email+password or a login form action
  const loginForm = page.locator('form[action*="login" i]')
  const email = page.locator('input[name="email"]')
  const pass = page.locator('input[name="pass"], input[type="password"]')
  const loginBtn = page.getByRole('button', { name: /log in/i })
  const counts = await Promise.all([loginForm.count(), email.count(), pass.count(), loginBtn.count()])
  const visible = counts.some(c => c > 0)
  return visible
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
  created_at_ts?: number
}

function isVehicleRow(r: ListingRow): boolean {
  if (r.year != null || r.mileage != null) return true
  if ((r.make || '').length || (r.model || '').length) return true
  const t = (r.title || '').toLowerCase()
  if (/(sedan|coupe|hatchback|suv|truck|van|convertible|wagon|motor|engine|awd|fwd|rwd|mileage|mi\b)/i.test(t)) return true
  return false
}

function isTargetRow(r: ListingRow): boolean {
  const makeOk = (r.make || '').toLowerCase() === TARGET_MAKE
  const modelOk = (r.model || '').toLowerCase() === TARGET_MODEL
  if (makeOk && modelOk) return true
  const hay = `${r.title ?? ''} ${r.make ?? ''} ${r.model ?? ''}`.toLowerCase()
  const hasModel = new RegExp(`\\b${TARGET_MODEL.replace(/[-/\\^$*+?.()|[\]{}]/g, '')}\\b`, 'i').test(hay)
  const hasMake = new RegExp(`\\b${TARGET_MAKE.replace(/[-/\\^$*+?.()|[\]{}]/g, '')}\\b`, 'i').test(hay)
  return hasModel && (hasMake || makeOk)
}

function ts(r: ListingRow): number {
  if (typeof (r as any).created_at_ts === 'number' && Number.isFinite((r as any).created_at_ts)) return (r as any).created_at_ts as number
  const t = r.posted_at || r.first_seen_at
  const n = t ? Date.parse(t) : 0
  return Number.isFinite(n) ? n : 0
}

function sortByFreshestDesc(a: ListingRow, b: ListingRow) {
  return ts(b) - ts(a)
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
  const looksLikeListingEdges = (edges: any[]): boolean => {
    if (!Array.isArray(edges) || edges.length === 0) return false
    return edges.some((e) => {
      const n = e?.node ?? e
      return !!(
        n?.listing ||
        n?.product?.listing ||
        n?.target?.listing ||
        n?.marketplace_listing ||
        n?.story?.marketplace_listing ||
        n?.__typename?.toLowerCase?.().includes('marketplace')
      )
    })
  }

  // 1) Legacy top-level
  try {
    const edges = body?.data?.marketplace_search?.feed_units?.edges
    if (looksLikeListingEdges(edges)) return edges
  } catch {}

  // 2) Modular feed experiments (top-level)
  try {
    const mf = body?.data?.modularFeed
    const loose = Array.isArray(mf?.looseTiles) ? mf.looseTiles : []
    const items = Array.isArray(mf?.items) ? mf.items : []
    const all = [...loose, ...items]
    if (all.length) return all.map((x: any) => ({ node: x }))
  } catch {}

  // 3) Recursively walk viewer for feed_units edges/items only (avoid unrelated edges)
  const walk = (obj: any, out: any[] = []): any[] => {
    if (!obj || typeof obj !== 'object') return out
    // Only accept edges under a feed_units container
    if ((obj as any).feed_units && Array.isArray((obj as any).feed_units?.edges) && looksLikeListingEdges((obj as any).feed_units.edges)) {
      out.push(...(obj as any).feed_units.edges)
    }

    // nested modular feed under viewer
    if (Array.isArray(obj?.items) || Array.isArray(obj?.looseTiles)) {
      const loose = Array.isArray(obj?.looseTiles) ? obj.looseTiles : []
      const items = Array.isArray(obj?.items) ? obj.items : []
      const all = [...loose, ...items]
      if (all.length) out.push(...all.map((x: any) => ({ node: x })))
    }

    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (v && typeof v === 'object') walk(v, out)
    }
    return out
  }

  try {
    const viewer = body?.data?.viewer
    if (viewer) {
      const found = walk(viewer)
      if (found.length) return found
    }
  } catch {}

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
    const remoteId: string | undefined = String(
      listing.id ||
      listing.listing_id ||
      node?.marketplace_listing?.id ||
      node?.id ||
      (edge as any)?.listing_id ||
      ''
    )
    if (!remoteId) { if (FB_DEBUG) debug('normalizeEdge: missing id'); return null }

    const title: string | null = listing.marketplace_listing_title || listing.title || listing.marketplace_item_title || listing.custom_title || null
    const priceRaw =
      listing?.listing_price?.amount ??
      listing?.listing_price?.formatted_amount ??
      listing?.price?.amount ??
      listing?.vehicle_price?.amount ??
      listing?.numeric_price ??
      listing?.formatted_price ?? null
    const mileageRaw =
      listing?.vehicle_odometer_data?.vehicle_mileage ??
      listing?.vehicle_odometer_data?.vehicle_mileage_text ??
      listing?.odometer_value ??
      listing?.odometer_reading?.value ?? null
    const permalink: string | null = listing?.story_permalink || listing?.marketplace_item_permalink || null

    const { year: yearGuess, make: makeGuess, model: modelGuess } = parseTitleForYmm(title)
    const year = parseIntSafe(listing?.year) ?? yearGuess
    const makeFromSpec = listing?.vehicle_listing_specs?.make ?? listing?.make_name ?? listing?.make
    const modelFromSpec = listing?.vehicle_listing_specs?.model ?? listing?.model_name ?? listing?.model
    const make: string | null = (makeFromSpec || makeGuess || null)?.toLowerCase?.() ?? null
    const model: string | null = (modelFromSpec || modelGuess || null)?.toLowerCase?.() ?? null
    let price = parseIntSafe(priceRaw)
    if (price == null && typeof priceRaw === 'string') {
      // Prefer thousand-formatted numbers, then plain digits
      const mThousands = priceRaw.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)/)
      const mPlain = priceRaw.match(/\$?\s*([0-9]+(?:\.[0-9]{2})?)(?![0-9])/)
      const token = (mThousands?.[1] || mPlain?.[1] || '').replace(/,/g, '')
      if (token) {
        const n = Math.round(parseFloat(token))
        if (Number.isFinite(n)) price = n
      }
    }
    const mileage = parseIntSafe(mileageRaw)
    const postedAt: string | null = listing?.creation_time ? new Date(listing.creation_time * 1000).toISOString() : (node?.creation_time ? new Date(node.creation_time * 1000).toISOString() : null)
    const city: string | null =
      listing?.location?.reverse_geocode?.city ||
      listing?.location?.city ||
      listing?.marketplace_listing_location?.reverse_geocode?.city ||
      null

    const createdSec = listing?.creation_time ?? listing?.listing_time ?? node?.creation_time ?? null
    const createdTs = createdSec ? Number(createdSec) * 1000 : (postedAt ? Date.parse(postedAt) : null)

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
      created_at_ts: createdTs ?? undefined,
    }
    return row
  } catch {
    return null
  }
}

function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }

async function extractDomListings(page: Page): Promise<ListingRow[]> {
  return await page.$$eval('a[href*="/marketplace/item/"]', (anchors) => {
    const nowISO = new Date().toISOString()
    const seen = new Set<string>()
    const out: any[] = []

    for (const a of anchors as HTMLAnchorElement[]) {
      const hrefAttr = a.getAttribute('href') || ''
      const m = hrefAttr.match(/\/marketplace\/item\/(\d+)/)
      if (!m) continue
      const id = m[1]
      if (seen.has(id)) continue
      seen.add(id)

      const title = a.getAttribute('aria-label') || a.textContent?.trim() || null

      // Heuristic: try to extract price and city from nearby text
      let price: number | null = null
      let city: string | null = null
      let year: number | null = null
      let mileage: number | null = null
      try {
        const container = (a.closest('[role="article"]') as HTMLElement | null) || (a.parentElement as HTMLElement | null)
        const text = (container?.textContent || a.textContent || '') as string
        // Strict price: number with optional thousands, stop before next digit
        const pm = text.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)(?!\d)/)
        if (pm) {
          const clean = pm[1].replace(/,/g, '')
          const n = Math.round(parseFloat(clean))
          if (Number.isFinite(n)) price = n
        }
        const ym = text.match(/\b(19\d{2}|20\d{2})\b/)
        if (ym) {
          const y = parseInt(ym[1], 10)
          if (y >= 1950 && y <= 2100) year = y
        }
        const mm = text.match(/\b([0-9][0-9,]{2,})\s*(mi|miles)\b/i)
        if (mm) {
          const mv = parseInt(mm[1].replace(/,/g, ''), 10)
          if (Number.isFinite(mv)) mileage = mv
        }
        const cm = text.match(/\bin\s+([A-Za-z .,'-]{2,60})/i)
        if (cm) {
          city = (cm[1] || '').trim() || null
        }
      } catch {}

      // Derive a cleaner title by removing price/city/mileage tokens
      let cleanTitle = title
      try {
        if (cleanTitle) {
          cleanTitle = cleanTitle.replace(/\$\s*[0-9,\.]+/, '').replace(/\bin\s+[A-Za-z .,'-]{2,60}/i, '').replace(/\b[0-9][0-9,]{2,}\s*(mi|miles)\b/i, '').replace(/\s{2,}/g, ' ').trim()
        }
      } catch {}

      out.push({
        source: 'facebook',
        remote_id: id,
        remote_slug: null,
        url: a.href.startsWith('http') ? a.href : `https://www.facebook.com${hrefAttr}`,
        title: cleanTitle,
        price,
        year,
        make: null,
        model: null,
        mileage,
        city,
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
  const matched: ListingRow[] = []
  const matchedIds = new Set<string>()
  let uninstallGql: null | (() => Promise<void>) = null
  // Maintain newest top TARGET.limit items while scrolling
  const top: ListingRow[] = []
  const topSeen = new Set<string>()
  function pushRows(rows: ListingRow[]) {
    for (const r of rows) {
      const id = (r as any).remote_id || (r as any).id
      if (!id) continue
      if (topSeen.has(id)) continue
      topSeen.add(id)
      top.push(r)
    }
    // Newest first using numeric ts; fallback to string dates
    top.sort((a, b) => (Number(b.created_at_ts ?? 0) - Number(a.created_at_ts ?? 0))
      || ((b.posted_at || '').localeCompare(a.posted_at || ''))
      || ((b.first_seen_at || '').localeCompare(a.first_seen_at || '')))
    if (top.length > TARGET.limit) top.length = TARGET.limit
  }
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
    // If using storage state, sanity-check cookies present for runtime
    try {
      if (FB_USE_STORAGE_STATE) {
        const ck = await context.cookies('https://www.facebook.com')
        const hasCUser = ck.some((k) => k.name === 'c_user' && k.value)
        const hasXS = ck.some((k) => k.name === 'xs' && k.value && k.value !== 'deleted')
        debug('Cookie check (storageState):', { hasCUser, hasXS, count: ck.length })
      }
    } catch {}
    // Install routes in correct order (GQL first, then catch-all)
    uninstallGql = await installMarketplaceGraphQLInterceptor(context)
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

      // Robust parse: object, array of payloads, or concatenated JSON objects
      const parsedPayloads: any[] = []
      const ttrim = text.trim()
      const tryPush = (obj: any) => { if (obj && typeof obj === 'object') parsedPayloads.push(obj) }
      let parseOk = false
      try {
        const obj = JSON.parse(ttrim)
        if (Array.isArray(obj)) obj.forEach(tryPush)
        else tryPush(obj)
        parseOk = true
      } catch {}
      if (!parseOk) {
        // Attempt concatenated JSON objects via brace matching
        try {
          let idx = ttrim.indexOf('{')
          while (idx !== -1) {
            let depth = 0, inStr = false, esc = false, end = -1
            for (let i = idx; i < ttrim.length; i++) {
              const ch = ttrim[i]
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
              const frag = ttrim.slice(idx, end)
              try { const obj = JSON.parse(frag); tryPush(obj) } catch {}
              idx = ttrim.indexOf('{', end)
            } else {
              break
            }
          }
        } catch {}
      }
      if (!parsedPayloads.length) {
        warn('GQL resp JSON parse error', 'Unable to parse payload')
        await writeDebugFile(`graphql_resp_parsefail_${Date.now()}_${metrics.graphqlResponses}.txt`, text)
        return
      }

      if (status >= 200 && status < 300) metrics.graphqlResponsesOk += 1

      // Fold over all parsed payloads
      let totalEdges = 0
      let dataKeys: string[] = []
      let feedType = 'unknown'
      let anyErrors = false
      for (const body of parsedPayloads) {
        if (body?.errors) { anyErrors = true }
        const dk = body?.data ? Object.keys(body.data) : []
        if (dk.length) dataKeys = dk
        if (body?.data?.marketplace_search) feedType = 'marketplace_search'
        else if (body?.data?.modularFeed) feedType = 'modularFeed'
        const edges = extractEdgesFromBody(body)
        totalEdges += Array.isArray(edges) ? edges.length : 0
        if (edges?.length) {
          collected.push(...edges)
        }
      }
      if (anyErrors) {
        metrics.graphqlErrors += 1
        try {
          const errMsg = parsedPayloads.map(p => p?.errors?.[0]?.message).filter(Boolean)[0]
          if (errMsg) {
            const msg = sanitize(String(errMsg)).slice(0, 300)
            debug('GQL errors present (batched):', msg)
            if (/noncoercible_variable_value/i.test(msg)) {
              // Disable further patching for this session to avoid UI banner spam
              try { marketplacePatchDisabled = true } catch {}
              warn('Disabling Marketplace patch for this session due to variable type error')
            }
          }
          else debug('GQL errors present (batched)')
        } catch {}
      }

      metrics.graphqlEdges += totalEdges

      const feedUnitsDeep = countFeedUnitsDeep(parsedPayloads[0]?.data)
      debug('GQL<-', { status, url, dataKeys, feedType, edges: totalEdges, feedUnitsDeep })

      if (totalEdges === 0 || FB_CAPTURE_RAW) {
        const out = parsedPayloads.length === 1 ? parsedPayloads[0] : parsedPayloads
        await writeDebugFile(`graphql_resp_${Date.now()}_${metrics.graphqlResponses}.json`, JSON.stringify(out, null, 2), { redacted: true })
      }
      if (totalEdges) {
        const sample = (collected as any[])
          .slice(-Math.min(10, collected.length))
          .map((e: any) => e?.node?.listing?.id || e?.node?.id || e?.listing_id)
          .filter(Boolean)
          .slice(0, 5)
        console.log('[FB:DEBUG] edges+', totalEdges, 'sample ids=', sample)
        if (FB_DEBUG) console.log('[FB] edges total=', collected.length)
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
    try {
      await page.goto('https://www.facebook.com/marketplace/category/vehicles?sortBy=creation_time_descend&exact=false', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch (e) {
      warn('Nav failed', (e as Error).message)
      // Return empty to let the controller rotate session/proxy without crashing
      return []
    }
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
      // Early stop if we already have enough target matches; accumulate target rows and keep top newest
      try {
        const tmpRows = (() => {
          const raw = collected.map(normalizeEdge).filter(Boolean) as ListingRow[]
          const seenTmp = new Set<string>()
          return raw.filter(r => (seenTmp.has(r.remote_id) ? false : (seenTmp.add(r.remote_id), true)))
        })()
        // Accumulate target matches and maintain top newest
        const targetBatch: ListingRow[] = []
        for (const r of tmpRows) {
          if (isTargetRow(r) && !matchedIds.has(r.remote_id)) {
            matched.push(r)
            matchedIds.add(r.remote_id)
            targetBatch.push(r)
            if (matched.length >= TARGET_LIMIT) break
          }
        }
        if (targetBatch.length) pushRows(targetBatch)
        debug('Target match count', { matchCount: matched.length, limit: TARGET_LIMIT })
        if (top.length >= TARGET.limit || matched.length >= TARGET_LIMIT) {
          info(`[FB] Reached ${TARGET.limit} target rows; stopping early.`)
          break
        }
      } catch {}
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
    const gRows = collected.map((e) => normalizeEdge(e)).filter(Boolean) as ListingRow[]
    metrics.normalized = gRows.length

    const dedup = (() => {
      const seen = new Set<string>()
      return gRows.filter((r) => (seen.has(r.remote_id) ? false : (seen.add(r.remote_id), true)))
    })()
    metrics.deduped = dedup.length

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

    // Apply a vehicle gate to drop obvious non-vehicle noise
    let finalRows: ListingRow[] = dedup.filter(isVehicleRow)
    if (!finalRows.length) {
      warn('No rows from GraphQL/SSR; attempting DOM fallback...')
      const domRows = await extractDomListings(page)
      if (domRows.length) {
        info(`DOM fallback recovered ${domRows.length} items`)
        finalRows = domRows
      }
    }

    // If we maintained a top list during scroll, prefer that
    if (top.length) {
      finalRows = top.slice()
    } else if (matched.length) {
      finalRows = matched.slice()
    } else {
      try {
        const filtered = finalRows.filter(isTargetRow)
        if (filtered.length) finalRows = filtered
      } catch {}
      // If still under target, try to top up from DOM anchors
      if (finalRows.length < TARGET_LIMIT) {
        try {
          const domRows = await extractDomListings(page)
          for (const r of domRows) {
            if (isTargetRow(r) && !finalRows.find(x => x.remote_id === r.remote_id)) {
              finalRows.push(r)
              if (finalRows.length >= TARGET_LIMIT) break
            }
          }
        } catch {}
      }
    }
    finalRows.sort(sortByFreshestDesc)

    // rows is now unique list
    return finalRows.slice(0, Math.min(MAX_ITEMS, TARGET_LIMIT))
  } finally {
    try { await uninstallGql?.() } catch {}
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
