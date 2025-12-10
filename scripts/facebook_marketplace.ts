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

// FB_MODE: Switch between different scraping strategies
// "graphql"     -> existing behavior (interceptFacebookGraphQL)
// "dom_chrono"  -> new DOM-based chronological mode (no GraphQL, pure DOM scraping)
const FB_MODE = (process.env.FB_MODE || 'graphql').toLowerCase()

// Run-specific directory (will be set per session)
let RUN_DIR = DEBUG_DIR

// Coordinates for distance-based filtering (used in dom_chrono mode)
const OU_LAT = Number(process.env.FB_LAT || 34.052235)    // Los Angeles default
const OU_LNG = Number(process.env.FB_LNG || -118.243683)

// Multi-region configuration
const FB_MULTI_REGION = (process.env.FB_MULTI_REGION ?? '0') === '1'
const FB_REGION_COUNT = parseInt(process.env.FB_REGION_COUNT || '5', 10)
const FB_REGION_DELAY_MS = parseInt(process.env.FB_REGION_DELAY_MS || '10000', 10)

// Southern California regions for multi-region scraping
const SOCAL_REGIONS = [
  { name: 'Los Angeles, CA', lat: 34.0522, lng: -118.2437 },
  { name: 'Irvine, CA', lat: 33.6846, lng: -117.8265 },
  { name: 'Anaheim, CA', lat: 33.8366, lng: -117.9143 },
  { name: 'Long Beach, CA', lat: 33.7701, lng: -118.1937 },
  { name: 'Santa Ana, CA', lat: 33.7455, lng: -117.8677 },
  { name: 'Riverside, CA', lat: 33.9533, lng: -117.3962 },
  { name: 'San Bernardino, CA', lat: 34.1083, lng: -117.2898 },
  { name: 'Pasadena, CA', lat: 34.1478, lng: -118.1445 },
  { name: 'Torrance, CA', lat: 33.8358, lng: -118.3406 },
  { name: 'Corona, CA', lat: 33.8753, lng: -117.5664 },
]

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
// Vehicle taxonomy IDs for URL-based filtering
const HONDA_MAKE_ID  = '308436969822020'
const CIVIC_MODEL_ID = '337357940220456'

// Map of common makes to their taxonomy IDs (expand as needed)
const MAKE_TAXONOMY_IDS: Record<string, string> = {
  'honda': '308436969822020',
  'toyota': '367518776669188',
  'ford': '324686107884963',
  'chevrolet': '372854749449175',
  'nissan': '516372908427305',
}

// Map of common models to their taxonomy IDs (expand as needed)
const MODEL_TAXONOMY_IDS: Record<string, string> = {
  'civic': '337357940220456',
  'accord': '402894793124461',
  'camry': '457606364278619',
  'corolla': '383286738417507',
}

// Target filter & count (doc_id variables alignment)
const TARGET = {
  limit: TARGET_LIMIT,  // Use TARGET_LIMIT from env (FB_LIMIT)
  vehicleType: 'car_truck',
  sortBy: 'creation_time_descend' as const,
}

// ============================================================================
// [FUZZY-SEARCH] Vehicle Dictionary & Title Parsing (from OfferUp)
// Used for client-side HARD FILTER after fuzzy search collection
// ============================================================================
const FB_VEHICLE_DICTIONARY: { makes: Record<string, string[]> } = {
  makes: {
    "acura": ["rsx","tl","tsx","ilx","rl","mdx","rdx","tlx"],
    "audi": ["a3","a4","a5","a6","a7","a8","q3","q5","q7","tt","s4","s5"],
    "bmw": ["320","328","330","335","528","535","740","x1","x3","x5","m3","m5"],
    "cadillac": ["cts","ats","xt5","escalade","srx"],
    "chevrolet": ["camaro","malibu","impala","cruze","equinox","tahoe","silverado","trailblazer"],
    "chrysler": ["200","300","pacifica","town and country"],
    "dodge": ["charger","challenger","dart","durango","journey","ram"],
    "ford": ["focus","fusion","mustang","escape","explorer","f150","fiesta","edge","ranger"],
    "gmc": ["terrain","acadia","yukon","sierra"],
    "honda": ["civic","accord","cr-v","crv","fit","pilot","odyssey","crosstour"],
    "hyundai": ["elantra","sonata","tucson","accent","veloster","santa fe","kona","venue"],
    "infiniti": ["g35","g37","qx60","qx80","q50","q60"],
    "jeep": ["wrangler","grand cherokee","cherokee","compass","patriot","renegade"],
    "kia": ["optima","soul","sportage","sorento","forte","rio","stinger"],
    "lexus": ["es350","is250","is350","gs350","rx350","nx200t"],
    "mazda": ["mazda3","mazda6","cx-5","cx5","cx-9","cx9"],
    "mercedes": ["c300","e350","glc300","glk350","s550"],
    "nissan": ["altima","sentra","maxima","rogue","pathfinder","versa","murano"],
    "subaru": ["wrx","forester","outback","impreza","legacy"],
    "toyota": ["camry","corolla","rav4","tundra","tacoma","prius","highlander","avalon","sequoia"],
    "volkswagen": ["jetta","golf","passat","tiguan","beetle"],
    "volvo": ["s60","xc60","xc90"],
    "ram": ["1500","2500","3500"],
    "tesla": ["model s","model 3","model x","model y"],
    "mitsubishi": ["lancer","outlander","mirage"],
    "buick": ["encore","enclave","lacrosse"],
    "pontiac": ["g6","g8","vibe"],
    "lincoln": ["mkz","mkx","navigator"],
    "porsche": ["cayenne","macan","911"],
    "jaguar": ["xf","xe","f-type"],
    "mini": ["cooper","countryman"]
  }
}

// [FUZZY-SEARCH] Parse make/model/year from listing title (OfferUp-style)
function parseListingTitle(title?: string | null): { year: number | null; make: string | null; model: string | null } {
  if (!title) return { year: null, make: null, model: null }
  let s = title.toLowerCase()
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  // Extract year
  let year: number | null = null
  const ym = s.match(/\b(19|20)\d{2}\b/)
  if (ym) {
    const y = parseInt(ym[0], 10)
    if (y >= 1950 && y <= 2100) year = y
  }

  // Detect make
  const makes = Object.keys(FB_VEHICLE_DICTIONARY.makes)
  let make: string | null = null
  for (const mk of makes) {
    if (s.startsWith(mk + ' ') || s === mk || s.includes(' ' + mk + ' ')) { make = mk; break }
  }
  if (!make) {
    for (const mk of makes) { if (s.includes(mk)) { make = mk; break } }
  }

  // Detect model
  let model: string | null = null
  const tryModels = (mk: string) => {
    const list = FB_VEHICLE_DICTIONARY.makes[mk] || []
    let best: string | null = null
    for (const m of list) {
      if (s.includes(' ' + m + ' ') || s.endsWith(' ' + m) || s.startsWith(m + ' ') || s === m) {
        if (!best || m.length > best.length) best = m
      }
    }
    return best
  }
  if (make) {
    model = tryModels(make) || null
  } else {
    for (const mk of makes) {
      const best = tryModels(mk)
      if (best) { make = mk; model = best; break }
    }
  }

  // [TITLE-PARSE] Log parsing results
  const wantedMakes = TARGET_MAKE ? [TARGET_MAKE] : []
  const wantedModels = TARGET_MODEL ? [TARGET_MODEL] : []
  const matchesWanted =
    (wantedMakes.length === 0 || (make && wantedMakes.includes(make.toLowerCase()))) &&
    (wantedModels.length === 0 || (model && wantedModels.includes((model as string).toLowerCase())))
  const shouldLog = FB_DEBUG || !make || !model || matchesWanted
  if (shouldLog) {
    try { debug(`[TITLE-PARSE] "${title}" → year=${year}, make="${make}", model="${model}"`) } catch {}
  }

  return { year, make, model }
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
let marketplacePatchDisabled = false  // Enable GraphQL patching by default (works with make/model taxonomy IDs)
let marketplacePatchTried = false
let lastRequestWasMarketplace = false  // Track if last request was marketplace pagination

export async function installMarketplaceGraphQLInterceptor(context: BrowserContext) {
  if (gqlInterceptorInstalled) {
    if (FB_DEBUG) debug('[GQL-ROUTE] Interceptor already installed, skipping')
    return () => Promise.resolve()
  }
  gqlInterceptorInstalled = true

  const graphqlPattern = '**/api/graphql/**'
  if (FB_DEBUG) debug(`[GQL-ROUTE] Installing interceptor with pattern: ${graphqlPattern}`)

  const handler = async (route: Route) => {
    const req = route.request()
    const url = req.url()

    // [FUZZY-SEARCH-PAGINATION] Debug: Log ALL requests hitting this handler
    if (FB_DEBUG) {
      debug(`[GQL-ROUTE] Request intercepted: ${req.method()} ${url}`)
    }

    if (req.method() !== 'POST') {
      if (FB_DEBUG) debug(`[GQL-ROUTE] SKIP: Not POST method (${req.method()})`)
      return route.continue()
    }

    const headers = req.headers()
    const ct = headers['content-type'] || ''

    // [FUZZY-SEARCH-PAGINATION] Debug: Log content-type
    if (FB_DEBUG) {
      debug(`[GQL-ROUTE] Content-Type: ${ct}`)
    }

    if (!ct.includes('application/x-www-form-urlencoded')) {
      if (FB_DEBUG) debug(`[GQL-ROUTE] SKIP: Wrong content-type (expected form-urlencoded, got ${ct})`)
      return route.continue()
    }

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

      // [GQL-CAPTURE] Save first successful GraphQL request for future replay AFTER patching succeeds
      // This captures fresh cookies/tokens needed for pagination
      try {
        const fs = await import('fs/promises')
        const path = await import('path')
        const captureFile = path.join(process.cwd(), 'facebook_gql_feed_req.json')

        // Only save if file doesn't exist (don't overwrite existing captures)
        try {
          await fs.access(captureFile)
          if (FB_DEBUG) debug('[GQL-CAPTURE] Request file already exists, skipping capture')
        } catch {
          // File doesn't exist, save this request
          const requestToSave = {
            url: url,
            method: req.method(),
            headers: headers,
            postData: body
          }
          await fs.writeFile(captureFile, JSON.stringify(requestToSave, null, 2))
          if (FB_DEBUG) debug(`[GQL-CAPTURE] Saved GraphQL request to ${captureFile}`)
        }
      } catch (e) {
        if (FB_DEBUG) debug(`[GQL-CAPTURE] Failed to save request: ${(e as Error).message}`)
      }

      return await patchMarketplaceVars(route, body, (FB_DEBUG ? (...a: any[]) => debug(...a) : undefined))
    }
    let variables: any
    try { variables = JSON.parse(rawVars) } catch { return route.fallback?.() ?? route.continue() }
    const beforeVars = variables && typeof variables === 'object' ? JSON.parse(JSON.stringify(variables)) : null
    marketplacePatchTried = true

    // CRITICAL: Remove params.query if it exists - it triggers relevance ranking!
    if (variables.params?.query) {
      if (FB_DEBUG) {
        debug(`[CHRONO-FIX] Removing params.query="${variables.params.query}" from fallback patching path`)
      }
      delete variables.params.query
      if (Object.keys(variables.params || {}).length === 0) {
        delete variables.params
      }
    }

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
    const url = req.url()
    const rt = req.resourceType()

    // 1. Block only images and videos (minimal blocking to preserve UI functionality)
    const blockedTypes = ['image', 'media']
    if (blockedTypes.includes(rt)) {
      return route.abort()
    }

    // 2. Block image/video file extensions
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|mp4|webm|mov|avi|flv)(\?|$)/i.test(url)) {
      return route.abort()
    }

    // 3. Block video/stream paths
    if (/\/(dash|hls|video|stream)\//i.test(url)) {
      return route.abort()
    }

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

// ============================================================================
// [FUZZY-SEARCH] Patch Marketplace GraphQL variables with fuzzy query string
// This adopts OfferUp's approach: cast wide net with fuzzy search, filter client-side
// ============================================================================
async function patchMarketplaceVars(route: Route, body: string, dbg?: (...args: any[]) => void) {
  if (marketplacePatchDisabled) return route.continue({ postData: body })
  const params = new URLSearchParams(body)
  const docId = params.get('doc_id')

  let variables: any
  try { variables = JSON.parse(params.get('variables') || '{}') } catch { return route.continue({ postData: body }) }

  // [CHRONOLOGICAL-FIX] Use taxonomy IDs in stringVerticalFields instead of params.query
  // params.query triggers RELEVANCE ranking, breaking chronological sorting
  const WANT_MAKE = (process.env.FB_MAKE || '').trim().toLowerCase()
  const WANT_MODEL = (process.env.FB_MODEL || '').trim().toLowerCase()
  
  // CRITICAL: Inject filterSortingParams FIRST to ensure chronological sorting
  variables.filterSortingParams = variables.filterSortingParams || {}
  variables.filterSortingParams.sort_by_filter = 'CREATION_TIME'
  variables.filterSortingParams.sort_order = 'DESCEND'
  variables.filterSortingParams.sortBy = 'creation_time_descend'
  variables.filterSortingParams.sort_by = 'creation_time_descend'

  // Use taxonomy IDs for filtering instead of params.query to preserve chronological sorting
  const makeId = WANT_MAKE && MAKE_TAXONOMY_IDS[WANT_MAKE] ? MAKE_TAXONOMY_IDS[WANT_MAKE] : null
  const modelId = WANT_MODEL && MODEL_TAXONOMY_IDS[WANT_MODEL] ? MODEL_TAXONOMY_IDS[WANT_MODEL] : null

  if (makeId || modelId) {
    // Use stringVerticalFields with taxonomy IDs (preserves chronological sorting)
    variables.stringVerticalFields = variables.stringVerticalFields || []
    
    // Remove existing make/model entries if any
    variables.stringVerticalFields = variables.stringVerticalFields.filter((f: any) => {
      const name = f?.name || f?.key
      return name !== 'make' && name !== 'model'
    })
    
    // Add make filter if available
    if (makeId) {
      variables.stringVerticalFields.push({ name: 'make', values: [makeId] })
      if (dbg) {
        dbg(`[CHRONO-FIX] Using taxonomy ID for make filter: ${WANT_MAKE} -> ${makeId}`)
      }
    }
    
    // Add model filter if available
    if (modelId) {
      variables.stringVerticalFields.push({ name: 'model', values: [modelId] })
      if (dbg) {
        dbg(`[CHRONO-FIX] Using taxonomy ID for model filter: ${WANT_MODEL} -> ${modelId}`)
      }
    }
    
    // CRITICAL: Remove params.query if it exists - it triggers relevance ranking!
    if (variables.params?.query) {
      if (dbg) {
        dbg(`[CHRONO-FIX] Removing params.query="${variables.params.query}" to preserve chronological sorting`)
      }
      delete variables.params.query
      // Clean up empty params object
      if (Object.keys(variables.params || {}).length === 0) {
        delete variables.params
      }
    }
  } else {
    // No make/model specified - ensure params.query is NOT set
    if (variables.params?.query) {
      if (dbg) {
        dbg(`[CHRONO-FIX] Removing params.query="${variables.params.query}" (no filters specified)`)
      }
      delete variables.params.query
      if (Object.keys(variables.params || {}).length === 0) {
        delete variables.params
      }
    }
  }

  // Ensure topLevelVehicleType is set
  if (!variables.stringVerticalFields?.some((f: any) => (f?.name || f?.key) === 'topLevelVehicleType')) {
    variables.stringVerticalFields = variables.stringVerticalFields || []
    variables.stringVerticalFields.push({ name: 'topLevelVehicleType', values: ['car_truck'] })
  }

  if (dbg) {
    dbg(`[PATCH] Applied sort_by_filter=CREATION_TIME for doc_id=${docId} (chronological sorting enforced)`)
    if (makeId || modelId) {
      dbg(`[PATCH] Using taxonomy IDs for filtering (make: ${makeId || 'none'}, model: ${modelId || 'none'})`)
    }
  }

  params.set('variables', JSON.stringify(variables))
  return await route.continue({ postData: params.toString() })
}

// Scroll window or inner container (Marketplace often uses an inner scroller)
async function smartScroll(page: Page) {
  // [SCROLL-FIX] MUCH slower, more human-like scrolling to trigger Facebook's infinite scroll
  // User observation: "when I scroll too fast manually, sometimes the next row doesn't load"
  // Solution: Multiple small scrolls with pauses, mimicking careful manual scrolling

  // Do 3-5 micro-scrolls per "page" scroll to better trigger intersection observers
  const microScrolls = randInt(3, 5)

  // Get viewport height and calculate total scroll distance
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  const totalDistance = viewportHeight * 0.8  // Total: less than 1 viewport

  for (let i = 0; i < microScrolls; i++) {
    await page.evaluate((distance) => {
      window.scrollBy({
        top: distance,
        behavior: 'smooth'
      })
    }, totalDistance / microScrolls)

    // Wait between micro-scrolls (200-500ms)
    await page.waitForTimeout(randInt(200, 500))
  }

  // Longer pause after completing the scroll "page" (1.5-2.5 seconds)
  // This gives Facebook time to:
  // 1. Detect scroll position via intersection observers
  // 2. Make GraphQL request
  // 3. Render new content
  await page.waitForTimeout(randInt(1500, 2500))
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
  last_seen_at?: string | null
  seen_count?: number
  is_new?: boolean
  created_at_ts?: number
  extraction_source?: 'graphql' | 'graphql_replay' | 'ssr' | 'dom'
  distance_mi?: number | null
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

// [NEW-LISTING-DETECTION] Query DB to identify which candidates are NEW vs already SEEN
async function detectNewListings(candidates: ListingRow[]): Promise<{ trulyNew: ListingRow[]; alreadySeen: ListingRow[] }> {
  if (candidates.length === 0) {
    return { trulyNew: [], alreadySeen: [] }
  }

  const remoteIds = candidates.map(c => c.remote_id)

  try {
    const { data: existing, error } = await supaSvc
      .from('listings')
      .select('remote_id')
      .eq('source', 'facebook')
      .in('remote_id', remoteIds)

    if (error) {
      warn('[DETECT-NEW] DB query failed:', error.message)
      // On error, assume all are NEW (safer than assuming all are SEEN)
      return { trulyNew: candidates, alreadySeen: [] }
    }

    const existingIds = new Set((existing || []).map(e => e.remote_id))

    const trulyNew = candidates.filter(c => !existingIds.has(c.remote_id))
    const alreadySeen = candidates.filter(c => existingIds.has(c.remote_id))

    if (FB_DEBUG) {
      debug(`[DETECT-NEW] Candidates: ${candidates.length}, NEW: ${trulyNew.length}, SEEN: ${alreadySeen.length}`)
    }

    return { trulyNew, alreadySeen }
  } catch (e) {
    warn('[DETECT-NEW] Exception:', (e as Error).message)
    return { trulyNew: candidates, alreadySeen: [] }
  }
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
    if (!(resp as any).ok) {
      if (FB_DEBUG) debug(`[FB-REPLAY] HTTP error: ${(resp as any).status} ${(resp as any).statusText}`)
      return null
    }
    const text = await (resp as any).text()
    if (FB_DEBUG) debug(`[FB-REPLAY] Response length: ${text.length} bytes`)
    const cleaned = text.startsWith('for (;;);') ? text.slice('for (;;);'.length) : text
    const parsed = JSON.parse(cleaned)
    if (FB_DEBUG) debug(`[FB-REPLAY] Parsed successfully`)
    return parsed
  } catch (e) {
    warn('[FB-REPLAY] Failed:', (e as Error).message)
    if (FB_DEBUG) debug(`[FB-REPLAY] Error stack: ${(e as Error).stack}`)
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
  const concurrency = Math.max(1, Math.min(6, parseInt(process.env.FB_DETAIL_CONCURRENCY || '4', 10) || 4))

  async function work() {
    while (queue.length) {
      const row = queue.shift()!
      let page: Page | null = null
      try {
        // Stagger page creation to keep behavior human-like (especially with concurrency=4)
        await new Promise(resolve => setTimeout(resolve, randInt(200, 600)))
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

// ============================================================================
// [MULTI-REGION] Helper to change location via UI to preserve "Newest" sort
// ============================================================================
async function setRegionViaUI(page: Page, locationName: string, radiusMeters: number = 16000) {
  info(`[UI-REGION] Changing location to: ${locationName}`)

  try {
    // 1. Click the Location/Filter button.
    // Strategy: Look for the specific pattern "City · Radius" which is the most stable selector
    let locBtn = page.locator('span:has-text("·")').filter({ hasText: /(mi|km)/ }).first()
    
    // Fallbacks if the specific text pattern isn't found
    if (await locBtn.count() === 0) {
        locBtn = page.locator('div[aria-label="Change location"]').first()
    }
    if (await locBtn.count() === 0) {
        locBtn = page.locator('div[role="button"]:has-text("Location")').first()
    }

    if (await locBtn.isVisible({ timeout: 3000 })) {
      await locBtn.click()
    } else {
      warn('[UI-REGION] Could not find location button. Skipping UI change.')
      return
    }

    await page.waitForTimeout(1500)

    // 2. Find and clear the location input, then type new location
    try {
      // Look for the location input field in the dialog
      const locationInput = page.locator('div[role="dialog"] input[type="text"], div[role="dialog"] input[aria-label*="Location"], div[role="dialog"] input[placeholder*="Location"]').first()
      
      if (await locationInput.isVisible({ timeout: 3000 })) {
        // Clear existing text and type new location
        await locationInput.click()
        await page.waitForTimeout(300)
        await locationInput.fill('')  // Clear
        await page.waitForTimeout(300)
        await locationInput.fill(locationName)
        await page.waitForTimeout(1500)  // Wait for autocomplete suggestions
        
        // Try to click on the first autocomplete suggestion
        const suggestion = page.locator('div[role="listbox"] div[role="option"], ul[role="listbox"] li').first()
        if (await suggestion.isVisible({ timeout: 2000 })) {
          await suggestion.click()
          info(`[UI-REGION] Selected location from suggestions: ${locationName}`)
          await page.waitForTimeout(1000)
        } else {
          // Press Enter to accept typed location
          await page.keyboard.press('Enter')
          info(`[UI-REGION] Entered location via keyboard: ${locationName}`)
          await page.waitForTimeout(1000)
        }
      } else {
        info(`[UI-REGION] Location input not found, trying to just apply current settings`)
      }
    } catch (e) {
      info(`[UI-REGION] Could not type location: ${(e as Error).message}`)
    }

    // 3. Click "Apply" to close dialog and use new location
    await page.waitForTimeout(500)
    const applyBtn = page.locator('div[role="dialog"] div[aria-label="Apply"], div[role="dialog"] span:has-text("Apply")').first()
    if (await applyBtn.isVisible({ timeout: 3000 })) {
      await applyBtn.click()
      await page.waitForTimeout(3000)
      info(`[UI-REGION] Applied location settings`)
    } else {
      // Try clicking any visible Apply button
      const anyApply = page.locator('span:has-text("Apply")').first()
      if (await anyApply.isVisible({ timeout: 1000 })) {
        await anyApply.click()
        await page.waitForTimeout(3000)
        info(`[UI-REGION] Applied via fallback`)
      } else {
        // Last resort: press Escape to close dialog
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1000)
        info(`[UI-REGION] Closed dialog with Escape`)
      }
    }

  } catch (e) {
    warn(`[UI-REGION] Failed to set location: ${(e as Error).message}`)
  }
}

// ============================================================================
// [MULTI-REGION] Helper to force "Date listed: Newest first" via UI
// CRITICAL: This must be called when make/model filters are used to override relevance ranking
// ============================================================================
async function forceSortByNewest(page: Page) {
  info('[UI-SORT] Forcing sort order to "Newest first"...');

  try {
    // Wait a bit for UI to stabilize
    await page.waitForTimeout(1000);
    
    // 1. Find the Sort button with multiple selector strategies
    const sortSelectors = [
      'span:has-text("Sort by")',
      'div[aria-label*="Sort"]',
      'div[aria-label*="sort"]',
      'span:has-text("Suggested")',
      'div[role="button"]:has-text("Sort")',
      '[data-testid*="sort"]',
      'button:has-text("Sort")'
    ];
    
    let sortBtn = null;
    for (const selector of sortSelectors) {
      try {
        const btn = page.locator(selector).first();
        const isVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
        if (isVisible) {
          sortBtn = btn;
          break;
        }
      } catch {}
    }

    if (!sortBtn) {
      warn('[UI-SORT] Could not find sort button. UI may have changed.');
      return;
    }

    // Check if we are already on newest (optimization)
    const btnText = await sortBtn.textContent().catch(() => '');
    if (btnText && (btnText.includes('Newest') || btnText.includes('Date listed'))) {
      info('[UI-SORT] Already sorted by Newest.');
      return;
    }

    await sortBtn.click();
    await page.waitForTimeout(800); // Wait for dropdown to appear

    // 2. Select "Date listed: Newest first" from the dropdown menu
    // Facebook uses specific menu items role="menuitemradio" usually
    const newestSelectors = [
      'span:has-text("Date listed: Newest first")',
      'div:has-text("Date listed: Newest first")',
      'span:has-text("Newest first")',
      'div:has-text("Newest first")',
      '[role="menuitem"]:has-text("Newest")',
      '[role="menuitemradio"]:has-text("Newest")',
      '[role="option"]:has-text("Newest")'
    ];
    
    let clicked = false;
    for (const selector of newestSelectors) {
      try {
        const option = page.locator(selector).first();
        const isVisible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (isVisible) {
          await option.click({ timeout: 2000 });
          clicked = true;
          break;
        }
      } catch {}
    }
    
    if (clicked) {
      // Critical: Wait for the feed to actually update
      await page.waitForTimeout(2000);
      info('[UI-SORT] Clicked "Newest first". Waiting for feed reload...');
    } else {
      warn('[UI-SORT] Could not find "Newest first" option in dropdown. Trying alternative approach...');
      // Fallback: try pressing Escape to close dropdown
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

  } catch (e) {
    warn(`[UI-SORT] Failed to set sort order: ${(e as Error).message}`);
  }
}

// ============================================================================
// DOM Chronological Mode - Pure DOM scraping without GraphQL
// ============================================================================
async function runDomChrono(
  context: BrowserContext,
  page: Page,
  skipNavigation: boolean = false
): Promise<ListingRow[]> {
  if (!skipNavigation) {
    const baseUrl =
      process.env.FB_CATEGORY_URL ||
      "https://www.facebook.com/marketplace/category/vehicles?sortBy=creation_time_descend&daysSinceListed=1";

    info('[DOM-CHRONO] Navigating to:', baseUrl)

    // Navigate to category/search URL
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(randInt(800, 1500));
  }

  // Optional: if FB_MAKE/FB_MODEL are set, type a query into the Marketplace search box
  const searchQuery = [TARGET_MAKE, TARGET_MODEL].filter(Boolean).join(" ").trim();
  if (searchQuery.length > 0) {
    info('[DOM-CHRONO] Attempting search for:', searchQuery)
    try {
      // Marketplace search input is usually a role="searchbox"
      const searchBox = page.locator('input[aria-label="Search Marketplace"], input[role="searchbox"]');
      if (await searchBox.count()) {
        await searchBox.first().fill(searchQuery);
        await searchBox.first().press("Enter");
        await page.waitForTimeout(randInt(1200, 2200));
      }
    } catch (e) {
      warn('[DOM-CHRONO] Search box interaction failed:', (e as Error).message)
    }
  }

  // Scroll more aggressively to over-sample the feed
  const scrolls = Math.max(
    6,
    parseInt(process.env.FB_DOM_CHRONO_SCROLLS || "10", 10) || 10
  );

  info(`[DOM-CHRONO] Scrolling ${scrolls} times to collect listings...`)
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.2);
    });
    await page.waitForTimeout(randInt(900, 1800));
  }

  // Extract all DOM listings
  let domRows = await extractDomListings(page);
  info(
    `[DOM-CHRONO] DOM extracted ${domRows.length} listings before filters`
  );

  // Filter to vehicles and target make/model
  domRows = domRows.filter(isVehicleRow).filter(isTargetRow);
  info(
    `[DOM-CHRONO] After vehicle/make/model filters: ${domRows.length} listings`
  );

  // Optional distance filtering (if distance_mi present)
  const maxDistance =
    parseInt(process.env.FB_CHRONO_MAX_DISTANCE_MI || "", 10) || null;
  if (maxDistance != null && maxDistance > 0) {
    const beforeDist = domRows.length;
    domRows = domRows.filter(
      (r) => r.distance_mi == null || r.distance_mi <= maxDistance
    );
    info(
      `[DOM-CHRONO] Distance filter: ${beforeDist} → ${domRows.length} (<= ${maxDistance} mi)`
    );
  }

  if (!domRows.length) {
    info("[DOM-CHRONO] No candidates after filters.");
    return [];
  }

  // Enrich top K rows for posted_at/year/mileage (enrichment is expensive)
  const enrichLimit = parseInt(
    process.env.FB_DOM_CHRONO_ENRICH_LIMIT || "80",
    10
  );
  const toEnrich = domRows.slice(0, enrichLimit);

  info(
    `[DOM-CHRONO] Enriching ${toEnrich.length} listings from detail pages…`
  );
  const enriched = await enrichFacebookDetails(context, toEnrich);

  const enrichedIds = new Set(enriched.map((r) => r.remote_id));
  const unenriched = domRows.filter((r) => !enrichedIds.has(r.remote_id));
  let all = [...enriched, ...unenriched];

  // Sort by posted_at descending (fallback to first_seen_at)
  all.sort((a, b) => {
    const ta = a.posted_at
      ? Date.parse(a.posted_at)
      : Date.parse(a.first_seen_at);
    const tb = b.posted_at
      ? Date.parse(b.posted_at)
      : Date.parse(b.first_seen_at);
    return tb - ta;
  });

  const limit = TARGET_LIMIT || Math.max(20, parseInt(process.env.FB_LIMIT || "60", 10) || 60);
  if (all.length > limit) all = all.slice(0, limit);

  info(
    `[DOM-CHRONO] Final sorted result count: ${all.length} (limit=${limit})`
  );

  return all;
}

async function interceptFacebookGraphQL(sessionId?: string, regionName?: string, radiusMeters?: number): Promise<ListingRow[]> {
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
  // Maintain newest top TARGET_LIMIT items while scrolling
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
    if (top.length > TARGET_LIMIT) top.length = TARGET_LIMIT
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
          // CRITICAL: This detection helps identify when Facebook switches to relevance ranking
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
                  warn(`[RANKING] ⚠️  Facebook using RELEVANCE ranking (value=${rankValue.toExponential(2)}). Results may not be chronological!`)
                  warn(`[RANKING] This usually happens when params.query is present. Check if params.query was removed from GraphQL variables.`)
                  warn(`[RANKING] Attempting to force UI sort to "Newest first" to override...`)
                  // Try to force sort again if relevance ranking detected
                  try {
                    await forceSortByNewest(page)
                  } catch {}
                } else if (rankValue === 0) {
                  if (FB_DEBUG) {
                    debug(`[RANKING] ✓ Facebook using CHRONOLOGICAL sorting (value=0) - correct mode!`)
                  }
                }
              }
            }
          } catch {}

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
      // ============================================================================
      // SCROLL-WINDOW MODE vs URL-FILTER MODE
      // ============================================================================
      const USE_SCROLL_WINDOW = (process.env.FB_SCROLL_WINDOW_MODE ?? '0') === '1'

      let categoryUrl: string
      if (USE_SCROLL_WINDOW) {
        // Scroll-window mode: Use SAME URL as working version (no daysSinceListed - Facebook ignores it)
        // CRITICAL: Chronological sorting depends on GraphQL patching (filterSortingParams),
        // NOT on URL parameters. The URL just gets us to the right page.
        // Filtering happens via GraphQL fuzzy query + client-side filtering
        categoryUrl = `https://www.facebook.com/marketplace/category/vehicles?sortBy=creation_time_descend&daysSinceListed=1&exact=false`
        if (TARGET_MAKE || TARGET_MODEL) {
          info(`[SCROLL-WINDOW] Filtering for ${TARGET_MAKE || ''} ${TARGET_MODEL || ''} via GraphQL query + client-side filtering`)
        }
        info(`[SCROLL-WINDOW] Navigating to: ${categoryUrl}`)
      } else {
        // URL-filter mode: Add make/model taxonomy IDs to URL for server-side filtering
        // This way Facebook returns pre-filtered results already sorted by latest post date
        categoryUrl = 'https://www.facebook.com/marketplace/category/vehicles?sortBy=creation_time_descend&daysSinceListed=1&exact=false'

        // Build filtered URL if make/model are specified
        const hasTargetFilter = TARGET_MAKE || TARGET_MODEL
        if (hasTargetFilter) {
          const params = new URLSearchParams()
          params.set('sortBy', 'creation_time_descend')
          params.set('daysSinceListed', '1')  // CRITICAL for chronological sorting!
          params.set('exact', 'false')

          // Add make filter if available
          if (TARGET_MAKE && MAKE_TAXONOMY_IDS[TARGET_MAKE]) {
            params.set('make', MAKE_TAXONOMY_IDS[TARGET_MAKE])
            info(`[URL-FILTER] Adding make filter: ${TARGET_MAKE} (ID: ${MAKE_TAXONOMY_IDS[TARGET_MAKE]})`)
          }

          // Add model filter if available
          if (TARGET_MODEL && MODEL_TAXONOMY_IDS[TARGET_MODEL]) {
            params.set('model', MODEL_TAXONOMY_IDS[TARGET_MODEL])
            info(`[URL-FILTER] Adding model filter: ${TARGET_MODEL} (ID: ${MODEL_TAXONOMY_IDS[TARGET_MODEL]})`)
          }

          categoryUrl = `https://www.facebook.com/marketplace/category/vehicles?${params.toString()}`
          info(`[URL-FILTER] Navigating to pre-filtered URL: ${categoryUrl}`)
        } else {
          info(`[URL-FILTER] No make/model specified - using generic vehicles URL`)
        }
      }

      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch (e) {
      warn('Nav failed', (e as Error).message)
      // Return empty to let the controller rotate session/proxy without crashing
      return []
    }
    await page.waitForTimeout(randInt(250, 1250))
    info('Page loaded:', await page.url())

    // CRITICAL: Force sort to "Newest first" immediately after navigation
    // This ensures chronological sorting even if GraphQL patching fails or params.query was used
    info('[CHRONO-FIX] Forcing UI sort to "Newest first" after navigation')
    await forceSortByNewest(page)
    await page.waitForTimeout(1000) // Wait for sort to take effect

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

    // ⚡ SCROLL-WINDOW MODE: Fast scroll hack for quick chronological batch
    const USE_SCROLL_WINDOW = (process.env.FB_SCROLL_WINDOW_MODE ?? '0') === '1'

    // [MULTI-REGION] Change location via UI for each region
    // This works in both scroll-window and non-scroll-window modes
    if (regionName) {
      info(`[MULTI-REGION] Changing to region: ${regionName}`)
      await setRegionViaUI(page, regionName, radiusMeters || 16000)
      
      // Wait for page to update after location change
      await page.waitForTimeout(2000)
    }
    
    // CRITICAL: Always force sort by newest, especially when filters are applied
    // This overrides any relevance ranking that might be triggered by params.query
    // Even if we removed params.query, Facebook might still default to relevance
    if (TARGET_MAKE || TARGET_MODEL) {
      info('[CHRONO-FIX] Make/model filters detected - forcing UI sort to "Newest first" to ensure chronological results')
      await forceSortByNewest(page)
    } else {
      // Even without filters, ensure we're sorted by newest
      await forceSortByNewest(page)
    }

    if (USE_SCROLL_WINDOW) {
      info('[SCROLL-WINDOW] Using scroll-window mode (continuous DOM extraction)')

      // CRITICAL: Wait for initial GraphQL responses to be processed
      // The page loads with server-rendered content, but we need the PATCHED GraphQL 
      // responses to populate chronologically-sorted listings
      info('[SCROLL-WINDOW] Waiting for initial GraphQL responses to be processed...')
      
      // Record initial GraphQL response count
      const initialResponses = metrics.graphqlResponses
      
      // Get viewport height for scrolling
      const viewportHeight = await page.evaluate(() => window.innerHeight)
      
      // Do a small scroll to trigger Facebook's intersection observer (loads more data via GraphQL)
      await page.mouse.wheel(0, viewportHeight * 0.3)  // Small scroll to trigger data fetch
      
      // Wait for at least one new GraphQL response (with timeout)
      const waitStart = Date.now()
      const maxWaitMs = 5000
      while (metrics.graphqlResponses === initialResponses && Date.now() - waitStart < maxWaitMs) {
        await page.waitForTimeout(200)
      }
      
      if (metrics.graphqlResponses > initialResponses) {
        info(`[SCROLL-WINDOW] GraphQL responses received (${metrics.graphqlResponses - initialResponses} new). Starting DOM extraction.`)
      } else {
        warn('[SCROLL-WINDOW] No new GraphQL responses after initial scroll. Page might use SSR data.')
      }
      
      // Additional wait for DOM to update after GraphQL response
      await page.waitForTimeout(randInt(800, 1200))

      // Small human-like mouse movements
      try {
        await page.mouse.move(randInt(100, 400), randInt(100, 300))
        await page.waitForTimeout(randInt(150, 400))
        await page.mouse.move(randInt(500, 900), randInt(200, 600))
      } catch {}

      const scrolls = Math.max(6, parseInt(process.env.FB_SCROLL_WINDOW_SCROLLS || '10', 10) || 10)

      // CONTINUOUS DOM EXTRACTION during scrolling
      const allListings = new Map<string, ListingRow>()  // Key = remote_id

      for (let i = 0; i < scrolls; i++) {
        // Scroll one viewport
        await page.mouse.wheel(0, viewportHeight)

        // CRITICAL: Wait 1200-1800ms for Facebook's intersection observer to trigger
        await page.waitForTimeout(randInt(1200, 1800))

        // Extract DOM after EACH scroll (not just at the end)
        const batchRows = await extractDomListings(page)
        batchRows.forEach(row => {
          if (!allListings.has(row.remote_id)) {
            allListings.set(row.remote_id, row)
          }
        })

        if (FB_DEBUG) {
          debug(`[SCROLL-WINDOW] After scroll ${i + 1}/${scrolls}: ${allListings.size} unique listings collected`)
        }
      }

      // Convert Map to array
      const domRows = Array.from(allListings.values())
      info(`[SCROLL-WINDOW] DOM extracted ${domRows.length} unique listings after ${scrolls} scrolls`)

      // Filter: vehicles only (isVehicleRow already exists)
      let candidates = domRows.filter(isVehicleRow)
      info(`[SCROLL-WINDOW] After vehicle filter: ${candidates.length} listings`)

      // Filter: make/model (isTargetRow already exists)
      if (TARGET_MAKE || TARGET_MODEL) {
        candidates = candidates.filter(isTargetRow)
        info(`[SCROLL-WINDOW] After make/model filter (${TARGET_MAKE || 'any'}/${TARGET_MODEL || 'any'}): ${candidates.length} listings`)
      }

      // Limit collection window before enrichment
      const WINDOW_COLLECTION_LIMIT = Math.max(
        TARGET_LIMIT,
        parseInt(process.env.FB_WINDOW_COLLECTION_LIMIT || '120', 10) || 120
      )

      // ============================================================
      // ⚡ OPTIMIZATION: PRE-ENRICHMENT FILTER (The "Fail Fast" Step)
      // Drop items that clearly fail criteria based on DOM data alone.
      // This prevents opening tabs for cars we know we don't want.
      // ============================================================
      const preEnrichCount = candidates.length

      // Hardcoded rules matching your [FINAL-FILTER] logic from the logs
      // You can swap these 15000/2012 numbers for env vars if you prefer later
      const MIN_PRICE_HARD = 15000
      const MIN_YEAR_HARD = 2012

      candidates = candidates.filter(r => {
        // 1. Price Check (if price exists in DOM)
        if (r.price != null && r.price < MIN_PRICE_HARD) {
            // It's $4,000, we want $15,000+. Drop it now.
            return false
        }

        // 2. Year Check (if year exists in DOM/Title)
        if (r.year != null && r.year < MIN_YEAR_HARD) {
            // It's a 2008, we want 2012+. Drop it now.
            return false
        }

        // 3. Keyword Check (Drop parts/downpayments early)
        const t = (r.title || '').toLowerCase()
        if (t.includes('part out') || t.includes('parting out') || t.includes('down payment')) {
            return false
        }

        return true
      })

      info(`[OPTIMIZATION] Pre-filtered DOM candidates: ${preEnrichCount} -> ${candidates.length} (Dropped ${preEnrichCount - candidates.length} cheap/old items before opening tabs)`)

      if (candidates.length > WINDOW_COLLECTION_LIMIT) {
        candidates = candidates.slice(0, WINDOW_COLLECTION_LIMIT)
        info(`[SCROLL-WINDOW] Limiting to ${WINDOW_COLLECTION_LIMIT} candidates before enrichment`)
      }

      // Detail-page enrichment for posted_at / year / mileage
      const doDetailEnrich = (process.env.FB_DETAIL_ENRICH ?? '1') !== '0'
      let resultRows = candidates

      if (doDetailEnrich && candidates.length > 0) {
        const enrichLimit = parseInt(process.env.FB_DETAIL_ENRICH_LIMIT || '80', 10)
        const toEnrich = candidates.slice(0, enrichLimit)
        info(`[SCROLL-WINDOW] Enriching ${toEnrich.length} listings from detail pages`)

        // Use existing enrichFacebookDetails with higher concurrency
        const enriched = await enrichFacebookDetails(context, toEnrich)

        const enrichedIds = new Set(toEnrich.map(r => r.remote_id))
        const unenriched = candidates.filter(r => !enrichedIds.has(r.remote_id))
        resultRows = [...enriched, ...unenriched]

        const enrichedWithTimestamp = enriched.filter(r => r.posted_at != null).length
        info(`[SCROLL-WINDOW] Enrichment complete: ${enriched.length} enriched, ${enrichedWithTimestamp} with timestamps`)
      }

      // Optional: posted_within_hours filter (e.g., last 3 hours)
      if (FB_FILTER_POSTED_WITHIN_HOURS != null) {
        const beforeFilter = resultRows.length
        const cutoffTime = Date.now() - FB_FILTER_POSTED_WITHIN_HOURS * 3600_000
        resultRows = resultRows.filter(row => {
          if (!row.posted_at) return true  // Keep if unknown (safer)
          const ts = new Date(row.posted_at).getTime()
          return Number.isFinite(ts) ? ts >= cutoffTime : true
        })
        info(`[SCROLL-WINDOW] Timestamp filter (last ${FB_FILTER_POSTED_WITHIN_HOURS}h): ${beforeFilter} → ${resultRows.length}`)
      }

      // Final sort: strictly newest first by posted_at (fallback to first_seen_at)
      resultRows.sort((a, b) => {
        const aTime = a.posted_at ? new Date(a.posted_at).getTime() : Date.parse(a.first_seen_at)
        const bTime = b.posted_at ? new Date(b.posted_at).getTime() : Date.parse(b.first_seen_at)
        return bTime - aTime
      })

      // Limit to TARGET_LIMIT newest
      if (resultRows.length > TARGET_LIMIT) {
        info(`[SCROLL-WINDOW] Limiting from ${resultRows.length} to ${TARGET_LIMIT} newest listings`)
        resultRows = resultRows.slice(0, TARGET_LIMIT)
      }

      info(`[SCROLL-WINDOW] Final result: ${resultRows.length} listings (enriched, filtered, sorted chronologically)`)

      // Return early - skip normal scroll loop
      return resultRows
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
        if (FB_DEBUG) debug(`[FB-REPLAY] Fetching page ${pages + 1} with cursor: ${cursor || 'null (first page)'}`)
        const r = await fetchFacebookFeedFromSaved(cursor)
        if (!r) {
          if (FB_DEBUG) debug(`[FB-REPLAY] fetchFacebookFeedFromSaved returned null, stopping`)
          break
        }
        const edges = extractEdgesFromBody(r)
        if (FB_DEBUG) debug(`[FB-REPLAY] Page ${pages + 1}: extracted ${edges.length} edges`)
        if (!edges.length) {
          if (FB_DEBUG) debug(`[FB-REPLAY] No edges found in response, stopping`)
          break
        }
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
        // [FUZZY-SEARCH-PAGINATION] Track state before scroll to detect if new content loaded
        const beforeHeight = await page.evaluate(() => document.body.scrollHeight)
        const beforeMatched = matched.length

        await smartScroll(page)

        // [SCROLL-FIX] Wait for network to become idle after scroll
        // Increased timeout to 15 seconds since we're scrolling slower now
        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 })
          if (FB_DEBUG) debug(`[SCROLL] Network idle after scroll ${i + 1}`)
        } catch (e) {
          if (FB_DEBUG) debug(`[SCROLL] Network idle timeout after 15s (continuing anyway)`)
        }

        // [SCROLL-FIX] Additional random wait removed - smartScroll already includes 1.5-2.5s wait
        // await page.waitForTimeout(randInt(SCROLL_MIN_MS, SCROLL_MAX_MS))

        // Track state after scroll
        const afterHeight = await page.evaluate(() => document.body.scrollHeight)
        const stats = { h: afterHeight, inner: await page.evaluate(() => window.innerHeight) }

        if (FB_DEBUG) {
          debug(`Scroll ${i + 1}/${SCROLL_PAGES}`, {
            bodyH: stats.h,
            innerH: stats.inner,
            collected: collected.length,
            heightChange: afterHeight - beforeHeight
          })
        }

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
        // [FUZZY-SEARCH-PAGINATION] Early stop match counter - check both GraphQL AND DOM matches
        try {
          // Check GraphQL matches
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

          // [FUZZY-SEARCH-PAGINATION] Check DOM listings on EVERY scroll (not just after scroll 3)
          // This is needed because GraphQL interception isn't working
          try {
            const domRows = await extractDomListings(page)
            if (FB_DEBUG) {
              debug(`[DOM-SCROLL] Extracted ${domRows.length} DOM listings at scroll ${i + 1}/${SCROLL_PAGES}`)
            }

            // Filter DOM rows using HARD FILTER logic (make/model match)
            for (const row of domRows) {
              if (matchedIds.has(row.remote_id)) continue // Skip duplicates

              // Parse title for make/model
              const parsed = parseListingTitle(row.title)
              const rowMake = (row.make || parsed.make || '').toLowerCase()
              const rowModel = (row.model || parsed.model || '').toLowerCase()

              // Check if it matches our target
              const makeMatch = !TARGET_MAKE || rowMake === TARGET_MAKE
              const modelMatch = !TARGET_MODEL || rowModel === TARGET_MODEL

              if (makeMatch && modelMatch) {
                matched.push(row)
                matchedIds.add(row.remote_id)
                if (FB_DEBUG) {
                  debug(`[DOM-SCROLL] MATCH: "${row.title}" (${rowMake} ${rowModel})`)
                }

                if (matched.length >= COLLECTION_LIMIT) break
              }
            }

            if (FB_DEBUG) {
              debug(`[DOM-SCROLL] Total matched so far: ${matched.length}/${COLLECTION_LIMIT}`)
            }
          } catch (e) {
            if (FB_DEBUG) debug(`[DOM-SCROLL] DOM extraction failed: ${(e as Error).message}`)
          }

          // [FUZZY-SEARCH-PAGINATION] Detect if new content was loaded (like OfferUp checks for new items)
          const afterMatched = matched.length
          const heightChanged = afterHeight !== beforeHeight
          const matchesChanged = afterMatched !== beforeMatched

          // IMPORTANT: Don't stop early! Based on user feedback, Facebook needs ALL 8 scrolls
          // before it actually loads content. Only check after completing all scrolls.
          if (!heightChanged && !matchesChanged && i >= SCROLL_PAGES - 1) {
            info(`[FB-SCROLL] Completed all ${SCROLL_PAGES} scrolls with no new content (height: ${beforeHeight}→${afterHeight}, matches: ${beforeMatched}→${afterMatched}).`)
            // Don't break - let it complete the loop naturally
          }

          if (FB_DEBUG) {
            if (heightChanged || matchesChanged) {
              debug(`[SCROLL] Content loaded: height ${beforeHeight}→${afterHeight}, matches ${beforeMatched}→${afterMatched}`)
            } else {
              debug(`[SCROLL] No new content yet, continuing (scroll ${i + 1}/${SCROLL_PAGES})`)
            }
          }

          debug('Target match count', { matchCount: matched.length, collectionLimit: COLLECTION_LIMIT })
          // Changed: Stop when we hit COLLECTION_LIMIT (we'll sort and filter to TARGET_LIMIT later)
          if (top.length >= TARGET_LIMIT || matched.length >= COLLECTION_LIMIT) {
            info(`[FB] Reached ${matched.length} matched rows; stopping to sort by timestamp.`)
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

    // [NEW-LISTING-DETECTION] Detect which candidates are NEW vs already SEEN
    // This allows us to prioritize enriching NEW listings (they need timestamps for alerts)
    const { trulyNew, alreadySeen } = await detectNewListings(limited)
    info(`[NEW-DETECTION] Found ${trulyNew.length} NEW listings, ${alreadySeen.length} already seen`)

    // OPTIONAL: only enrich if we actually care about year/mileage (we do, for KNN)
    const doDetailEnrich = (process.env.FB_DETAIL_ENRICH ?? '1') !== '0'
    let resultRows = limited

    if (doDetailEnrich && limited.length > 0) {
      // [NEW-LISTING-DETECTION] Prioritize enriching NEW listings first
      // NEW listings need timestamps for alert detection, SEEN listings are lower priority
      const enrichLimit = parseInt(process.env.FB_DETAIL_ENRICH_LIMIT || '50')
      const toEnrich = [
        ...trulyNew.slice(0, enrichLimit),  // Enrich ALL new (up to limit)
        ...alreadySeen.slice(0, Math.max(0, enrichLimit - trulyNew.length))  // Then fill remaining slots with SEEN
      ]

      info(`[FB-DETAIL] Enriching ${toEnrich.length} listings (${Math.min(trulyNew.length, enrichLimit)} NEW + ${toEnrich.length - Math.min(trulyNew.length, enrichLimit)} SEEN)`)
      const enriched = await enrichFacebookDetails(context, toEnrich)

      // Merge enriched data back into full list
      const enrichedIds = new Set(toEnrich.map(r => r.remote_id))
      const unenriched = limited.filter(r => !enrichedIds.has(r.remote_id))
      resultRows = [...enriched, ...unenriched]

      const enrichedRowsWithYear = enriched.filter(r => r.year != null).length
      const enrichedRowsWithMileage = enriched.filter(r => r.mileage != null).length
      info('[FB-DETAIL] Enrichment stats', { total: resultRows.length, enriched: enriched.length, withYear: enrichedRowsWithYear, withMileage: enrichedRowsWithMileage })
    }

    // [URL-FILTER] STAGE 3: Client-side HARD FILTER (only needed if URL filtering failed/unavailable)
    // Skip if we successfully used URL-based taxonomy filtering (Facebook already filtered for us)
    const hasTargetFilter =
      (process.env.FB_MAKE && process.env.FB_MAKE.trim().length > 0) ||
      (process.env.FB_MODEL && process.env.FB_MODEL.trim().length > 0)

    const usedUrlFilter =
      (TARGET_MAKE && MAKE_TAXONOMY_IDS[TARGET_MAKE]) ||
      (TARGET_MODEL && MODEL_TAXONOMY_IDS[TARGET_MODEL])

    if (hasTargetFilter && usedUrlFilter) {
      // URL filtering was used - Facebook already filtered results for us
      info(`[URL-FILTER] Skipping client-side HARD FILTER - Facebook already filtered via taxonomy IDs`)
    } else if (hasTargetFilter && !usedUrlFilter) {
      // Only apply HARD FILTER if we couldn't use URL filtering (taxonomy IDs not available)
      const beforeHardFilter = resultRows.length
      info(`[HARD-FILTER] URL filtering unavailable - applying client-side title parsing filter on ${beforeHardFilter} listings`)

      // Parse all titles using vehicle dictionary
      const wantMake = TARGET_MAKE ? TARGET_MAKE.toLowerCase() : null
      const wantModel = TARGET_MODEL ? TARGET_MODEL.toLowerCase() : null

      const hardFiltered: ListingRow[] = []
      let rejectedByMake = 0
      let rejectedByModel = 0

      for (const row of resultRows) {
        // Parse title to extract make/model/year
        const parsed = parseListingTitle(row.title)

        // Check make filter
        if (wantMake) {
          const rowMake = (row.make || parsed.make || '').toLowerCase()
          if (rowMake !== wantMake) {
            rejectedByMake++
            if (FB_DEBUG) {
              info(`[HARD-FILTER] REJECT (make): "${row.title}" - got make="${rowMake}", want="${wantMake}"`)
            }
            continue
          }
        }

        // Check model filter
        if (wantModel) {
          const rowModel = (row.model || parsed.model || '').toLowerCase()
          if (rowModel !== wantModel) {
            rejectedByModel++
            if (FB_DEBUG) {
              info(`[HARD-FILTER] REJECT (model): "${row.title}" - got model="${rowModel}", want="${wantModel}"`)
            }
            continue
          }
        }

        // Passed all filters
        hardFiltered.push(row)
      }

      const afterHardFilter = hardFiltered.length
      info(`[HARD-FILTER] Kept: ${afterHardFilter} listings (rejected: ${rejectedByMake} by make, ${rejectedByModel} by model)`)

      resultRows = hardFiltered
    }

    // [FUZZY-SEARCH] STAGE 4: TIMESTAMP FILTER - Filter by posted_at timestamp (like OfferUp's OU_FILTER_POSTED_WITHIN_HOURS)
    if (FB_FILTER_POSTED_WITHIN_HOURS != null) {
      const beforeTimeFilter = resultRows.length
      info(`[TIMESTAMP-FILTER] Input: ${beforeTimeFilter} listings (will filter by posted within ${FB_FILTER_POSTED_WITHIN_HOURS} hours)`)

      const cutoffTime = Date.now() - FB_FILTER_POSTED_WITHIN_HOURS * 3600_000
      const timeFiltered: ListingRow[] = []
      let rejectedByTimestamp = 0
      let missingTimestamp = 0

      for (const row of resultRows) {
        if (!row.posted_at) {
          missingTimestamp++
          if (FB_DEBUG) {
            info(`[TIMESTAMP-FILTER] SKIP (no timestamp): "${row.title}"`)
          }
          // Keep listings without timestamps (better to include than exclude)
          timeFiltered.push(row)
          continue
        }

        const postedTime = new Date(row.posted_at).getTime()
        if (postedTime < cutoffTime) {
          rejectedByTimestamp++
          if (FB_DEBUG) {
            const ageHours = Math.round((Date.now() - postedTime) / 3600_000)
            info(`[TIMESTAMP-FILTER] REJECT (too old): "${row.title}" - posted ${ageHours}h ago, want <${FB_FILTER_POSTED_WITHIN_HOURS}h`)
          }
          continue
        }

        // Passed timestamp filter
        timeFiltered.push(row)
      }

      const afterTimeFilter = timeFiltered.length
      info(`[TIMESTAMP-FILTER] Kept: ${afterTimeFilter} listings (rejected: ${rejectedByTimestamp} too old, ${missingTimestamp} missing timestamp but kept)`)

      resultRows = timeFiltered
    }

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

    // [FUZZY-SEARCH] STAGE-GATE SUMMARY - Log progression through each processing stage
    info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    info('[STAGE-GATE] Processing Pipeline Summary:')
    info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    info(`[STAGE 1] EXTRACTION:`)
    info(`  - GraphQL requests: ${metrics.graphqlRequests}`)
    info(`  - GraphQL edges:    ${metrics.graphqlEdges}`)
    info(`  - SSR edges:        ${metrics.ssrEdges}`)
    info(`  - DOM candidates:   ${metrics.domCandidates}`)
    info(`[STAGE 2] NORMALIZATION & DEDUP:`)
    info(`  - Normalized:       ${metrics.normalized}`)
    info(`  - After dedup:      ${metrics.deduped}`)
    info(`[STAGE 3] HARD FILTER: (make/model only)`)
    info(`  - See [HARD-FILTER] logs above for details`)
    info(`[STAGE 4] TIMESTAMP FILTER: (posted_within_hours)`)
    info(`  - See [TIMESTAMP-FILTER] logs above for details`)
    info(`[STAGE 5] ENRICHMENT:`)
    info(`  - Enriched:         ${doDetailEnrich ? limited.length : 0}`)
    info(`[STAGE 6] FINAL SORT & LIMIT:`)
    info(`  - Final count:      ${resultRows.length}`)
    info(`  - With year:        ${resultRows.filter(r => r.year != null).length}`)
    info(`  - With mileage:     ${resultRows.filter(r => r.mileage != null).length}`)
    info(`  - With timestamp:   ${resultRows.filter(r => r.posted_at != null).length}`)
    info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

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

// [NEW-LISTING-DETECTION] Smart upsert: track NEW vs SEEN listings
async function upsertListings(rows: ListingRow[]): Promise<{ inserted: number; updated: number; newListingIds: string[] }> {
  if (!rows.length) return { inserted: 0, updated: 0, newListingIds: [] }

  // Remove fields not in database schema
  const cleaned = rows.map(({ extraction_source, created_at_ts, ...rest }) => rest)

  const newListingIds: string[] = []
  let inserted = 0
  let updated = 0

  // Process in batches of 10 to avoid overwhelming DB with individual queries
  const batched = [] as typeof cleaned[]
  for (let i = 0; i < cleaned.length; i += 10) batched.push(cleaned.slice(i, i + 10))

  for (const chunk of batched) {
    for (const row of chunk) {
      try {
        // Check if listing exists
        const { data: existing, error: queryError } = await supaSvc
          .from('listings')
          .select('id, seen_count')
          .eq('source', row.source)
          .eq('remote_id', row.remote_id)
          .maybeSingle()

        if (queryError) {
          warn(`[UPSERT] Query error for ${row.remote_id}:`, queryError.message)
          continue
        }

        const now = new Date().toISOString()

        if (!existing) {
          // TRUE NEW LISTING - insert with is_new=true
          const { data: inserted_row, error: insertError } = await supaSvc
            .from('listings')
            .insert({
              ...row,
              first_seen_at: now,
              last_seen_at: now,
              seen_count: 1,
              is_new: true
            })
            .select('id')
            .maybeSingle()

          if (insertError) {
            warn(`[UPSERT] Insert error for ${row.remote_id}:`, insertError.message)
          } else {
            inserted++
            if (inserted_row?.id) {
              newListingIds.push(inserted_row.id)
            }
            if (FB_DEBUG) {
              debug(`[UPSERT] NEW: ${row.title} (${row.remote_id})`)
            }
          }
        } else {
          // EXISTING LISTING - update with is_new=false, increment seen_count
          const { error: updateError } = await supaSvc
            .from('listings')
            .update({
              price: row.price,
              mileage: row.mileage,
              posted_at: row.posted_at || null,
              last_seen_at: now,
              seen_count: (existing.seen_count || 0) + 1,
              is_new: false
            })
            .eq('id', existing.id)

          if (updateError) {
            warn(`[UPSERT] Update error for ${row.remote_id}:`, updateError.message)
          } else {
            updated++
            if (FB_DEBUG) {
              debug(`[UPSERT] UPDATED: ${row.title} (seen ${(existing.seen_count || 0) + 1} times)`)
            }
          }
        }
      } catch (e) {
        warn(`[UPSERT] Exception for ${row.remote_id}:`, (e as Error).message)
      }
    }
  }

  info(`[UPSERT] Inserted ${inserted} new, updated ${updated} existing listings`)
  if (newListingIds.length > 0) {
    info(`[UPSERT] New listing IDs: ${newListingIds.join(', ')}`)
  }

  return { inserted, updated, newListingIds }
}

// ============================================================================
// DOM Chronological Session Runner - Separate from GraphQL mode
// ============================================================================
async function runDomChronoSession(sessionId?: string, regionName?: string, radiusMeters?: number): Promise<ListingRow[]> {
  let browser: Browser | null = null
  lastLoginWallDetected = false

  try {
    const usingProxy = !!(process.env.FB_PROXY_SERVER && process.env.FB_PROXY_USERNAME)
    const proxyServer = process.env.FB_PROXY_SERVER
    const proxyUserBase = process.env.FB_PROXY_USERNAME
    const proxyPass = process.env.FB_PROXY_PASSWORD
    const proxySession = sessionId || process.env.FB_PROXY_SESSION_ID || Math.random().toString(36).slice(2, 10)

    const launchOpts: LaunchOptions = {
      headless: HEADLESS,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    }
    if (proxyServer && proxyUserBase && proxyPass) {
      launchOpts.proxy = {
        server: proxyServer,
        username: `${proxyUserBase}-session-${proxySession}`,
        password: proxyPass,
      }
    }

    browser = await chromium.launch(launchOpts)
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      timezoneId: 'America/Los_Angeles',
      locale: 'en-US',
      geolocation:
        process.env.OU_LAT && process.env.OU_LNG
          ? {
              latitude: Number(process.env.OU_LAT),
              longitude: Number(process.env.OU_LNG),
            }
          : undefined,
      permissions: ['geolocation'],
      storageState: FB_USE_STORAGE_STATE ? FB_STORAGE_STATE : undefined,
    })

    // Load cookies if provided (same logic as interceptFacebookGraphQL)
    if (!FB_USE_STORAGE_STATE && FB_COOKIES_PATH) {
      try {
        const raw = await fs.readFile(FB_COOKIES_PATH, 'utf8')
        const json = JSON.parse(raw)
        let cookies: any[] = []
        if (Array.isArray(json?.cookies)) {
          cookies = json.cookies
        } else if (Array.isArray(json)) {
          cookies = json
        }
        if (Array.isArray(cookies) && cookies.length) {
          const mapped = cookies.map((c: any) => {
            let host = c.domain || (c.url ? new URL(c.url).hostname : 'facebook.com')
            if (host.startsWith('.')) host = host.slice(1)
            if (!host.includes('.')) host = 'facebook.com'
            return {
              name: c.name,
              value: c.value,
              domain: `.${host}`,
              path: c.path || '/',
              expires: c.expirationDate || c.expires || -1,
              httpOnly: c.httpOnly ?? false,
              secure: c.secure ?? true,
              sameSite: (c.sameSite as any) || 'Lax',
            }
          })
          await context.addCookies(mapped)
          debug('[DOM-CHRONO] Loaded cookies from', FB_COOKIES_PATH, '(count:', cookies.length, ')')
        }
      } catch (e) {
        warn('[DOM-CHRONO] Failed to load cookies:', (e as Error).message)
      }
    }

    const page = await context.newPage()

    // Warmup home (reuse warmupHome helper)
    await warmupHome(page)

    // If login wall appears, bail early
    if (await isLoginWallVisible(page)) {
      warn('[DOM-CHRONO] Login wall visible; cookies likely invalid.')
      lastLoginWallDetected = true
      return []
    }

    // Navigate to marketplace first
    const baseUrl =
      process.env.FB_CATEGORY_URL ||
      "https://www.facebook.com/marketplace/category/vehicles?sortBy=creation_time_descend&daysSinceListed=1"

    info('[DOM-CHRONO-SESSION] Navigating to:', baseUrl)
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.waitForTimeout(randInt(800, 1500))

    // [FIX] SKIP setRegionViaUI - it corrupts the sort order
    // The location dialog interaction causes Facebook to reset to relevance ranking
    // In dom_chrono mode, we rely on the user's profile location (set in Facebook account)
    if (regionName) {
      warn(`[DOM-CHRONO-SESSION] Multi-region mode: skipping UI location change to preserve chronological sort`)
      warn(`[DOM-CHRONO-SESSION] Location is set via browser geolocation (${process.env.OU_LAT}, ${process.env.OU_LNG})`)
      warn(`[DOM-CHRONO-SESSION] Note: Facebook may still use your profile location. For best results, run single-region mode.`)
    }

    // Now run the extraction/scrolling logic (skip navigation since we already navigated)
    const rows = await runDomChrono(context, page, true)
    return rows
  } finally {
    try {
      await browser?.close()
    } catch {}
  }
}

async function scrapeRegion(regionName?: string, radiusMeters?: number) {
  const usingProxy = !!(process.env.FB_PROXY_SERVER && process.env.FB_PROXY_USERNAME)
  const baseSession = (process.env.FB_PROXY_SESSION_ID || 'la01').trim()
  let session = baseSession

  console.log(`[FB] Starting Marketplace capture... (mode=${FB_MODE})`, {
    headless: HEADLESS,
    pages: SCROLL_PAGES,
    proxy: usingProxy ? 'on' : 'off',
    cookies: !!FB_COOKIES_PATH
  })

  let allRows: ListingRow[] = []
  for (let attempt = 1; attempt <= FB_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // rotate sticky session between attempts
      session = nextSessionId(session)
      if (FB_DEBUG) console.log('[FB] Rotating sticky session ->', session)
    }

    let rows: ListingRow[] = []
    if (FB_MODE === 'dom_chrono') {
      // Pass radiusMeters down
      rows = await runDomChronoSession(session, regionName, radiusMeters)
    } else {
      // [FIX] Pass regionName and radiusMeters here so the interceptor can change the UI
      rows = await interceptFacebookGraphQL(session, regionName, radiusMeters)
    }

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

    if (!FB_ROTATE_ON_ZERO) {
      allRows = rows
      break
    } // no auto-rotate configured
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
  if (FB_FILTER_POSTED_WITHIN_HOURS != null && allRows.length > 0 && process.env.FB_SCROLL_WINDOW_MODE !== '1') {
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

  // ==================================================================================
  // FINAL PRE-UPSERT FILTERING:
  // Apply business rules before upserting to database:
  // 1. Price must be at least $15,000
  // 2. Year must be 2012 or newer
  // 3. Posted within last 2 days (48 hours)
  // ==================================================================================
  const beforeFinalFilter = filteredRows.length
  const twoDaysAgo = Date.now() - (2 * 24 * 3_600_000)  // 48 hours in milliseconds

  filteredRows = filteredRows.filter(row => {
    // Price filter: must be >= $15,000
    if (row.price == null || row.price < 15000) {
      if (FB_DEBUG) {
        debug(`[FINAL-FILTER] REJECT (price < $15k): "${row.title}" - price: $${row.price}`)
      }
      return false
    }

    // Year filter: must be >= 2012
    if (row.year == null || row.year < 2012) {
      if (FB_DEBUG) {
        debug(`[FINAL-FILTER] REJECT (year < 2012): "${row.title}" - year: ${row.year}`)
      }
      return false
    }

    // Date filter: must be posted within last 2 days
    if (row.posted_at) {
      const postedTime = new Date(row.posted_at).getTime()
      if (Number.isFinite(postedTime) && postedTime < twoDaysAgo) {
        if (FB_DEBUG) {
          const ageHours = Math.round((Date.now() - postedTime) / 3600_000)
          debug(`[FINAL-FILTER] REJECT (posted > 2 days ago): "${row.title}" - posted ${ageHours}h ago`)
        }
        return false
      }
    } else {
      // If no posted_at timestamp, reject it (can't verify it's within 2 days)
      if (FB_DEBUG) {
        debug(`[FINAL-FILTER] REJECT (no posted_at): "${row.title}"`)
      }
      return false
    }

    // Passed all filters
    return true
  })

  const afterFinalFilter = filteredRows.length
  const rejectedByFinalFilter = beforeFinalFilter - afterFinalFilter

  info(`[FINAL-FILTER] Applied business rules: ${beforeFinalFilter} listings -> ${afterFinalFilter} listings`)
  info(`[FINAL-FILTER] Rejected: ${rejectedByFinalFilter} (price < $15k, year < 2012, or posted > 2 days ago)`)

  const res = await upsertListings(filteredRows)

  // [NEW-LISTING-DETECTION] Output summary with NEW listings highlighted
  info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  info(`[FINAL RESULTS]`)
  info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  info(`Total scraped:     ${filteredRows.length} listings`)
  info(`New listings:      ${res.inserted} 🆕`)
  info(`Already seen:      ${res.updated} (updated)`)
  info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

  if (res.inserted === 0) {
    info(`ℹ️  No new listings found. All ${res.updated} listings have been seen before.`)
  } else {
    info(`✨ Found ${res.inserted} NEW listing${res.inserted === 1 ? '' : 's'}!`)
    // Optionally log details of new listings (for dealer to review)
    if (FB_DEBUG && res.newListingIds.length > 0) {
      const newListings = filteredRows.filter(r =>
        res.newListingIds.some(id => String(id).includes(r.remote_id))
      )
      for (const listing of newListings) {
        debug(`  🆕 ${listing.year || '?'} ${listing.make || '?'} ${listing.model || '?'} - $${listing.price || '?'} - ${listing.title}`)
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    source: 'facebook',
    inserted: res.inserted,
    updated: res.updated,
    newListings: res.newListingIds.length,
    newListingIds: res.newListingIds
  }))

  return { inserted: res.inserted, updated: res.updated }
}

async function main() {
  if (!FB_MULTI_REGION) {
    // Single region mode - run once
    const radiusMeters = parseInt(process.env.FB_REGION_RADIUS_METERS || '16000', 10);
    await scrapeRegion(undefined, radiusMeters)
    return
  }

  // Multi-region mode
  console.log('\n' + '='.repeat(70))
  console.log('[MULTI-REGION] Facebook Marketplace Multi-Region Scraper')
  console.log('='.repeat(70))
  console.log(`Regions: ${FB_REGION_COUNT}`)
  console.log(`Delay between regions: ${FB_REGION_DELAY_MS}ms`)
  console.log('='.repeat(70) + '\n')

  const regionsToScrape = SOCAL_REGIONS.slice(0, FB_REGION_COUNT)
  const startTime = Date.now()
  const results: Array<{ region: string; inserted: number; updated: number }> = []

  for (let i = 0; i < regionsToScrape.length; i++) {
    const region = regionsToScrape[i]
    console.log(`\n[${ i + 1}/${FB_REGION_COUNT}] Scraping: ${region.name}`)
    console.log('─'.repeat(70))

    // Override OU_LAT/OU_LNG for this region (used in dom_chrono mode)
    process.env.OU_LAT = region.lat.toString()
    process.env.OU_LNG = region.lng.toString()

    try {
      // PASS THE RADIUS HERE:
      // Note: We use 16000 meters (10 miles) as defined in your prompt/env
      const radiusMeters = parseInt(process.env.FB_REGION_RADIUS_METERS || '16000', 10);
      
      const stats = await scrapeRegion(region.name, radiusMeters)
      results.push({
        region: region.name,
        inserted: stats.inserted,
        updated: stats.updated,
      })
    } catch (err) {
      console.error(`[MULTI-REGION] Error scraping ${region.name}:`, err)
      results.push({
        region: region.name,
        inserted: 0,
        updated: 0,
      })
    }

    // Delay before next region (except for last)
    if (i < regionsToScrape.length - 1) {
      console.log(`\n[MULTI-REGION] Waiting ${FB_REGION_DELAY_MS / 1000}s before next region...\n`)
      await new Promise(resolve => setTimeout(resolve, FB_REGION_DELAY_MS))
    }
  }

  // Summary
  const endTime = Date.now()
  const durationSec = Math.round((endTime - startTime) / 1000)
  const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0)
  const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0)

  console.log('\n' + '='.repeat(70))
  console.log('[MULTI-REGION] SUMMARY')
  console.log('='.repeat(70))
  console.log(`Duration: ${durationSec}s (${Math.floor(durationSec / 60)}m ${durationSec % 60}s)`)
  console.log(`Regions scraped: ${results.length}/${FB_REGION_COUNT}`)
  console.log(`Total inserted: ${totalInserted}`)
  console.log(`Total updated: ${totalUpdated}`)
  console.log('='.repeat(70))

  console.log('\nResults by region:')
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.region.padEnd(20)} (+${r.inserted} ~${r.updated})`)
  })

  console.log('\n[MULTI-REGION] All regions processed!')
}

// CLI
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => { console.error('[FB] Failed:', e); process.exit(1) })
}
