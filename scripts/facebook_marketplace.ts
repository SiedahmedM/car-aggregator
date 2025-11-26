import { chromium, Browser, Page, LaunchOptions, BrowserContext, Route } from 'playwright'
import { sanitize, pickBestYearFromText, extractFacebookPostedAt } from '../scrapers/facebook/fb_utils'
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

// Run-specific directory (will be set per session)
let RUN_DIR = DEBUG_DIR

// Target filtering (no defaults - empty means "all vehicles" like OfferUp)
const TARGET_MAKE  = (process.env.FB_MAKE  || '').toLowerCase()
const TARGET_MODEL = (process.env.FB_MODEL || '').toLowerCase()
const TARGET_LIMIT = Number.isFinite(parseInt(process.env.FB_LIMIT || '', 10))
  ? parseInt(process.env.FB_LIMIT!, 10)
  : 20

// COLLECTION_LIMIT: Collect more than needed so we can sort by timestamp and take the newest
// This ensures we get the MOST RECENT listings, not just the first N matches from Facebook's feed
const COLLECTION_LIMIT = TARGET_LIMIT * 2.5  // Collect 2.5x the target (e.g., 50 if limit is 20)

// Vehicles category ID for GraphQL
const VEHICLES_CATEGORY_ID = '546583916084032' // "Vehicles" (string form)
const VEHICLES_CATEGORY_ID_NUM = 546583916084032 // numeric form for queries expecting numbers
// Vehicle taxonomy IDs (if needed for future structured filtering)
// const HONDA_MAKE_ID  = '308436969822020'
// const CIVIC_MODEL_ID = '337357940220456'

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

async function writeDebugFile(name: string, content: string | Buffer, opts: { redacted?: boolean } = {}) {
  // Only write when raw capture is explicitly enabled
  if (!FB_CAPTURE_RAW) return
  await ensureDir(RUN_DIR)
  const p = path.join(RUN_DIR, name)
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

// Minimum year we’re willing to trust from detail-page heuristics
// (can be relaxed via env if you care about true classics).
const FB_MIN_DETAIL_YEAR = parseInt(process.env.FB_MIN_DETAIL_YEAR || '1995', 10) || 1995

// Only keep FB listings posted within this many hours (optional).
// Example: FB_FILTER_POSTED_WITHIN_HOURS=72
const FB_FILTER_POSTED_WITHIN_HOURS = parseInt(process.env.FB_FILTER_POSTED_WITHIN_HOURS || '', 10) || null

const gqlRegex = /https:\/\/(www|web|m)\.facebook\.com\/api\/graphql(?:\/|\?|$)/i

// Single-install GraphQL interceptor ----------------------------------------
let gqlInterceptorInstalled = false
let marketplacePatchDisabled = false
let marketplacePatchTried = false
let lastRequestWasMarketplace = false  // Track if last request was marketplace pagination

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
    const friendlyHeader = headers['x-fb-friendly-name'] || ''
    // Some builds set friendly name only in form fields; check both
    const bodyForFriendly = req.postData() || ''
    const pForFriendly = new URLSearchParams(bodyForFriendly)
    const friendlyParam = pForFriendly.get('fb_api_req_friendly_name') || ''
    const isTarget = friendlyHeader === 'CometMarketplaceCategoryContentPaginationQuery' || friendlyParam === 'CometMarketplaceCategoryContentPaginationQuery'

    // DEBUG: Log ALL GraphQL requests to identify marketplace queries
    if (FB_DEBUG && (friendlyMeta.toLowerCase().includes('marketplace') || friendlyMeta.toLowerCase().includes('category') || isTarget)) {
      debug('GQL-> ALL', { friendly: friendlyMeta, isTarget, docId: docIdMeta })
    }

    // Only log marketplace-related requests to reduce noise
    if (isTarget && FB_DEBUG) {
      try { debug('GQL-> req', { friendly: friendlyMeta, docId: docIdMeta, size: body.length }) } catch {}
    }
    // Mark that we're sending a marketplace request
    if (isTarget) lastRequestWasMarketplace = true
    if (!isTarget) {
      // allow other handlers (catch-all) to process
      return route.fallback?.() ?? route.continue()
    }
    if (marketplacePatchDisabled) {
      // Skip patching for this session to avoid UI error banner
      return route.continue()
    }

    const rawVars = params.get('variables') || '{}'
    // If it's the observed category doc id, use simplified query-based patch to avoid type issues
    const docIdForPatch = params.get('doc_id') || params.get('docId') || ''

    // CRITICAL: Apply patching to ALL marketplace target requests, not just specific doc_id
    // This ensures chronological sorting is consistent across all pagination requests
    if (!marketplacePatchDisabled && isTarget) {
      if (FB_DEBUG) {
        debug(`[PATCH] Applying patchMarketplaceVars to doc_id=${docIdForPatch}`)
      }
      return await patchMarketplaceVars(route, body, (FB_DEBUG ? (...a: any[]) => debug(...a) : undefined))
    }
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

    const WANT_MAKE = (process.env.FB_FILTER_MAKE || '').toLowerCase()
    const WANT_MODEL = (process.env.FB_FILTER_MODEL || '').toLowerCase()
    const MAP_STRING_TO_ID: Record<string, string> = { honda: '308436969822020', civic: '337357940220456' }
    const makeId = WANT_MAKE ? (MAP_STRING_TO_ID[WANT_MAKE] || WANT_MAKE) : ''
    const modelId = WANT_MODEL ? (MAP_STRING_TO_ID[WANT_MODEL] || WANT_MODEL) : ''

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

// Patch Marketplace variables using simple params.query approach for specific doc
// CRITICAL: This patching is REQUIRED for chronological sorting to work!
// Counterintuitively, when we inject params.query WITH filterSortingParams.sort_by_filter=CREATION_TIME,
// Facebook honors the chronological order (value=0). Without params.query, Facebook ignores the sort
// parameter and uses relevance ranking instead (value>0).
// This was discovered by comparing la13 (working, value=0) vs la23 (broken, value>0).
async function patchMarketplaceVars(route: Route, body: string, dbg?: (...args: any[]) => void) {
  if (marketplacePatchDisabled) return route.continue({ postData: body })
  const params = new URLSearchParams(body)
  const docId = params.get('doc_id')

  // Note: We now apply patching to ALL marketplace requests, not just the specific doc_id
  // This ensures chronological sorting is consistent across pagination
  if (dbg) {
    dbg(`[PATCH] Processing doc_id=${docId}`)
  }

  let variables: any
  try { variables = JSON.parse(params.get('variables') || '{}') } catch { return route.continue({ postData: body }) }

  // Add make/model filter via params.query (only if specified - empty means "all vehicles")
  const WANT_MAKE = (process.env.FB_MAKE || '').trim()
  const WANT_MODEL = (process.env.FB_MODEL || '').trim()
  const queryParts = [WANT_MAKE, WANT_MODEL].filter(Boolean)

  variables.params = variables.params || {}
  if (queryParts.length > 0) {
    variables.params.query = queryParts.join(' ')
  } else {
    // CRITICAL: Facebook requires a REAL search query (not just a space) for chronological sorting!
    // A space character is treated as "no search" and causes relevance ranking.
    // Using a single common letter like "a" matches almost all listings while enabling chronological mode.
    // This was discovered by comparing working requests (with "Honda Civic") vs failing (with " " space).
    variables.params.query = 'a'
  }

  // CRITICAL: Also inject filterSortingParams for chronological sorting
  // Without this, Facebook ignores params.query and uses relevance ranking (value>0)
  // With both params.query AND filterSortingParams, Facebook uses chronological order (value=0)
  variables.filterSortingParams = variables.filterSortingParams || {}
  variables.filterSortingParams.sort_by_filter = 'CREATION_TIME'
  variables.filterSortingParams.sort_order = 'DESCEND'
  variables.filterSortingParams.sortBy = 'creation_time_descend'

  if (dbg) {
    const queryValue = variables.params.query
    dbg(`[PATCH] Applied: query="${queryValue}", sort_by_filter=CREATION_TIME, doc_id=${docId}`)
  }

  params.set('variables', JSON.stringify(variables))
  return await route.continue({ postData: params.toString() })
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
  extraction_source?: 'graphql' | 'graphql_replay' | 'ssr' | 'dom'
}

function isVehicleRow(r: ListingRow): boolean {
  if (r.year != null || r.mileage != null) return true
  if ((r.make || '').length || (r.model || '').length) return true
  const t = (r.title || '').toLowerCase()
  if (/(sedan|coupe|hatchback|suv|truck|van|convertible|wagon|motor|engine|awd|fwd|rwd|mileage|mi\b)/i.test(t)) return true
  return false
}

function isTargetRow(r: ListingRow): boolean {
  // If no make/model filter specified, accept ALL vehicles (like OfferUp)
  if (!TARGET_MAKE && !TARGET_MODEL) return true

  // Check exact matches first
  const makeOk = TARGET_MAKE && (r.make || '').toLowerCase() === TARGET_MAKE
  const modelOk = TARGET_MODEL && (r.model || '').toLowerCase() === TARGET_MODEL

  // If both filters are specified, require BOTH to match
  if (TARGET_MAKE && TARGET_MODEL) {
    if (makeOk && modelOk) return true
    // Fallback: check title for both make AND model
    const hay = `${r.title ?? ''} ${r.make ?? ''} ${r.model ?? ''}`.toLowerCase()
    const hasModel = new RegExp(`\\b${TARGET_MODEL.replace(/[-/\\^$*+?.()|[\]{}]/g, '')}\\b`, 'i').test(hay)
    const hasMake = new RegExp(`\\b${TARGET_MAKE.replace(/[-/\\^$*+?.()|[\]{}]/g, '')}\\b`, 'i').test(hay)
    return hasModel && hasMake
  }

  // If only one filter is specified, match that one
  if (TARGET_MAKE && makeOk) return true
  if (TARGET_MODEL && modelOk) return true

  // Fallback: check title/make/model text for single filter match
  const hay = `${r.title ?? ''} ${r.make ?? ''} ${r.model ?? ''}`.toLowerCase()
  if (TARGET_MODEL) {
    const hasModel = new RegExp(`\\b${TARGET_MODEL.replace(/[-/\\^$*+?.()|[\]{}]/g, '')}\\b`, 'i').test(hay)
    if (hasModel) return true
  }
  if (TARGET_MAKE) {
    const hasMake = new RegExp(`\\b${TARGET_MAKE.replace(/[-/\\^$*+?.()|[\]{}]/g, '')}\\b`, 'i').test(hay)
    if (hasMake) return true
  }

  return false
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
    // Keep decimal point to avoid inflating prices (27500.00 should not become 2750000)
    const m = s.replace(/[^\d.]/g, '')
    if (!m) return null
    const n = parseFloat(m)
    return Number.isFinite(n) ? Math.trunc(n) : null
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

// Very small make/model dictionary (you can expand this later)
const FB_VEHICLE_DICT: Record<string, string[]> = {
  honda: ['civic', 'accord', 'cr-v', 'crv', 'pilot', 'odyssey', 'fit'],
  toyota: ['corolla', 'camry', 'rav4', 'tacoma', 'tundra', 'prius', 'highlander'],
  nissan: ['altima', 'sentra', 'maxima', 'rogue', 'pathfinder'],
  ford: ['focus', 'fusion', 'mustang', 'escape', 'explorer', 'f150', 'f-150'],
  chevrolet: ['malibu', 'cruze', 'impala', 'equinox', 'tahoe', 'silverado', 'suburban'],
  bmw: ['320', '328', '330', '335', '528', '535', 'x3', 'x5', 'm3', 'm5'],
  mercedes: ['c300', 'e350', 'glc300', 'glk350', 's550'],
  hyundai: ['elantra', 'sonata', 'tucson', 'santa fe', 'kona', 'accent'],
  kia: ['optima', 'soul', 'sportage', 'sorento', 'forte'],
  lexus: ['is250', 'is350', 'es350', 'rx350', 'nx200t'],
  jeep: ['wrangler', 'grand cherokee', 'cherokee', 'compass'],
  subaru: ['wrx', 'forester', 'outback', 'impreza']
}

function fbParseModelFromTitle(title?: string | null): { year: number | null; make: string | null; model: string | null } {
  if (!title) return { year: null, make: null, model: null }

  let s = title.toLowerCase()
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  // Year
  let year: number | null = null
  const ym = s.match(/\b(19|20)\d{2}\b/)
  if (ym) {
    const y = parseInt(ym[0], 10)
    if (y >= 1950 && y <= 2100) year = y
  }

  // Make
  const makes = Object.keys(FB_VEHICLE_DICT)
  let make: string | null = null
  for (const mk of makes) {
    if (s.startsWith(mk + ' ') || s.includes(' ' + mk + ' ') || s.endsWith(' ' + mk) || s === mk) {
      make = mk
      break
    }
  }
  if (!make) {
    for (const mk of makes) {
      if (s.includes(mk)) { make = mk; break }
    }
  }

  // Model (prefer longest matching model for that make)
  let model: string | null = null
  const tryModels = (mk: string) => {
    const list = FB_VEHICLE_DICT[mk] || []
    let best: string | null = null
    for (const m of list) {
      if (
        s.startsWith(m + ' ') ||
        s.includes(' ' + m + ' ') ||
        s.endsWith(' ' + m) ||
        s === m
      ) {
        if (!best || m.length > best.length) best = m
      }
    }
    return best
  }

  if (make) {
    model = tryModels(make) || null
  } else {
    // dictionary-wide fallback
    for (const mk of makes) {
      const best = tryModels(mk)
      if (best) { make = mk; model = best; break }
    }
  }

  return { year, make, model }
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

  // 1b) NEW: marketplace_feed_stories (Facebook's new structure as of Nov 2025)
  try {
    const edges = body?.data?.viewer?.marketplace_feed_stories?.edges
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

  // 3) Recursively walk viewer for feed_units/marketplace_feed_stories edges/items only (avoid unrelated edges)
  const walk = (obj: any, out: any[] = []): any[] => {
    if (!obj || typeof obj !== 'object') return out
    // Only accept edges under a feed_units container (legacy)
    if ((obj as any).feed_units && Array.isArray((obj as any).feed_units?.edges) && looksLikeListingEdges((obj as any).feed_units.edges)) {
      out.push(...(obj as any).feed_units.edges)
    }
    // NEW: Also accept edges under marketplace_feed_stories container
    if ((obj as any).marketplace_feed_stories && Array.isArray((obj as any).marketplace_feed_stories?.edges) && looksLikeListingEdges((obj as any).marketplace_feed_stories.edges)) {
      out.push(...(obj as any).marketplace_feed_stories.edges)
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
    const out = walk(viewer, [])
    if (Array.isArray(out) && out.length) return out
  } catch {}

  return []
}

function countFeedUnitsDeep(data: any): number {
  let c = 0
  const visit = (x: any) => {
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach(visit); return }
    // Count legacy feed_units.edges
    if ((x as any).feed_units?.edges && Array.isArray((x as any).feed_units.edges)) {
      c += (x as any).feed_units.edges.length
    }
    // NEW: Also count marketplace_feed_stories.edges
    if ((x as any).marketplace_feed_stories?.edges && Array.isArray((x as any).marketplace_feed_stories.edges)) {
      c += (x as any).marketplace_feed_stories.edges.length
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
    // Extract mileage from multiple possible locations
    let mileageRaw =
      listing?.vehicle_odometer_data?.vehicle_mileage ??
      listing?.vehicle_odometer_data?.vehicle_mileage_text ??
      listing?.odometer_value ??
      listing?.odometer_reading?.value ?? null

    // NEW: Also check custom_sub_titles_with_rendering_flags (common in marketplace_feed_stories)
    if (!mileageRaw && Array.isArray(listing?.custom_sub_titles_with_rendering_flags)) {
      const subtitle = listing.custom_sub_titles_with_rendering_flags[0]?.subtitle
      if (subtitle && /\d+K?\s*miles?/i.test(subtitle)) {
        mileageRaw = subtitle
      }
    }
    const permalink: string | null = listing?.story_permalink || listing?.marketplace_item_permalink || null

    // Extract tracking data from node level (contains Facebook's ranking metadata)
    let trackingUrl: string | null = null
    let rankingScore: number | null = null
    let feedPosition: number | null = null

    if (node?.tracking) {
      try {
        const trackingData = typeof node.tracking === 'string'
          ? JSON.parse(node.tracking)
          : node.tracking

        // Extract ranking metadata from commerce_rank_obj
        if (trackingData?.commerce_rank_obj) {
          const rankObj = typeof trackingData.commerce_rank_obj === 'string'
            ? JSON.parse(trackingData.commerce_rank_obj)
            : trackingData.commerce_rank_obj

          rankingScore = rankObj?.value ?? null
          feedPosition = rankObj?.primary_position ?? null
        }

        // Construct full tracking URL matching Facebook's format
        const encodedTracking = encodeURIComponent(
          typeof node.tracking === 'string' ? node.tracking : JSON.stringify(node.tracking)
        )
        trackingUrl = `https://www.facebook.com/marketplace/item/${remoteId}/?ref=category_feed&referral_code=undefined&referral_story_type=listing&tracking=${encodedTracking}`

        if (FB_DEBUG && rankingScore) {
          debug(`[TRACKING] ${remoteId}: score=${rankingScore.toExponential(2)}, position=${feedPosition}`)
        }
      } catch (e) {
        if (FB_DEBUG) debug('[TRACKING] Failed to parse tracking data:', e)
      }
    }

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
    // Parse mileage with support for "K" suffix (e.g., "60K miles" → 60000)
    // Check for K suffix FIRST before parseIntSafe strips the K
    let mileage: number | null = null
    if (typeof mileageRaw === 'string' && /\d+\.?\d*\s*K/i.test(mileageRaw)) {
      const mK = mileageRaw.match(/(\d+\.?\d*)\s*K/i)
      if (mK) {
        const n = Math.round(parseFloat(mK[1]) * 1000)
        if (Number.isFinite(n)) mileage = n
      }
    }
    // Fallback to regular parsing if no K suffix found
    if (mileage == null) {
      mileage = parseIntSafe(mileageRaw)
    }
    const postedAt: string | null = listing?.creation_time ? new Date(listing.creation_time * 1000).toISOString() : (node?.creation_time ? new Date(node.creation_time * 1000).toISOString() : null)
    const city: string | null =
      listing?.location?.reverse_geocode?.city ||
      listing?.location?.city ||
      listing?.marketplace_listing_location?.reverse_geocode?.city ||
      null

    const createdSec = listing?.creation_time ?? listing?.listing_time ?? node?.creation_time ?? null
    const createdTs = createdSec ? Number(createdSec) * 1000 : (postedAt ? Date.parse(postedAt) : null)

    // Extract extraction source from metadata if available
    const extractionSource = (edge as any)?._meta?.source || undefined

    const row: ListingRow = {
      source: 'facebook',
      remote_id: remoteId,
      remote_slug: null,
      url: trackingUrl || permalink || `https://www.facebook.com/marketplace/item/${remoteId}`,
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
      extraction_source: extractionSource,
      // Note: ranking metadata (fb_ranking_score, fb_feed_position) logged in debug but not stored in DB
    }
    return row
  } catch {
    return null
  }
}

function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }

function sleep(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

// Replay saved Facebook GraphQL request with cursor pagination
async function fetchFacebookFeedFromSaved(cursor?: string | null): Promise<any | null> {
  try {
    const raw = await fs.readFile('facebook_gql_feed_req.json', 'utf8')
    const saved = JSON.parse(raw) as { url: string; method: string; headers: Record<string, string>; postData: string }

    const headers = { ...saved.headers }
    delete (headers as any)['content-length']
    delete (headers as any)['accept-encoding']

    let body: any
    try { body = JSON.parse(saved.postData || '{}') } catch { body = {} }
    let variables = body.variables || {}
    if (cursor) {
      variables.cursor = cursor
      if (variables.after === undefined) variables.after = cursor
    }
    if (variables.count) variables.count = Math.max(variables.count, 30)
    body.variables = variables

    const _fetch: any = (globalThis as any).fetch
    if (typeof _fetch !== 'function') {
      warn('[FB-REPLAY] global fetch is not available; requires Node 18+')
      return null
    }

    const resp = await _fetch(saved.url, {
      method: saved.method || 'POST',
      headers: headers as any,
      body: JSON.stringify(body),
    } as any)
    if (!(resp as any).ok) return null
    const text = await (resp as any).text()
    const cleaned = text.startsWith('for (;;);') ? text.slice('for (;;);'.length) : text
    return JSON.parse(cleaned)
  } catch (e) {
    warn('[FB-REPLAY] Failed:', (e as Error).message)
    return null
  }
}

function extractFacebookCursor(resp: any): string | null {
  try {
    const pageInfo = resp?.data?.viewer?.marketplace_feed?.page_info || resp?.data?.marketplace_search?.feed_units?.page_info
    return pageInfo?.end_cursor || pageInfo?.next_cursor || null
  } catch {
    return null
  }
}

async function extractDomListings(page: Page): Promise<ListingRow[]> {
  const nowISO = new Date().toISOString()
  // Step 1: collect link href + labels in one evaluate()
  const linkData = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
    return anchors.map((a) => {
      const el = a as HTMLAnchorElement
      return {
        href: el.getAttribute('href') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        text: (el.textContent || '').trim(),
      }
    })
  })

  const out: ListingRow[] = []
  const seen = new Set<string>()
  // Step 2: process each link individually, fetching its container text via page.evaluate()
  for (const link of linkData) {
    const m = link.href.match(/\/marketplace\/item\/(\d+)/)
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)

    const containerText = await page.evaluate((href) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]')) as Element[]
      const target = anchors.find((a) => a.getAttribute('href') === href) as HTMLElement | undefined
      if (!target) return ''
      let parent: HTMLElement | null = target.parentElement as HTMLElement | null
      let depth = 0
      while (parent && depth < 10) {
        const role = parent.getAttribute('role')
        if (role === 'article' || role === 'group') {
          const links = parent.querySelectorAll('a[href*="/marketplace/item/"]')
          if (links.length === 1) return parent.textContent || ''
        }
        parent = parent.parentElement
        depth++
        if (parent?.getAttribute('role') === 'main') break
      }
      return (target.parentElement && target.parentElement.textContent) || ''
    }, link.href)

    let price: number | null = null
    let year: number | null = null
    let mileage: number | null = null
    let city: string | null = null

    if (containerText) {
      // --- Year: 1950–2030 from the card text ---
      const ym = containerText.match(/\b(19[5-9]\d|20[0-3]\d)\b/)
      if (ym) {
        const y = parseInt(ym[1], 10)
        if (y >= 1950 && y <= 2030) year = y
      }

      // --- Price: allow "3000" or "3,000" ---
      const pm = containerText.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)/)
      if (pm) {
        const n = parseInt(pm[1].replace(/,/g, ''), 10)
        if (Number.isFinite(n) && n >= 500 && n <= 999999) {
          price = n
        }
      }

      // --- Mileage: support "123,456 miles" and "37K miles" ---
      const mm = containerText.match(/([0-9]{1,3}(?:,[0-9]{3})*|[0-9]{1,3}\s*[kK])\s*(?:mi|miles)\b/i)
      if (mm) {
        let raw = mm[1].replace(/,/g, '').trim()
        let mv: number | null = null
        if (/k$/i.test(raw)) {
          raw = raw.replace(/[kK]$/, '')
          const base = parseInt(raw, 10)
          if (Number.isFinite(base)) mv = base * 1000
        } else {
          const base = parseInt(raw, 10)
          if (Number.isFinite(base)) mv = base
        }
        if (mv != null && mv >= 1 && mv <= 500000) mileage = mv
      }

      // --- City: "Simi Valley, CA", "El Monte, CA", etc ---
      // Look for a capitalized city with a 2-letter state.
      const cm = containerText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})/)
      if (cm) {
        city = cm[1].trim()
      }
    }

    let cleanTitle = link.ariaLabel || link.text || null
    if (cleanTitle) {
      cleanTitle = cleanTitle
        .replace(/\$\s*[0-9.,]+/g, '')
        .replace(/[0-9]{1,3}(?:,[0-9]{3})*\s*(?:mi|miles)\b/gi, '')
        .replace(/[0-9]{1,3}\s*[kK]\s*(?:mi|miles)\b/gi, '')
        .replace(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    }

    // Infer year/make/model from the cleaned title
    const parsed = fbParseModelFromTitle(cleanTitle || link.ariaLabel || link.text || null)
    const finalYear = year ?? parsed.year
    const finalMake = parsed.make ? parsed.make.toLowerCase() : null
    const finalModel = parsed.model ? parsed.model.toLowerCase() : null

    out.push({
      source: 'facebook',
      remote_id: id,
      remote_slug: null,
      url: link.href.startsWith('http') ? link.href : `https://www.facebook.com${link.href}`,
      title: cleanTitle,
      price,
      year: finalYear,
      make: finalMake,
      model: finalModel,
      mileage,
      city,
      posted_at: null,
      first_seen_at: nowISO,
      extraction_source: 'dom',
    })
  }

  return out
}

// Enrich FB listings with year/mileage by visiting the detail page
async function enrichFacebookDetails(context: BrowserContext, rows: ListingRow[]): Promise<ListingRow[]> {
  const enriched: ListingRow[] = []
  const queue = [...rows]
  const concurrency = Math.max(1, Math.min(3, parseInt(process.env.FB_DETAIL_CONCURRENCY || '2', 10) || 2))

  async function work() {
    while (queue.length) {
      const row = queue.shift()!
      let page: Page | null = null
      try {
        page = await context.newPage()
        await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
        await page.waitForTimeout(randInt(250, 650))

        // Grab main text once
        const mainText =
          (await page.textContent('main').catch(() => null)) ||
          (await page.textContent('body').catch(() => null)) ||
          ''

        let year = row.year
        let mileage = row.mileage
        let posted_at = row.posted_at

        // --- YEAR enrichment ---
        if (year == null) {
          // 1) Prefer year parsed from structured detail title
          const detailTitle =
            (await page.textContent('main h1[dir="auto"]').catch(() => null)) ||
            (await page.textContent('main h1').catch(() => null)) ||
            (await page.textContent('h1[dir="auto"]').catch(() => null)) ||
            (await page.textContent('h1').catch(() => null)) ||
            null

          if (detailTitle) {
            const parsedFromTitle = fbParseModelFromTitle(detailTitle)
            if (parsedFromTitle.year != null) {
              year = parsedFromTitle.year
            }
          }

          // 2) Fallback: use heuristic over main text
          if (year == null && mainText) {
            const best = pickBestYearFromText(mainText, row.make, row.model, FB_MIN_DETAIL_YEAR)
            if (best != null) year = best
          }
        }

        // --- Mileage: "123,456 miles" or "37K miles" anywhere in main text ---
        if (mileage == null) {
          const mm = mainText.match(/([0-9]{1,3}(?:,[0-9]{3})*|[0-9]{1,3}\s*[kK])\s*(?:mi|miles)\b/i)
          if (mm) {
            let raw = mm[1].replace(/,/g, '').trim()
            let mv: number | null = null
            if (/k$/i.test(raw)) {
              raw = raw.replace(/[kK]$/, '')
              const base = parseInt(raw, 10)
              if (Number.isFinite(base)) mv = base * 1000
            } else {
              const base = parseInt(raw, 10)
              if (Number.isFinite(base)) mv = base
            }
            if (mv != null && mv >= 1 && mv <= 1_000_000) {
              mileage = mv
            }
          }
        }

        // --- POSTED_AT enrichment ---
        if (!posted_at && mainText) {
          const { timestamp, source } = extractFacebookPostedAt(mainText)
          if (timestamp) {
            posted_at = timestamp
            if (FB_DEBUG) {
              debug('[FB-DETAIL] posted_at extracted', { id: row.remote_id, posted_at, source })
            }
          }
        }

        // Don't filter during enrichment - just enrich all rows
        // Filtering will happen AFTER all enrichment is complete
        enriched.push({
          ...row,
          year,
          mileage,
          posted_at,
        })
      } catch (e) {
        warn('[FB-DETAIL] failed for row', row.remote_id, (e as Error).message)
        enriched.push(row) // keep original if detail fails
      } finally {
        try { await page?.close() } catch {}
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) workers.push(work())
  await Promise.all(workers)

  return enriched
}

async function interceptFacebookGraphQL(sessionId?: string): Promise<ListingRow[]> {
  let browser: Browser | null = null
  lastLoginWallDetected = false
  const collected: RawGQLEdge[] = []
  const matched: ListingRow[] = []
  const matchedIds = new Set<string>()
  let uninstallGql: null | (() => Promise<void>) = null
  // Debug file write throttles (per run)
  let wroteGraphqlRespDump = false
  let ssrBboxDumpCount = 0

  // Set run-specific directory for organized logging
  const runId = sessionId || `run_${Date.now()}`
  RUN_DIR = path.join(DEBUG_DIR, runId)
  const runStartTime = Date.now()
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
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

        // Log cookie validation for debugging auth failures
        const cookieValidation = {
          timestamp: new Date().toISOString(),
          sessionId: sessionId || 'unknown',
          source: 'storageState',
          validation: {
            hasCUser,
            hasXS,
            totalCookies: ck.length,
            cookieNames: ck.map(c => c.name).sort(),
          }
        }
        // Always log when XS missing (auth likely to fail) or when in debug mode
        if (!hasXS || FB_DEBUG) {
          await writeDebugFile(`cookie_check_${Date.now()}.json`, JSON.stringify(cookieValidation, null, 2))
        }
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

            // Log cookie validation for debugging auth failures
            const cookieValidation = {
              timestamp: new Date().toISOString(),
              sessionId: sessionId || 'unknown',
              source: FB_USE_STORAGE_STATE ? 'storageState' : 'cookies_json',
              validation: {
                hasCUser,
                hasXS,
                totalCookies: ck.length,
                cookieNames: ck.map(c => c.name).sort(),
              }
            }
            // Always log when XS missing (auth likely to fail) or when in debug mode
            if (!hasXS || FB_DEBUG) {
              await writeDebugFile(`cookie_check_${Date.now()}.json`, JSON.stringify(cookieValidation, null, 2))
            }
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
        // Console file logging disabled - creates too much noise (142+ files of proxy/blocking errors)
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
        else if (body?.data?.viewer?.marketplace_feed_stories) feedType = 'marketplace_feed_stories'
        else if (body?.data?.modularFeed) feedType = 'modularFeed'
        const edges = extractEdgesFromBody(body)
        totalEdges += Array.isArray(edges) ? edges.length : 0
        if (edges?.length) {
          // Check for relevance ranking (non-zero values indicate relevance mode, not chronological)
          if (FB_DEBUG) {
            try {
              const firstEdge = edges[0]
              const tracking = firstEdge?.node?.tracking
              if (tracking) {
                const trackingObj = typeof tracking === 'string' ? JSON.parse(tracking) : tracking
                const rankObjStr = trackingObj?.commerce_rank_obj
                if (rankObjStr) {
                  const rankObj = typeof rankObjStr === 'string' ? JSON.parse(rankObjStr) : rankObjStr
                  const rankValue = rankObj?.value
                  if (rankValue !== undefined && rankValue !== 0) {
                    warn(`[RANKING] Facebook using RELEVANCE ranking (value=${rankValue.toExponential(2)}). Results may not be chronological!`)
                    warn(`[RANKING] For chronological results, ensure params.query is set in GraphQL request`)
                  } else if (rankValue === 0) {
                    debug(`[RANKING] Facebook using CHRONOLOGICAL sorting (value=0) - correct mode!`)
                  }
                }
              }
            } catch {}
          }

          // Tag edges with extraction source for tracking
          const taggedEdges = edges.map(e => ({
            ...e,
            _meta: {
              source: 'graphql' as const,
              timestamp: Date.now(),
              responseNum: metrics.graphqlResponses,
            }
          }))
          collected.push(...taggedEdges)
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
      // Per-request response debug retained for FB_DEBUG only via debug(); summary logged later
      debug('GQL<-', { status, url, dataKeys, feedType, edges: totalEdges, feedUnitsDeep })

      // Capture the first successful pagination request for replay
      try {
        if (totalEdges > 0) {
          const exists = await fs.access('facebook_gql_feed_req.json').then(() => true).catch(() => false)
          if (!exists) {
            const req = resp.request()
            const rawHeaders = req.headers() || {}
            const captured = {
              url: req.url(),
              method: req.method(),
              headers: rawHeaders, // keep cookies for reliable replay
              postData: req.postData() || '',
            }
            await fs.writeFile('facebook_gql_feed_req.json', JSON.stringify(captured, null, 2))
            info('[GQL-CAPTURE] Saved request to facebook_gql_feed_req.json')
          }
        }
      } catch (e) {
        warn('[GQL-CAPTURE] Failed to save request:', (e as Error).message)
      }

      // Dump only the first response per run when raw capture is enabled AND it contains actual listing data
      // TEMPORARILY: Also dump first marketplace response even with 0 edges for debugging
      // Capture if this response follows a marketplace request we sent
      const isMarketplaceResponse = lastRequestWasMarketplace && dataKeys.includes('viewer')
      if (!wroteGraphqlRespDump && FB_CAPTURE_RAW && isMarketplaceResponse) {
        const out = parsedPayloads.length === 1 ? parsedPayloads[0] : parsedPayloads
        await writeDebugFile(`graphql_resp_marketplace_${Date.now()}_${metrics.graphqlResponses}.json`, JSON.stringify(out, null, 2), { redacted: true })
        wroteGraphqlRespDump = true
        lastRequestWasMarketplace = false  // Reset flag
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
      // Navigate to category URL with sortBy parameter for proper time sorting
      // CRITICAL: The sortBy=creation_time_descend URL parameter ONLY works when COMBINED with
      // params.query in the GraphQL request (set by patchMarketplaceVars function).
      // Without params.query, Facebook ignores sortBy and uses relevance ranking instead.
      // This counterintuitive behavior was discovered by comparing la13 (working) vs la23 (broken).
      // Note: daysSinceListed URL parameter doesn't work - Facebook ignores it
      // We rely on sortBy=creation_time_descend + params.query injection for chronological results

      const categoryUrl = `https://www.facebook.com/marketplace/category/vehicles?sortBy=creation_time_descend&exact=false`
      info(`[FB] Navigating to category URL: ${categoryUrl}`)
      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch (e) {
      warn('Nav failed', (e as Error).message)
      // Return empty to let the controller rotate session/proxy without crashing
      return []
    }
    await page.waitForTimeout(randInt(250, 1250))
    info('Page loaded:', await page.url())

    // Diagnostic: Check if UI dropdown shows chronological sorting or still shows "Suggested"
    if (FB_DEBUG) {
      try {
        await page.waitForTimeout(1000) // Give UI time to render

        // Try multiple selectors to find the sort dropdown
        const dropdownSelectors = [
          '[aria-label*="Sort"]',
          '[data-testid*="sort"]',
          'span:has-text("Sort by")',
          'span:has-text("Suggested")',
          'span:has-text("Date listed")',
          'div[role="button"]:has-text("Sort")',
          'div[role="button"]:has-text("Suggested")'
        ]

        let dropdownState: any = { found: false, selectors: [] }

        for (const selector of dropdownSelectors) {
          try {
            const element = await page.$(selector)
            if (element) {
              const text = await element.textContent()
              const ariaLabel = await element.getAttribute('aria-label')
              dropdownState.selectors.push({
                selector,
                text: text?.trim(),
                ariaLabel
              })
              dropdownState.found = true
            }
          } catch {}
        }

        // Also check all text on page containing "Sort" or "Suggested"
        const allSortText = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('*'))
          return elements
            .map(el => el.textContent?.trim())
            .filter(text => text && (text.includes('Sort') || text.includes('Suggested') || text.includes('Date listed')))
            .filter((text, i, arr) => arr.indexOf(text) === i) // unique
            .slice(0, 20) // limit
        })
        dropdownState.allSortText = allSortText

        // Take screenshot for visual confirmation
        const screenshotPath = path.join(DEBUG_DIR, 'ui_after_navigation.png')
        await page.screenshot({ path: screenshotPath, fullPage: false })

        // Save state to JSON
        const statePath = path.join(DEBUG_DIR, 'ui_sort_state.json')
        await fs.writeFile(statePath, JSON.stringify(dropdownState, null, 2))

        info(`[UI-CHECK] Dropdown state saved to ${statePath}`)
        info(`[UI-CHECK] Screenshot saved to ${screenshotPath}`)
        if (dropdownState.found) {
          info(`[UI-CHECK] Found ${dropdownState.selectors.length} sort-related elements`)
          dropdownState.selectors.forEach((s: any) => {
            info(`[UI-CHECK]   - "${s.selector}": text="${s.text}", aria="${s.ariaLabel}"`)
          })
        } else {
          warn('[UI-CHECK] No sort dropdown found with standard selectors')
        }
      } catch (e) {
        warn('[UI-CHECK] Failed to check dropdown state:', (e as Error).message)
      }
    }

    // Check login wall after navigation; try a single dismiss
    if (await isLoginWallVisible(page)) {
      console.warn('[FB:WARN] Login wall or limited view detected.')
      if (!(await dismissLoginWall(page))) {
        lastLoginWallDetected = true
        return []
      }
    }
    // If we have a saved request, use replay pattern (faster, no scrolls)
    const savedReqExists = await fs.access('facebook_gql_feed_req.json').then(() => true).catch(() => false)
    const collectedBeforeReplay = collected.length
    if (savedReqExists) {
      info('[FB-REPLAY] Using saved request for pagination')
      let cursor: string | null = null
      let pages = 0
      const maxPages = Math.min(SCROLL_PAGES, 10)
      while (pages < maxPages && collected.length < MAX_ITEMS) {
        const r = await fetchFacebookFeedFromSaved(cursor)
        if (!r) break
        const edges = extractEdgesFromBody(r)
        if (!edges.length) break
        // Tag edges with extraction source for tracking
        const taggedEdges = edges.map(e => ({
          ...e,
          _meta: {
            source: 'graphql_replay' as const,
            timestamp: Date.now(),
            page: pages + 1,
          }
        }))
        collected.push(...taggedEdges)
        info(`[FB-REPLAY] Page ${pages + 1}: got ${edges.length} edges, total: ${collected.length}`)
        cursor = extractFacebookCursor(r)
        if (!cursor) break
        pages++
        await sleep(randInt(1000, 2000))
      }
    }

    // Fallback to scrolling if replay failed or didn't exist
    if (collected.length === collectedBeforeReplay) {
      if (savedReqExists) {
        warn('[FB-REPLAY] Replay failed to collect edges, falling back to scroll method')
      } else {
        info('[FB] No saved request, using scroll method')
      }

      // Execute scrolling regardless of whether replay existed or not
      // Initial small human-like mouse movement
      try {
        await page.mouse.move(randInt(100, 400), randInt(100, 300))
        await page.waitForTimeout(randInt(150, 400))
        await page.mouse.move(randInt(500, 900), randInt(200, 600))
      } catch {}
      for (let i = 0; i < SCROLL_PAGES; i++) {
        await smartScroll(page)
        await page.waitForTimeout(randInt(SCROLL_MIN_MS, SCROLL_MAX_MS))

        const stats = await page.evaluate(() => ({ h: document.body.scrollHeight, inner: window.innerHeight }))
        debug(`Scroll ${i + 1}/${SCROLL_PAGES}`, { bodyH: stats.h, innerH: stats.inner, collected: collected.length })

        if (i === Math.floor(SCROLL_PAGES / 2) && collected.length === 0) {
          warn('Mid-run: still 0 edges collected; possible auth/visibility restriction or API change.')
        }
        if (Math.random() < 0.25) {
          await page.evaluate(() => window.scrollBy(0, -Math.floor(window.innerHeight * 0.3)))
          await page.waitForTimeout(randInt(350, 900))
        }
        if (!loginWallCaptured && (i === 0 || i % 3 === 0)) {
          try {
            if (await isLoginWallVisible(page)) {
              warn('Login wall or limited view detected (mid-scroll).')
              await writeDebugFile('login_wall_mid.html', await page.content(), { redacted: true })
              try { await page.screenshot({ path: path.join(RUN_DIR, 'login_wall_mid.png'), fullPage: true }) } catch {}
              loginWallCaptured = true
            }
          } catch {}
        }
        // Early stop match counter
        try {
          const tmpRows = (() => {
            const raw = collected.map(normalizeEdge).filter(Boolean) as ListingRow[]
            const seenTmp = new Set<string>()
            return raw.filter(r => (seenTmp.has(r.remote_id) ? false : (seenTmp.add(r.remote_id), true)))
          })()
          const targetBatch: ListingRow[] = []
          for (const r of tmpRows) {
            if (isTargetRow(r) && !matchedIds.has(r.remote_id)) {
              matched.push(r)
              matchedIds.add(r.remote_id)
              targetBatch.push(r)
              // Changed: Collect up to COLLECTION_LIMIT (not TARGET_LIMIT) to ensure we get newest listings
              if (matched.length >= COLLECTION_LIMIT) break
            }
          }
          if (targetBatch.length) pushRows(targetBatch)
          debug('Target match count', { matchCount: matched.length, collectionLimit: COLLECTION_LIMIT })
          // Changed: Stop when we hit COLLECTION_LIMIT (we'll sort and filter to TARGET_LIMIT later)
          if (top.length >= TARGET.limit || matched.length >= COLLECTION_LIMIT) {
            info(`[FB] Reached ${COLLECTION_LIMIT} collected rows; stopping to sort by timestamp.`)
            break
          }
        } catch {}
        if (collected.length >= MAX_ITEMS) break
      }
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
                // Limit SSR bbox dumps to first 3 when raw capture is enabled, and only if >10KB (contains real listing data)
                const jsonStr = JSON.stringify(parsed, null, 2)
                if (ssrBboxDumpCount < 3 && FB_CAPTURE_RAW && jsonStr.length > 10000) {
                  ssrBboxDumpCount++
                  await writeDebugFile(`ssr_bbox_${Date.now()}_${ssrBboxDumpCount}.json`, jsonStr, { redacted: true })
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
          // Tag edges with extraction source for tracking
          const taggedEdges = edgesFallback.map((e) => ({
            node: e?.node || e,
            _meta: {
              source: 'ssr' as const,
              timestamp: Date.now(),
              bboxCount: bboxFound,
            }
          }))
          collected.push(...taggedEdges)
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
        try {
          const buf = await page.screenshot({ fullPage: true })
          if (buf) await writeDebugFile('last.png', buf as any)
        } catch {}
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
          extraction_source: 'dom',
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

    // Compact GQL interception summary
    debug('GQL summary', { requests: metrics.graphqlRequests, edges: metrics.graphqlEdges })

    // Apply a vehicle gate to drop obvious non-vehicle noise
    let finalRows: ListingRow[] = dedup.filter(isVehicleRow)
    if (!finalRows.length) {
      warn('No rows from GraphQL/SSR; attempting DOM fallback...')
      const domRows = await extractDomListings(page)
      if (domRows.length) {
        info('DOM fallback recovered', { count: domRows.length })
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

    // ==================================================================================
    // FILTERING STRATEGY (Hybrid Approach for Performance):
    // 1. Apply "cheap" filters on DOM data BEFORE enrichment:
    //    - Make/model matching (from title parsing)
    //    - Basic price filtering (if needed)
    //    → This reduces candidates from ~30 to ~5, saving detail page visits
    // 
    // 2. Enrich remaining candidates (visit detail pages for year/mileage/posted_at)
    // 
    // 3. Apply "expensive" filters AFTER enrichment:
    //    - Timestamp filtering (posted_within_hours) - see lines ~1688-1705
    //    - Mileage range filtering (if needed in future)
    //    → This ensures we have accurate data before final filtering
    // ==================================================================================

    // Sort and limit BEFORE enrichment to avoid enriching too many rows
    finalRows.sort(sortByFreshestDesc)
    const limited = finalRows.slice(0, Math.min(MAX_ITEMS, TARGET_LIMIT))

    // OPTIONAL: only enrich if we actually care about year/mileage (we do, for KNN)
    const doDetailEnrich = (process.env.FB_DETAIL_ENRICH ?? '1') !== '0'
    let resultRows = limited

    if (doDetailEnrich && limited.length > 0) {
      info('[FB-DETAIL] Enriching detail for rows', { count: limited.length })
      resultRows = await enrichFacebookDetails(context, limited)
      const enrichedRowsWithYear = resultRows.filter(r => r.year != null).length
      const enrichedRowsWithMileage = resultRows.filter(r => r.mileage != null).length
      info('[FB-DETAIL] Enrichment stats', { rows: resultRows.length, withYear: enrichedRowsWithYear, withMileage: enrichedRowsWithMileage })
    }

    // NOW apply target filter AFTER enrichment (so detail pages can fill in missing make/model)
    const hasTargetFilter =
      (process.env.FB_MAKE && process.env.FB_MAKE.trim().length > 0) ||
      (process.env.FB_MODEL && process.env.FB_MODEL.trim().length > 0)

    try {
      const beforeFilterCount = resultRows.length
      const filtered = resultRows.filter(isTargetRow)

      if (hasTargetFilter) {
        // If user asked for a specific make/model, ALWAYS enforce it,
        // even if that means returning 0 rows.
        info('[FB] Applying client-side filter:', { make: TARGET_MAKE, model: TARGET_MODEL, before: beforeFilterCount, after: filtered.length })
        resultRows = filtered
      } else if (filtered.length) {
        // If no explicit target filter, you MAY still use filtered as a soft preference
        resultRows = filtered
      }
    } catch {}

    // CRITICAL: Sort by timestamp and limit to TARGET_LIMIT to get the MOST RECENT listings
    // We collected more than needed (COLLECTION_LIMIT) to ensure we capture the newest posts
    const beforeSortCount = resultRows.length
    if (resultRows.length > TARGET_LIMIT) {
      // Sort by posted_at descending (newest first)
      // Listings without timestamps go to the end
      resultRows.sort((a, b) => {
        const aTime = a.posted_at ? new Date(a.posted_at).getTime() : 0
        const bTime = b.posted_at ? new Date(b.posted_at).getTime() : 0
        return bTime - aTime  // Descending (newest first)
      })

      // Take only the top TARGET_LIMIT newest listings
      const sorted = resultRows.slice(0, TARGET_LIMIT)

      if (FB_DEBUG) {
        const oldestInResult = sorted[sorted.length - 1]?.posted_at
        const newestInResult = sorted[0]?.posted_at
        const droppedOldest = resultRows[TARGET_LIMIT]?.posted_at
        info('[SORT] Sorted by timestamp and limited to newest listings', {
          collected: beforeSortCount,
          targetLimit: TARGET_LIMIT,
          kept: sorted.length,
          dropped: beforeSortCount - sorted.length,
          newestKept: newestInResult,
          oldestKept: oldestInResult,
          oldestDropped: droppedOldest
        })
      }

      resultRows = sorted
    }

    // Final summary for this run
    const finalWithYear = resultRows.filter(r => r.year != null).length
    const finalWithMileage = resultRows.filter(r => r.mileage != null).length
    info('Capture summary', {
      graphqlRequests: metrics.graphqlRequests,
      collectedEdges: metrics.graphqlEdges,
      ssrEdges: metrics.ssrEdges,
      domCandidates: metrics.domCandidates,
      finalRows: resultRows.length,
      withYear: finalWithYear,
      withMileage: finalWithMileage,
      detailEnriched: doDetailEnrich ? limited.length : 0,
    })

    // Enhanced zero-results diagnostic for debugging
    if (resultRows.length === 0 || metrics.graphqlEdges === 0) {
      let currentUrl = 'unknown'
      try {
        currentUrl = await page.url()
      } catch {}

      const diagnostic = {
        timestamp: new Date().toISOString(),
        sessionId: sessionId || 'unknown',
        url: currentUrl,

        metrics: {
          graphqlRequests: metrics.graphqlRequests,
          graphqlResponses: metrics.graphqlResponses,
          graphqlEdges: metrics.graphqlEdges,
          ssrEdges: metrics.ssrEdges,
          domCandidates: metrics.domCandidates,
        },

        processing: {
          normalized: metrics.normalized,
          deduped: metrics.deduped,
          vehicleFiltered: dedup.filter(isVehicleRow).length,
          targetFiltered: dedup.filter(isVehicleRow).filter(isTargetRow).length,
        },

        filters: {
          make: TARGET_MAKE,
          model: TARGET_MODEL,
          limit: TARGET_LIMIT,
        },

        auth: {
          loginWallDetected: lastLoginWallDetected,
          cookiesPath: FB_COOKIES_PATH,
        },

        diagnosis: metrics.graphqlRequests === 0
          ? 'No GraphQL requests sent (interception failed or page not loaded)'
          : metrics.graphqlEdges === 0
          ? 'GraphQL requests sent but no edges returned (auth issue or empty category)'
          : metrics.deduped === 0
          ? 'Edges extracted but normalization failed (schema change)'
          : 'Rows extracted but filtered out (target mismatch)',
      }

      await writeDebugFile(`zero_results_${Date.now()}.json`, JSON.stringify(diagnostic, null, 2))
    }

    // Create comprehensive run summary
    const runSummary = {
      runId: runId,
      timestamp: new Date().toISOString(),
      duration: Date.now() - runStartTime,

      // Extraction metrics
      extraction: {
        graphqlRequests: metrics.graphqlRequests,
        graphqlResponses: metrics.graphqlResponses,
        graphqlEdges: metrics.graphqlEdges,
        ssrEdges: metrics.ssrEdges,
        domCandidates: metrics.domCandidates,
        primarySource: metrics.graphqlEdges > 0 ? 'graphql' : (metrics.ssrEdges > 0 ? 'ssr' : 'dom'),
      },

      // Processing metrics
      processing: {
        normalized: metrics.normalized,
        deduped: metrics.deduped,
        filtered: resultRows.length,
        enriched: doDetailEnrich ? limited.length : 0,
      },

      // Quality metrics
      quality: {
        withYear: finalWithYear,
        withMileage: finalWithMileage,
        withPostedAt: resultRows.filter(r => r.posted_at != null).length,
      },

      // Extraction source breakdown
      extractionSources: {
        graphql: resultRows.filter(r => r.extraction_source === 'graphql').length,
        graphql_replay: resultRows.filter(r => r.extraction_source === 'graphql_replay').length,
        ssr: resultRows.filter(r => r.extraction_source === 'ssr').length,
        dom: resultRows.filter(r => r.extraction_source === 'dom').length,
      },

      // Auth status
      auth: {
        cookiesSource: FB_USE_STORAGE_STATE ? 'storageState' : (FB_COOKIES_PATH ? 'cookies_json' : 'none'),
        loginWallDetected: lastLoginWallDetected,
      },

      // Patching status
      patching: {
        attempted: marketplacePatchTried,
        disabled: marketplacePatchDisabled,
      },

      // Results
      success: resultRows.length >= FB_MIN_ROWS_SUCCESS,
      status: resultRows.length >= FB_MIN_ROWS_SUCCESS ? 'SUCCESS' : 'FAILURE',
      failureReason: resultRows.length < FB_MIN_ROWS_SUCCESS
        ? (lastLoginWallDetected ? 'LOGIN_WALL'
           : metrics.graphqlEdges === 0 ? 'NO_DATA_EXTRACTED'
           : 'FILTERED_OUT')
        : null,
      finalCount: resultRows.length,
    }

    await writeDebugFile(`run_summary.json`, JSON.stringify(runSummary, null, 2), { redacted: true })
    info('[RUN-SUMMARY]', runSummary)

    return resultRows
  } finally {
    try { await uninstallGql?.() } catch {}
    try { await browser?.close() } catch {}
  }
}

async function upsertListings(rows: ListingRow[]) {
  if (!rows.length) return { inserted: 0, skipped: 0 }
  // Remove fields not in database schema
  const cleaned = rows.map(({ extraction_source, created_at_ts, ...rest }) => rest)
  const batched = [] as any[][]
  for (let i = 0; i < cleaned.length; i += 50) batched.push(cleaned.slice(i, i + 50))
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
  
  // ==================================================================================
  // TIMESTAMP FILTERING (After Enrichment):
  // This filter is applied AFTER enrichment because:
  // 1. DOM data rarely includes posted_at timestamps
  // 2. Detail pages are the only reliable source for posted_at
  // 3. We need accurate timestamps before filtering by recency
  // 
  // This matches OfferUp's approach (see offerup.ts lines 1479-1486)
  // ==================================================================================
  let filteredRows = allRows
  if (FB_FILTER_POSTED_WITHIN_HOURS != null && allRows.length > 0) {
    const cutoff = Date.now() - FB_FILTER_POSTED_WITHIN_HOURS * 3_600_000
    const before = filteredRows.length
    const withTimestamps = filteredRows.filter(r => r.posted_at).length
    filteredRows = filteredRows.filter(r => {
      // Allow rows without timestamps (GraphQL may not include creation_time)
      if (!r.posted_at) return true
      const ts = new Date(r.posted_at).getTime()
      if (!Number.isFinite(ts)) return true  // Invalid timestamp = allow
      return ts >= cutoff  // Filter out old listings
    })
    const after = filteredRows.length
    if (FB_DEBUG) {
      console.log(`[FB] Timestamp filter: ${before} rows -> ${after} rows (within ${FB_FILTER_POSTED_WITHIN_HOURS}h, ${withTimestamps} had timestamps)`)
    }
  }
  
  const res = await upsertListings(filteredRows)
  console.log(JSON.stringify({ ok: true, source: 'facebook', inserted: res.inserted, skipped: res.skipped }))
}

// CLI
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => { console.error('[FB] Failed:', e); process.exit(1) })
}