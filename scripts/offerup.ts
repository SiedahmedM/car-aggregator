// scripts/offerup.ts
import { chromium, Page } from 'playwright';
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

// ---------- Structured logging ----------
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVEL = (process.env.OU_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
function log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const currentIdx = order.indexOf(LOG_LEVEL);
  const levelIdx = order.indexOf(level);
  if (levelIdx < currentIdx) return;
  if (meta && Object.keys(meta).length) {
    console.log(`[${level.toUpperCase()}] ${msg}`, meta);
  } else {
    console.log(`[${level.toUpperCase()}] ${msg}`);
  }
}
const logDebug = (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta);
const logInfo = (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta);
const logWarn = (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta);
const logError = (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta);

// ---------- Env knobs ----------
// Note: legacy OFFERUP_URL is ignored; we now rely solely on GraphQL active feed.
// Item cap (increased from 60 to 800 for better coverage/recency mining)
const MAX_ITEMS = parseInt(process.env.OU_MAX_ITEMS || '800', 10);
// UI scroll passes removed
const HEADLESS = (process.env.OU_HEADLESS ?? 'true').toLowerCase() === 'true';

// Multi-region configuration
const OU_MULTI_REGION = (process.env.OU_MULTI_REGION ?? '0') === '1';
const OU_REGION_COUNT = parseInt(process.env.OU_REGION_COUNT || '6', 10);
const OU_REGION_DELAY_MS = parseInt(process.env.OU_REGION_DELAY_MS || '5000', 10);

// Major regions for multi-region scraping (Southern California + Arizona + Nevada - within ~500mi of LA)
const US_REGIONS = [
  { name: 'Los Angeles, CA', lat: 34.0522, lng: -118.2437 },
  { name: 'Orange County, CA', lat: 33.7175, lng: -117.8311 },
  { name: 'San Diego, CA', lat: 32.7157, lng: -117.1611 },
  { name: 'Las Vegas, NV', lat: 36.1699, lng: -115.1398 },
  { name: 'San Francisco, CA', lat: 37.7749, lng: -122.4194 },
  { name: 'Phoenix, AZ', lat: 33.4484, lng: -112.0740 },
  { name: 'Scottsdale, AZ', lat: 33.4942, lng: -111.9261 },
];

// Location (will be overridden in multi-region mode)
let LAT = Number(process.env.OU_LAT ?? '33.8166');
let LNG = Number(process.env.OU_LNG ?? '-118.0373');
let RADIUS = parseInt(process.env.OU_RADIUS_MILES || '35', 10);

// DEBUG: Log loaded coordinates immediately
console.log('[DEBUG] Loaded coordinates from environment:');
console.log('  OU_LAT =', LAT, '(from env:', process.env.OU_LAT, ')');
console.log('  OU_LNG =', LNG, '(from env:', process.env.OU_LNG, ')');
console.log('  OU_RADIUS_MILES =', RADIUS);
console.log('  OU_MULTI_REGION =', OU_MULTI_REGION);
if (OU_MULTI_REGION) {
  console.log('  OU_REGION_COUNT =', OU_REGION_COUNT);
  console.log('  OU_REGION_DELAY_MS =', OU_REGION_DELAY_MS);
}
const DETAIL_CONCURRENCY = Math.min(3, parseInt(process.env.OU_DETAIL_CONCURRENCY || '3', 10) || 3);
const PAGINATE_PAGES = parseInt(process.env.OU_PAGINATE_PAGES || '20', 10);
// UI/scroll/mobile fallbacks removed entirely

// ---------- Optional filter knobs (applied before upsert) ----------
// These allow the script to be driven by saved-search parameters.
const F_MIN_YEAR = parseInt(process.env.OU_FILTER_MIN_YEAR || '', 10) || null;
const F_MAX_YEAR = parseInt(process.env.OU_FILTER_MAX_YEAR || '', 10) || null;
const F_MIN_PRICE = parseInt(process.env.OU_FILTER_MIN_PRICE || '', 10) || null;
const F_MAX_PRICE = parseInt(process.env.OU_FILTER_MAX_PRICE || '', 10) || null;
const F_MIN_MILEAGE = parseInt(process.env.OU_FILTER_MIN_MILEAGE || '', 10) || null;
const F_MAX_MILEAGE = parseInt(process.env.OU_FILTER_MAX_MILEAGE || '', 10) || null;
const F_MODELS = (process.env.OU_FILTER_MODELS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const F_MAKES = (process.env.OU_FILTER_MAKES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// Hours ago window, e.g. 24 means only posted within last 24h
// No default; only filter by hours when explicitly provided
const F_POSTED_WITHIN_HOURS = parseInt(process.env.OU_FILTER_POSTED_WITHIN_HOURS || '', 10) || null;

// DEBUG: Log filter settings
console.log('[DEBUG] Filter settings:');
console.log('  F_MAKES =', F_MAKES.length ? F_MAKES : 'NONE (allows all makes)');
console.log('  F_MODELS =', F_MODELS.length ? F_MODELS : 'NONE (allows all models)');
console.log('  F_POSTED_WITHIN_HOURS =', F_POSTED_WITHIN_HOURS || 'NONE');

// Desktop Chrome on macOS (force everywhere)
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- Helpers ----------
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min=200, max=450) { return Math.floor(Math.random()*(max-min+1))+min; }
function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
  return out;
}

// ---- GraphQL tapping & dumps -------------------------------------------
const TAP_GQL = (process.env.OU_TAP_GQL ?? 'true').toLowerCase() === 'true';
const GQL_DUMP_LIMIT = parseInt(process.env.OU_GQL_DUMP_LIMIT || '5', 10);
const GQL_LOG_NONFEED = (process.env.OU_GQL_LOG_NONFEED ?? 'true').toLowerCase() === 'true';

function tryParseJSON(s: string): any | null { try { return JSON.parse(s); } catch { return null; } }

// ---------- Hardened fetch helper ----------
async function safeJsonFetch(url: string, init: RequestInit & { context?: string } = {}) {
  const ctx = init.context || 'unknown';
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    logError('[FETCH] network error', { ctx, url, error: (e as Error).message });
    return { ok: false as const, status: 0, json: null as any };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logError('[FETCH] non-OK status', {
      ctx,
      url,
      status: resp.status,
      preview: text.slice(0, 200),
    });
    return { ok: false as const, status: resp.status, json: null as any };
  }
  const text = await resp.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return { ok: true as const, status: resp.status, json };
  } catch (e) {
    logError('[FETCH] JSON parse error', {
      ctx,
      url,
      status: resp.status,
      preview: text.slice(0, 200),
      error: (e as Error).message,
    });
    return { ok: false as const, status: resp.status, json: null as any };
  }
}

// Minimal client-trigger scroll removed; no DOM scroll used

// ----- Active Feed (GraphQL) helpers -----
type ModularFeedBody = {
  data?: {
    modularFeed?: {
      looseTiles?: any[];
      items?: any[];
      pageCursor?: string | null;
      nextCursor?: string | null;
    }
  }
};

function extractTilesAndCursorFromModularFeed(b: any): { tiles: any[]; cursor: string | null } {
  try {
    const mf = b?.data?.modularFeed;
    if (!mf) return { tiles: [], cursor: null };
    const loose = Array.isArray(mf.looseTiles) ? mf.looseTiles : [];
    const items = Array.isArray(mf.items) ? mf.items : [];
    const tiles = [...loose, ...items];
    const cursor = mf.nextCursor ?? mf.pageCursor ?? null;
    return { tiles, cursor };
  } catch {
    return { tiles: [], cursor: null };
  }
}

async function fetchActiveFeedPages(
  baseUrl: string,
  headers: Record<string,string>,
  searchParams: { key: string; value: string }[],
  maxPages: number
): Promise<ModularFeedBody[]> {
  const bodies: ModularFeedBody[] = [];
  const basePayload = {
    operationName: 'GetModularFeed',
    variables: { debug: false, searchParams },
    query: null as any,
  };
  let cursor: string | null = null;
  let pagesFetched = 0;
  while (pagesFetched < maxPages) {
    const payload: any = { ...basePayload, variables: { ...basePayload.variables } };
    const params = Array.isArray(payload.variables.searchParams) ? [...payload.variables.searchParams] : [];
    for (let i = params.length - 1; i >= 0; i--) {
      const k = String(params[i]?.key || '').toLowerCase();
      if (k.includes('cursor')) params.splice(i, 1);
    }
    if (cursor) params.push({ key: 'cursor', value: cursor });
    payload.variables.searchParams = params;

    const r = await safeJsonFetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(payload), context: 'active-pages' });
    if (!r.ok) break;
    const json = r.json;
    if (!json || !json.data || !json.data.modularFeed) break;
    bodies.push(json);
    pagesFetched++;
    const mf = json.data.modularFeed;
    const srf = (json.data as any)?.searchFeedResponse;
    const next = mf?.nextCursor ?? mf?.pageCursor ?? srf?.nextCursor ?? srf?.pageCursor ?? null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return bodies;
}

async function fetchActiveFeedPagesFromSaved(maxPages: number): Promise<ModularFeedBody[]> {
  const bodies: ModularFeedBody[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;

  let savedRaw: string | null = null;
  try {
    savedRaw = await fs.readFile('offerup_gql_feed_req.json', 'utf8');
  } catch {
    return bodies;
  }
  if (!savedRaw) return bodies;

  const saved = JSON.parse(savedRaw) as {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData: string;
  };

  const baseHeaders = { ...(saved.headers || {}) } as Record<string, string>;
  delete (baseHeaders as any)['content-length'];
  delete (baseHeaders as any)['accept-encoding'];

  const originalBody = JSON.parse(saved.postData || '{}');
  if (!originalBody || !originalBody.variables) return bodies;

  while (pagesFetched < maxPages) {
    const body = JSON.parse(JSON.stringify(originalBody));
    const params: any[] = Array.isArray(body?.variables?.searchParams)
      ? body.variables.searchParams
      : [];

    for (let i = params.length - 1; i >= 0; i--) {
      const k = String(params[i]?.key || '').toLowerCase();
      if (k.includes('cursor')) params.splice(i, 1);
    }
    const cap = Math.max(50, Math.min(200, Number(process.env.OU_MAX_ITEMS || '200')));
    const li = params.findIndex((p: any) => String(p?.key || '').toUpperCase() === 'LIMIT');
    if (li >= 0) params[li].value = String(cap); else params.push({ key: 'LIMIT', value: String(cap) });

    // Enforce sort by newest if possible
    const sortIdx = params.findIndex((p: any) => String(p?.key || '').toLowerCase() === 'sort');
    if (sortIdx >= 0) params[sortIdx].value = '-posted';
    else params.push({ key: 'sort', value: '-posted' });

    if (cursor) params.push({ key: 'PAGE_CURSOR', value: cursor });
    body.variables.searchParams = params;

    const r = await safeJsonFetch(saved.url, {
      method: saved.method || 'POST',
      headers: baseHeaders,
      body: JSON.stringify(body),
      context: 'active-saved-pages',
    });
    if (!r.ok) break;

    const json = r.json as ModularFeedBody | null;
    if (!json) break;

    const { tiles, cursor: next } = extractTilesAndCursorFromModularFeed(json);
    if (!tiles.length) break;

    bodies.push(json);
    pagesFetched++;
    cursor = next;
    if (!cursor) break;
  }

  return bodies;
}

// Vehicle make/model dictionary for parsing from titles
const VEHICLE_DICTIONARY: { makes: Record<string, string[]> } = {
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
    "porsche": ["cayenne","macan","911","boxster","cayman","panamera","taycan"],
    "jaguar": ["xf","xe","f-type","f-pace","e-pace"],
    "mini": ["cooper","countryman"],
    // Ultra-Luxury & Exotic Brands
    "lamborghini": ["aventador","huracan","urus","gallardo","murcielago","revuelto","countach","diablo","sian","centenario","veneno","reventon","jalpa","lm002"],
    "ferrari": ["488","458","f430","california","portofino","812","f8","sf90","roma","296","laferrari","enzo","f50","f40","288","gtc4","lusso","ff","scuderia","pista","superfast","tdf","daytona","monza"],
    "rolls royce": ["phantom","ghost","wraith","cullinan","dawn","spectre","corniche","camargue","silver shadow","silver spirit","silver spur","silver seraph"],
    "bentley": ["continental","flying spur","bentayga","mulsanne","arnage","azure","brooklands","bacalar","batur"],
    "aston martin": ["db9","db11","vantage","dbs","rapide","vanquish","valkyrie","valhalla","one-77","vulcan","dbx","virage","lagonda","cygnet"],
    "maserati": ["ghibli","quattroporte","levante","granturismo","grancabrio","mc20","mc12","grecale"],
    "mclaren": ["720s","570s","650s","540c","600lt","gt","artura","p1","senna","speedtail","elva","765lt","675lt","12c","f1","solus"],
    "bugatti": ["veyron","chiron","divo","centodieci","mistral","bolide","eb110"],
    "lotus": ["elise","exige","evora","emira","eletre","evija","esprit"],
    "alfa romeo": ["giulia","stelvio","4c","8c","33 stradale"],
    "maybach": ["s class","gls","57","62","zeppelin","exelero"],
    "koenigsegg": ["agera","regera","jesko","gemera","one:1","ccx","ccxr","cc8s"],
    "pagani": ["zonda","huayra","utopia","codalunga"],
    "rimac": ["nevera","concept_one"],
    "hennessey": ["venom"],
    "ssc": ["tuatara","ultimate aero"],
    "spyker": ["c8","d12","d8"],
    "fisker": ["karma","ocean"],
    "karma": ["revero","gs-6"],
    "lucid": ["air","gravity"],
    "rivian": ["r1t","r1s"],
    "polestar": ["1","2","3","4","5","6"],
    "alpina": ["b7","b8","xb7","b3","b4","b5","d3","d4","d5","xd3","xd4"],
    "brabus": ["rocket","800","900","700"],
    "mansory": ["cullinan","urus","g-class"],
    "ruf": ["ctr","rgt","scr"],
    "singer": ["911","dls"],
    "gunther werks": ["400r"],
    "saleen": ["s7"],
    "zenvo": ["tsr","ts1","st1"],
    "noble": ["m600","m400","m12"],
    "gumpert": ["apollo"],
    "w motors": ["lykan","fenyr"],
    "delorean": ["dmc-12","alpha5"],
    "shelby": ["cobra","series 1"]
  }
};

function parseModelFromTitle(title?: string | null): { year: number | null; make: string | null; model: string | null } {
  if (!title) return { year: null, make: null, model: null };
  let s = title.toLowerCase();
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract year
  let year: number | null = null;
  const ym = s.match(/\b(19|20)\d{2}\b/);
  if (ym) {
    const y = parseInt(ym[0], 10);
    if (y >= 1950 && y <= 2100) year = y;
  }

  // Detect make
  const makes = Object.keys(VEHICLE_DICTIONARY.makes);
  let make: string | null = null;
  for (const mk of makes) {
    if (s.startsWith(mk + ' ') || s === mk || s.includes(' ' + mk + ' ')) { make = mk; break; }
  }
  if (!make) {
    for (const mk of makes) { if (s.includes(mk)) { make = mk; break; } }
  }

  // Detect model
  let model: string | null = null;
  const tryModels = (mk: string) => {
    const list = VEHICLE_DICTIONARY.makes[mk] || [];
    // choose the longest match present in title
    let best: string | null = null;
    for (const m of list) {
      if (s.includes(' ' + m + ' ') || s.endsWith(' ' + m) || s.startsWith(m + ' ') || s === m) {
        if (!best || m.length > best.length) best = m;
      }
    }
    return best;
  };
  if (make) {
    model = tryModels(make) || null;

    // Fallback: If model not found in dictionary, try to extract it from the title
    if (!model) {
      // Remove year and make from the title to get remaining tokens
      const withoutYear = s.replace(/\b(19|20)\d{2}\b/, '').trim();
      const makeIndex = withoutYear.indexOf(make);
      if (makeIndex !== -1) {
        const afterMake = withoutYear.substring(makeIndex + make.length).trim();
        // Extract first meaningful token(s) after make
        // Handle patterns like: "benz e class", "e class", "civic", "3 series"
        const modelMatch = afterMake.match(/^([a-z0-9]+(?:\s+[a-z0-9]+)?)\b/);
        if (modelMatch) {
          const extracted = modelMatch[1].trim();
          // Filter out common non-model words
          const skipWords = ['benz', 'for', 'sale', 'auto', 'car', 'vehicle', 'sedan', 'coupe', 'suv'];
          if (!skipWords.includes(extracted.split(' ')[0])) {
            // For "benz e class", skip "benz" and get "e class"
            if (make === 'mercedes' && extracted.startsWith('benz ')) {
              const afterBenz = extracted.substring(5).trim();
              if (afterBenz) model = afterBenz;
            } else {
              model = extracted;
            }
          }
        }
      }
    }
  } else {
    // dictionary-wide fallback
    for (const mk of makes) {
      const best = tryModels(mk);
      if (best) { make = mk; model = best; break; }
    }
  }
  // Gate [MODEL-PARSE] spam: only log in debug, matches filters, or incomplete
  const wantedMakes = F_MAKES.map(m => m.toLowerCase());
  const wantedModels = F_MODELS.map(m => m.toLowerCase());
  const matchesWanted =
    (wantedMakes.length === 0 || (make && wantedMakes.includes(make.toLowerCase()))) &&
    (wantedModels.length === 0 || (model && wantedModels.includes((model as string).toLowerCase())));
  const shouldLogModelParse =
    LOG_LEVEL === 'debug' || !make || !model || matchesWanted;
  if (shouldLogModelParse) {
    try { logDebug('[MODEL-PARSE]', { year, make, model, title }); } catch {}
  }
  return { year, make, model };
}

function parseCarTitleOrNull(title?: string | null): { year: number | null; make: string | null; model: string | null; title: string } {
  const parsed = parseModelFromTitle(title || null);
  return { year: parsed.year, make: parsed.make, model: parsed.model, title: title || '' };
}

// --- GraphQL next-page fetch using saved request (APQ-safe) --------------
async function gqlFetchNextPageFromSaved(cursor: string): Promise<any | null> {
  try {
    const raw = await fs.readFile('offerup_gql_feed_req.json', 'utf8');
    const saved = JSON.parse(raw) as { url: string; method: string; headers: Record<string,string>; postData: string; };
    const headers = { ...(saved.headers || {}) } as Record<string,string>;
    delete (headers as any)['content-length'];
    delete (headers as any)['accept-encoding'];
    const body = JSON.parse(saved.postData || '{}');
    const params: any[] = Array.isArray(body?.variables?.searchParams) ? body.variables.searchParams : [];
    for (let i = params.length - 1; i >= 0; i--) {
      const k = String(params[i]?.key || '').toLowerCase();
      if (k.includes('cursor')) params.splice(i, 1);
    }
    // No server-side recency filters; recency is enforced client-side during detail phase
    params.push({ key: 'PAGE_CURSOR', value: cursor });
    body.variables = body.variables || {};
    body.variables.searchParams = params;
    const r = await safeJsonFetch(saved.url, { method: saved.method || 'POST', headers, body: JSON.stringify(body), context: 'active-next' });
    if (!r.ok) return null;
    return r.json;
  } catch {
    return null;
  }
}

// Initial GraphQL fetch from saved request body, sanitized (no server-side recency)
async function gqlFetchInitialPageFromSaved(): Promise<any | null> {
  try {
    const raw = await fs.readFile('offerup_gql_feed_req.json', 'utf8');
    const saved = JSON.parse(raw) as { url: string; method: string; headers: Record<string,string>; postData: string; };
    const headers = { ...(saved.headers || {}) } as Record<string,string>;
    delete (headers as any)['content-length'];
    delete (headers as any)['accept-encoding'];
    const body = JSON.parse(saved.postData || '{}');
    const params: any[] = Array.isArray(body?.variables?.searchParams) ? [...body.variables.searchParams] : [];

    // Remove cursors and any posted_* keys (no server-side recency)
    for (let i = params.length - 1; i >= 0; i--) {
      const k = String(params[i]?.key || '').toLowerCase();
      if (k.includes('cursor')) params.splice(i, 1);
      if (k.startsWith('posted')) params.splice(i, 1);
    }
    // Ensure q from makes/models
    const qParts: string[] = [];
    if (F_MAKES.length) qParts.push(...F_MAKES);
    if (F_MODELS.length) qParts.push(...F_MODELS);
    const q = qParts.join(' ').trim();
    if (q) {
      for (let i = params.length - 1; i >= 0; i--) {
        if (String(params[i]?.key || '').toLowerCase() === 'q') params.splice(i, 1);
      }
      params.push({ key: 'q', value: q });
    }
    // Ensure location and limit
    const ensureKV = (key: string, value: string) => {
      const idx = params.findIndex(p => String(p?.key || '').toLowerCase() === key.toLowerCase());
      if (idx >= 0) params[idx] = { key, value }; else params.push({ key, value });
    };
    ensureKV('lat', String(LAT));
    ensureKV('lon', String(LNG));
    ensureKV('radius', String(RADIUS));
    ensureKV('limit', String(Math.min(MAX_ITEMS, 50)));

    body.variables = body.variables || {};
    body.variables.searchParams = params;
    const r = await safeJsonFetch(saved.url, { method: saved.method || 'POST', headers, body: JSON.stringify(body), context: 'active-initial' });
    if (!r.ok) return null;
    return r.json;
  } catch {
    return null;
  }
}

// Manually request the primary OfferUp search feed (page 1), APQ-safe:
// reuse the saved GraphQL body (operationName/query/extensions) and only
// adjust variables.searchParams (strip cursors, set LIMIT).
// fetchInitialSearchFeed removed (GraphQL no longer used)

// ---------- Run stats ----------
const RUN_STATS = {
  feedIntercepted: 0,
  feedInjected: 0,
  wrongFeedSkipped: 0,
  similarSkipped: 0,
  uiInteractions: 0,
  modelSrc: { title: 0, details: 0, jsonld: 0, nextdata: 0 },
  postedSrc: { timeTag: 0, jsonld: 0, nextdata: 0, relative: 0, missing: 0 },
  filterHintsReady: 0,
  postedRejected: 0 as number,
  postedKept: 0 as number,
  missingTimestamp: 0 as number,
};

// ---------- Fast detail helpers (bounded waits, JSON fallbacks) ----------
const DETAIL_SELECTOR_TIMEOUT_MS = parseInt(process.env.OU_DETAIL_SELECTOR_TIMEOUT_MS || '4000', 10);

// Filter hints discovered from the first feed response (modular feed filters)
type FilterHints = {
  price: { minKey: string; maxKey: string } | null;
  year: { minKey: string; maxKey: string } | null;
  mileageBands: number[]; // ascending numeric bands
  makeOptions: { value: string; label: string }[];
  sortOptions?: string[];
};
const FILTER_HINTS: FilterHints = {
  price: null,
  year: null,
  mileageBands: [],
  makeOptions: [],
  sortOptions: [],
};
const DEFAULT_FILTER_KEYS = {
  priceMin: 'PRICE_MIN',
  priceMax: 'PRICE_MAX',
  yearMin: 'VEH_YEAR_MIN',
  yearMax: 'VEH_YEAR_MAX',
  mileage: 'VEH_MILEAGE',
};
const DEFAULT_MILEAGE_BANDS = [0, 25000, 50000, 75000, 100000, 125000, 150000, 175000, 200000];

function resetFilterHints() {
  FILTER_HINTS.price = null;
  FILTER_HINTS.year = null;
  FILTER_HINTS.mileageBands = [];
  FILTER_HINTS.makeOptions = [];
  FILTER_HINTS.sortOptions = [];
}

function hydrateFilterHintsFromBody(body: any) {
  try {
    const filters = body?.data?.modularFeed?.filters;
    if (!Array.isArray(filters)) return;
    for (const filter of filters) {
      const target = String(filter?.targetName || '').toUpperCase();
      if (target === 'PRICE' && !FILTER_HINTS.price) {
        const minKey = filter?.lowerBound?.targetName || DEFAULT_FILTER_KEYS.priceMin;
        const maxKey = filter?.upperBound?.targetName || DEFAULT_FILTER_KEYS.priceMax;
        if (minKey && maxKey) FILTER_HINTS.price = { minKey, maxKey };
      } else if (target === 'VEH_YEAR' && !FILTER_HINTS.year) {
        const minKey = filter?.lowerBound?.targetName || DEFAULT_FILTER_KEYS.yearMin;
        const maxKey = filter?.upperBound?.targetName || DEFAULT_FILTER_KEYS.yearMax;
        if (minKey && maxKey) FILTER_HINTS.year = { minKey, maxKey };
      } else if (target === 'VEH_MILEAGE' && !FILTER_HINTS.mileageBands.length) {
        const options = Array.isArray(filter?.options) ? filter.options : [];
        const bands = options
          .map((opt: any) => Number(opt?.value))
          .filter((n: number) => Number.isFinite(n))
          .sort((a: number, b: number) => a - b);
        if (bands.length) FILTER_HINTS.mileageBands = bands;
      } else if (target === 'VEH_MAKE' && !FILTER_HINTS.makeOptions.length) {
        const options = Array.isArray(filter?.options) ? filter.options : [];
        FILTER_HINTS.makeOptions = options
          .map((opt: any) => ({
            value: typeof opt?.value === 'string' ? opt.value : '',
            label: typeof opt?.label === 'string' ? opt.label.toLowerCase() : '',
          }))
          .filter((opt: { value: string; label: string }) => opt.value && opt.label);
      }
    }
  } catch {}
}

function resolveMileageBand(maxMileage: number | null): string | null {
  if (maxMileage == null) return null;
  const bands = FILTER_HINTS.mileageBands.length ? FILTER_HINTS.mileageBands : DEFAULT_MILEAGE_BANDS;
  const match = bands.find((band) => band >= maxMileage);
  if (typeof match === 'number') return String(match);
  if (bands.length) return String(bands[bands.length - 1]);
  return null;
}
const LAST_INJECTED: { mileageBand?: number } = {};

// Short, bounded selector wait to avoid long locator hangs
async function getTextFast(page: Page, selector: string, timeout = DETAIL_SELECTOR_TIMEOUT_MS): Promise<string|null> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'attached', timeout });
    return await loc.evaluate((el: Element) => el.textContent);
  } catch {
    return null;
  }
}

async function getJsonLd(page: Page): Promise<any[]> {
  try {
    const loc = page.locator('script[type="application/ld+json"]');
    const count = await loc.count().catch(() => 0);
    const out: any[] = [];
    for (let i=0;i<count;i++) {
      const raw = await loc.nth(i).textContent().catch(() => null);
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch {}
    }
    return out;
  } catch { return []; }
}

// Opportunistic scan of __NEXT_DATA__ for price-like fields
async function getNextData(page: Page): Promise<any|null> {
  const raw = await page.locator('#__NEXT_DATA__').first().textContent().catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Extract seller information to detect dealers
function extractSellerInfo(jsonLd: any[], nd: any): {
  isDealer: boolean;
  sellerName?: string | null;
  businessName?: string | null;
  truYouVerified?: boolean;
} | null {
  // Common dealer keywords (expanded)
  const isDealerName = (name: string | null | undefined) => {
    if (!name) return false;
    const n = name.toLowerCase();
    return [
      'auto','autos','motor','motors','motorsports','sale','sales','deal','dealer','dealership',
      'llc','inc','group','export','imports','cars','car','truck','trucks','fleet','wholesale',
      'finance','credit','leasing','lease','rent','rental','rentals','showroom','corp','corporation',
      'autonation','drivetime','carmax','carvana','carshop','carfax','autocenter','automall',
      'toyota','honda','ford','chevy','chevrolet','nissan','gmc','cadillac','kia','hyundai',
      'bmw','mercedes','benz','audi','vw','volkswagen','subaru','mazda','lexus','acura','infiniti','dodge','jeep','ram'
    ].some(k => n.includes(k));
  };

  const listing = nd?.props?.pageProps?.listing;
  const seller = listing?.seller;

  // Try __NEXT_DATA__ first (most reliable source)
  if (seller) {
    // Strong dealer signals from structured flags
    const dealerSignals = [
      seller.isBusiness,
      seller.isDealer,
      seller.dealer,
      seller.dealerId,
      seller.dealerName,
      seller.businessId,
      seller.businessName,
      seller.businessProfileImage,
      seller.storefrontId,
      seller.storefrontName,
      seller.storefrontUrl,
      listing?.dealerId,
      listing?.dealerName,
      listing?.dealer,
      listing?.businessId,
      listing?.businessName,
      listing?.business?.id,
      listing?.business?.name,
      listing?.storefrontId,
      listing?.storefrontName,
      (typeof seller.accountCategory === 'string' && seller.accountCategory.toLowerCase().includes('business')),
      (typeof seller.userType === 'string' && seller.userType.toLowerCase().includes('business')),
      (typeof seller.sellerType === 'string' && seller.sellerType.toLowerCase().includes('business')),
      (typeof seller.role === 'string' && seller.role.toLowerCase().includes('business')),
      (typeof seller.badge === 'string' && seller.badge.toLowerCase().includes('dealer')),
      (Array.isArray(seller.badges) && seller.badges.some((b: any) => String(b).toLowerCase().includes('dealer'))),
      (Array.isArray(seller.tags) && seller.tags.some((t: any) => String(t).toLowerCase().includes('dealer'))),
      (typeof listing?.listingType === 'string' && listing.listingType.toLowerCase().includes('dealer')),
      (typeof listing?.sellerType === 'string' && listing.sellerType.toLowerCase().includes('business')),
      (typeof listing?.userType === 'string' && listing.userType.toLowerCase().includes('business')),
      (typeof listing?.accountCategory === 'string' && listing.accountCategory.toLowerCase().includes('business')),
      (typeof listing?.badge === 'string' && listing.badge.toLowerCase().includes('dealer')),
      (Array.isArray(listing?.badges) && listing.badges.some((b: any) => String(b).toLowerCase().includes('dealer'))),
      (Array.isArray(listing?.tags) && listing.tags.some((t: any) => String(t).toLowerCase().includes('dealer')))
    ];

    const candidateNames = [
      seller.name,
      seller.businessName,
      seller.dealerName,
      seller.storefrontName,
      listing?.dealerName,
      listing?.businessName,
      listing?.storefrontName,
      listing?.business?.name,
      listing?.sellerName
    ];

    const nameHeuristic = candidateNames.some(n => isDealerName(n || ''));

    const isDealer = dealerSignals.some(Boolean) || nameHeuristic;
    return {
      isDealer,
      sellerName: seller.name || listing?.sellerName || null,
      businessName:
        listing?.businessName ||
        listing?.dealerName ||
        listing?.storefrontName ||
        seller.businessName ||
        seller.dealerName ||
        seller.storefrontName ||
        (isDealer ? seller.name || listing?.sellerName || null : null),
      truYouVerified: seller.truYouVerified || false,
    };
  }

  // Fallback: Try JSON-LD structured data
  for (const struct of jsonLd) {
    const seller = struct?.seller;
    if (seller) {
      const isOrg = seller['@type'] === 'Organization' ||
                    seller['@type'] === 'AutoDealer' ||
                    seller['@type'] === 'LocalBusiness';
      const name = seller.name || '';
      const nameHeuristic = isDealerName(name);
      
      const isDealer = isOrg || !!seller.businessName || nameHeuristic;
      return {
        isDealer,
        sellerName: seller.name || null,
        businessName: seller.businessName || null,
        truYouVerified: false,
      };
    }
  }

  return null;
}

function extractPriceFromStructures(structs: any[]): number|null {
  const tryNum = (v: any): number|null => {
    if (v == null) return null;
    const s = String(v);
    const n = Number(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  for (const j of structs) {
    const candList = [
      (j as any)?.offers?.price,
      (Array.isArray((j as any)?.offers) ? (j as any).offers[0]?.price : undefined),
      (j as any)?.price,
      (j as any)?.itemOffered?.price
    ];
    for (const c of candList) {
      const n = tryNum(c);
      if (n != null) return n;
    }
    if (j && typeof j === 'object') {
      for (const v of Object.values(j)) {
        if (v && typeof v === 'object') {
          const nested = extractPriceFromStructures([v]);
          if (nested != null) return nested;
        }
      }
    }
  }
  return null;
}

function slugFromUrl(url: string): string|null {
  return url.match(/\/item\/detail\/([^/?#]+)/)?.[1] || null;
}

function extractListingIdFromNextData(nd: any): string|null {
  if (!nd || typeof nd !== 'object') return null;
  const stack: any[] = [nd];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      if ((cur as any).listingId || (cur as any).id) {
        const val = String((cur as any).listingId ?? (cur as any).id);
        if (val) return val;
      }
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}
function extractYearFromStructures(structs: any[]): number|null {
  const tryYear = (val: any): number|null => {
    if (val == null) return null;
    const s = String(val);
    const m = s.match(/\b(19|20)\d{2}\b/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return (n >= 1950 && n <= 2100) ? n : null;
  };
  for (const j of structs) {
    const candidates = [
      (j as any)?.vehicle?.modelDate, (j as any)?.vehicleModelDate, (j as any)?.modelDate,
      (j as any)?.productionDate, (j as any)?.dateManufactured, (j as any)?.itemOffered?.modelDate,
      (j as any)?.itemOffered?.productionDate, (j as any)?.year
    ];
    for (const c of candidates) {
      const yr = tryYear(c);
      if (yr != null) return yr;
    }
    if (j && typeof j === 'object') {
      for (const v of Object.values(j)) {
        if (v && typeof v === 'object') {
          const nested = extractYearFromStructures([v]);
          if (nested != null) return nested;
        }
      }
    }
  }
  return null;
}

function extractYearFromNextData(nd: any): number|null {
  if (!nd || typeof nd !== 'object') return null;
  const stack: any[] = [nd];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const key of ['vehicleYear', 'modelYear', 'year']) {
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        const val = (cur as any)[key];
        const m = String(val).match(/\b(19|20)\d{2}\b/);
        if (m) {
          const n = parseInt(m[0], 10);
          if (n >= 1950 && n <= 2100) return n;
        }
      }
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}
function extractMileageFromStructures(structs: any[]): number|null {
  for (const j of structs) {
    // JSON-LD commonly uses mileageFromOdometer
    const cand = j?.mileageFromOdometer?.value ?? j?.mileage ?? j?.itemOffered?.mileageFromOdometer?.value;
    if (cand != null) {
      const n = Number(String(cand).replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) return Math.trunc(n);
    }
    if (j && typeof j === 'object') {
      for (const v of Object.values(j)) {
        if (v && typeof v === 'object') {
          const nested = extractMileageFromStructures([v]);
          if (nested != null) return nested;
        }
      }
    }
  }
  return null;
}

function extractPostedAtFromNextData(nd: any, remoteId?: string): string|null {
  if (!nd || typeof nd !== 'object') return null;
  // Prefer nodes with matching id/slug
  const preferStack: any[] = [nd];
  while (preferStack.length) {
    const cur = preferStack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const hasId =
      (remoteId && (cur as any)?.listingId === remoteId) ||
      (remoteId && (cur as any)?.id === remoteId) ||
      (remoteId && typeof (cur as any)?.slug === 'string' && (cur as any).slug.includes(remoteId));
    if (hasId) {
      const getStr = (k: string) => (cur as any)[k];
      const stringTs =
        getStr('createdAt') || getStr('postedAt') || getStr('createdDate') ||
        getStr('datePosted') || getStr('datePublished') || getStr('dateCreated');
      if (typeof stringTs === 'string') {
        const d = new Date(stringTs);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
      for (const k of ['createdAtMs','postedDateMs','createdTimeMs','timestamp']) {
        const n = (cur as any)[k];
        if (typeof n === 'number') {
          const d = new Date(n);
          if (!isNaN(d.getTime())) return d.toISOString();
        }
      }
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') preferStack.push(v);
  }
  // Fallback generic scan
  const stack: any[] = [nd];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === 'string' && /(created|posted|publish).*(at|time|date|timestamp)/i.test(k)) {
        const d = new Date(v as string);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
      if (typeof v === 'number' && /(created|posted|publish).*(ms|time|timestamp)/i.test(k)) {
        const d = new Date(v as number);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function extractPostedAtFromJsonLd(structs: any[]): string | null {
  for (const j of structs) {
    const obj = (j as any) || {};
    const item = obj.itemOffered || obj;
    const strKeys = ['datePublished','datePosted','dateCreated','createdAt','postedAt','createdDate'];
    for (const k of strKeys) {
      const v = (item as any)[k] ?? (obj as any)[k];
      if (typeof v === 'string') {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
    const numKeys = ['createdAtMs','postedDateMs','createdTimeMs','timestamp'];
    for (const k of numKeys) {
      const v = (item as any)[k] ?? (obj as any)[k];
      if (typeof v === 'number') {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
  }
  return null;
}

// Removed old fuzzy token matching helpers

// UI-driven search and filters removed (no UI interactions)

// HTML search URL builder removed (use only GraphQL)

// Parse "Posted ... ago" textual timestamps on detail pages
function parseRelativePostedText(s: string): string | null {
  if (!s) return null;
  s = s.toLowerCase();
  const now = Date.now();
  if (/posted\s+today\b/.test(s)) return new Date(now).toISOString();
  if (/posted\s+yesterday\b/.test(s)) return new Date(now - 24*60*60*1000).toISOString();
  // Posted X ago
  let m = s.match(/(?:posted|listed)\s+(?:about\s+)?(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (m) {
    const qty = parseInt(m[1], 10);
    const unit = m[2];
    const ms =
      unit === 'minute' ? qty * 60_000 :
      unit === 'hour'   ? qty * 3_600_000 :
      unit === 'day'    ? qty * 86_400_000 :
      unit === 'week'   ? qty * 604_800_000 :
      unit === 'month'  ? qty * 30 * 86_400_000 :
      unit === 'year'   ? qty * 365 * 86_400_000 : 0;
    if (ms > 0) return new Date(now - ms).toISOString();
  }
  // Last updated X ago
  m = s.match(/(?:updated|last\s+updated)\s+(?:about\s+)?(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (m) {
    const qty = parseInt(m[1], 10);
    const unit = m[2];
    const ms =
      unit === 'minute' ? qty * 60_000 :
      unit === 'hour'   ? qty * 3_600_000 :
      unit === 'day'    ? qty * 86_400_000 :
      unit === 'week'   ? qty * 604_800_000 :
      unit === 'month'  ? qty * 30 * 86_400_000 :
      unit === 'year'   ? qty * 365 * 86_400_000 : 0;
    if (ms > 0) return new Date(now - ms).toISOString();
  }
  return null;
}
async function getPostedAtFromPage(detail: Page): Promise<string|null> {
  const cands: (string|null)[] = await Promise.all([
    getTextFast(detail, 'text=/^Posted\\b/i'),
    getTextFast(detail, 'text=/Posted\\s+(?:about\\s+)?\\d+\\s+(minute|hour|day|week|month|year)s?\\s+ago/i'),
    getTextFast(detail, 'main'),
  ]);
  const joined = cands.filter(Boolean).join(' ');
  return parseRelativePostedText(joined);
}

// Optional: crude vehicle-only heuristic to drop obvious parts listings
// Removed old title heuristics
function extractMileageFromNextData(nd: any): number|null {
  if (!nd || typeof nd !== 'object') return null;
  const stack: any[] = [nd];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const key of ['vehicleMiles', 'mileage', 'odometer']) {
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        const val = (cur as any)[key];
        const n = Number(String(val).replace(/[^\d.]/g, ''));
        if (Number.isFinite(n)) return Math.trunc(n);
      }
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}
function extractPriceFromNextData(nd: any): number|null {
  if (!nd || typeof nd !== 'object') return null;
  const stack: any[] = [nd];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const keys = ['price', 'priceCents', 'priceInCents', 'priceUSDInCents', 'rawPrice', 'formattedPrice'];
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(cur, k)) {
        const v = (cur as any)[k];
        if (v == null) continue;
        if (/Cents/i.test(k)) {
          const cents = Number(String(v).replace(/[^\d]/g, ''));
          if (Number.isFinite(cents)) return Math.trunc(cents / 100);
        } else {
          const n = Number(String(v).replace(/[^\d.]/g, ''));
          if (Number.isFinite(n)) return Math.trunc(n);
        }
      }
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}
function extractMakeModelFromJsonLd(structs: any[]): { make?: string|null; model?: string|null } {
  let make: string|null|undefined, model: string|null|undefined;
  for (const j of structs) {
    const item = (j as any)?.itemOffered || j;
    const tryVals = (obj: any, keys: string[]) => {
      for (const k of keys) if (obj && typeof obj[k] === 'string') return obj[k] as string;
      return null;
    };
    if (!make) {
      make = tryVals(item || {}, ['make', 'brand', 'manufacturer', 'makeName', 'brandName']);
      if (!make && item && typeof item.brand === 'object') make = (item.brand.name || item.brand) as string;
    }
    if (!model) {
      model = tryVals(item || {}, ['model', 'modelName', 'vehicleModel', 'model_slug']);
    }
    if (make || model) break;
  }
  return { make: make ?? null, model: model ?? null };
}
function extractMakeModelFromNextData(nd: any): { make?: string|null; model?: string|null } {
  if (!nd || typeof nd !== 'object') return { make: null, model: null };
  let foundMake: string|null = null, foundModel: string|null = null;
  const stack: any[] = [nd];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const getStr = (obj: any, keys: string[]) => {
      for (const k of keys) if (typeof obj[k] === 'string') return obj[k] as string;
      return null;
    };
    if (!foundMake) {
      foundMake = getStr(cur, ['make', 'makeName', 'brand', 'manufacturer', 'make_slug', 'brandName']);
      if (!foundMake && typeof (cur as any).brand === 'object') foundMake = (cur as any).brand?.name || null;
    }
    if (!foundModel) {
      foundModel = getStr(cur, ['model', 'modelName', 'vehicleModel', 'model_slug']);
    }
    if (foundMake && foundModel) break;
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return { make: foundMake, model: foundModel };
}
function parseMi(s?: string|null): number|null {
  if (!s) return null;
  const m = s.match(/(\d{1,3})\s*mi\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function normCity(raw?: string|null): string|null {
  if (!raw) return null;
  let c = String(raw);
  c = c.replace(/\u2022/g, '•');
  c = c.includes('•') ? c.split('•').pop()!.trim() : c;
  c = c.replace(/,\s*[A-Z]{2}\b/i, '').trim();
  c = c.split(',')[0].trim();
  return c || null;
}

function extractCity(input: any): string | null {
  try {
    if (input && typeof input === 'object') {
      const ln = (input.locationName || input.city || input.location?.city) as string | undefined;
      const normalized = normCity(ln || null);
      if (normalized) return normalized;
    }
    if (typeof input === 'string') {
      const s = input;
      const m = s.match(/for\s+sale\s+in\s+([A-Za-z ]+)/i);
      if (m) {
        const city = normCity(m[1]);
        if (city) return city;
      }
    }
  } catch {}
  return null;
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
  title: string | null;
  price: number | null;
  mileage: number | null;
  city: string | null;
  postedAt: Date | string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  distanceMi: number | null;
  needsTimestampResolution?: boolean;
  parsed?: { year: number | null; make: string | null; model: string | null };
};

// Alias required by strict filtering logic
function parseListingTitle(title: string): { year: number | null; make: string | null; model: string | null } {
  return parseModelFromTitle(title || '');
}

function inferFromTitle(title?: string|null): { year: number|null; make: string|null; model: string|null } {
  if (!title) return { year: null, make: null, model: null };
  // Extract year
  let year: number|null = null;
  const y = title.match(/\b(19|20)\d{2}\b/);
  if (y) year = sanitizeYear(parseInt(y[0], 10));
  // Remove year and common noise/qualifiers
  let remaining = (y ? title.replace(/\b(19|20)\d{2}\b/, ' ') : title)
    .replace(/\b(clean\s*title|salvage|rebuilt|branded)\b/gi, ' ')
    .replace(/\b(fwd|rwd|awd|4wd|2wd)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = remaining.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { year, make: null, model: null };
  if (parts.length === 1) return { year, make: parts[0], model: null };
  const make = parts[0];
  // Model: keep the first 1–2 significant tokens after make (e.g., "Tacoma TRD" → "Tacoma")
  const modelParts = parts.slice(1);
  const model = modelParts.slice(0, 2).join(' ').trim() || null;
  return { year, make, model };
}

// Removed old filter stats and fuzzy matching; filtering happens in detail-phase

// Aggregate listing tiles from modularFeed response
function extractFeedTiles(resp: any): FeedItem[] {
  const out: FeedItem[] = [];
  try {
    const mf = resp?.data?.modularFeed ?? resp?.modularFeed ?? resp?.data ?? {};
    const loose = Array.isArray(mf?.looseTiles) ? mf.looseTiles : [];
    const pushFromTile = (t: any) => {
      const tileType = t?.tileType || t?.__typename || '';
      if (String(tileType).toUpperCase() !== 'LISTING') return;
      const listing = t?.listing || {};
      const id = String(listing?.listingId || listing?.id || '').trim();
      if (!id) return;
      const url = `https://offerup.com/item/detail/${id}`;
      const title = typeof listing?.title === 'string' ? listing.title : null;
      const price = sanitizeInteger(listing?.price ?? listing?.priceCents ?? listing?.priceInCents, { min: 0 });
      const mileage = sanitizeInteger(listing?.mileage ?? listing?.vehicleMiles ?? listing?.odometer, { min: 0 });
      const city = listing?.location?.city || listing?.city || null;
      out.push({
        id,
        url,
        title: title ?? null,
        price: price ?? null,
        mileage: mileage ?? null,
        city: city ?? null,
        postedAt: null,
        distanceMi: null,
      });
    };
    for (const t of loose) pushFromTile(t);
    const modules = Array.isArray(mf?.modules) ? mf.modules : [];
    for (const m of modules) {
      const tiles = Array.isArray(m?.tiles) ? m.tiles : [];
      for (const t of tiles) pushFromTile(t);
    }
  } catch {}
  return out;
}

function nextCursorFromResp(resp: any): string | null {
  const mf = resp?.data?.modularFeed ?? resp?.modularFeed ?? resp?.data ?? {};
  const c = mf?.pageCursor || null;
  return typeof c === 'string' && c.length ? c : null;
}

// Unified timestamp extraction pipeline
async function extractPostedAt(detail: Page, jsonLd: any[], nextData: any): Promise<{ timestamp: Date | null; source: string }>{
  // (A) JSON-LD
  try {
    for (const j of jsonLd || []) {
      const o = (j as any) || {};
      const candidate = (o as any).datePosted || (o as any).uploadDate || (o?.itemOffered?.datePosted) || (o?.itemOffered?.uploadDate);
      if (typeof candidate === 'string') {
        const d = new Date(candidate);
        if (!isNaN(d.getTime())) return { timestamp: d, source: 'jsonld' };
      }
    }
  } catch {}

  // (B) NEXT_DATA
  try {
    const keysStr = ['postedDate','createDate','createdAt'];
    const keysNum = ['postedDateMs','createdTimeMs','timestampMs'];
    const stack: any[] = [nextData];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      for (const k of keysStr) {
        if (typeof cur[k] === 'string') {
          const d = new Date(cur[k]);
          if (!isNaN(d.getTime())) return { timestamp: d, source: 'nextdata' };
        }
      }
      for (const k of keysNum) {
        if (typeof cur[k] === 'number') {
          const d = new Date(cur[k]);
          if (!isNaN(d.getTime())) return { timestamp: d, source: 'nextdata' };
        }
      }
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
  } catch {}

  // (C) Relative text
  try {
    const cands: (string|null)[] = await Promise.all([
      getTextFast(detail, 'text=/^Posted\\b/i'),
      getTextFast(detail, 'text=/Posted\\s+(?:about\\s+)?\\d+\\s+(minute|hour|day|week|month|year)s?\\s+ago/i'),
      getTextFast(detail, 'main'),
    ]);
    const rel = parseRelativePostedText(cands.filter(Boolean).join(' '));
    if (rel) {
      const d = new Date(rel);
      if (!isNaN(d.getTime())) return { timestamp: d, source: 'relative' };
    }
  } catch {}

  return { timestamp: null, source: 'none' };
}

// -------- GraphQL Active Feed helpers --------

// Build a searchParams array based on the saved request, but override q/lat/lon/radius/limit
function buildSearchParamsWithFilters(baseParams: any[], q: string): any[] {
  const params = [...baseParams];

  const setParam = (key: string, value: string) => {
    const idx = params.findIndex(p => (p?.key || '').toLowerCase() === key.toLowerCase());
    if (idx >= 0) params[idx].value = value;
    else params.push({ key, value });
  };

  // Force sort=-posted for newest listings
  setParam('sort', '-posted');

  const deleteParam = (key: string) => {
    for (let i = params.length - 1; i >= 0; i--) {
      const k = String(params[i]?.key || '');
      if (k.toLowerCase() === key.toLowerCase()) params.splice(i, 1);
    }
  };

  // strip any cursor params so we always start from the first page
  for (let i = params.length - 1; i >= 0; i--) {
    const k = String(params[i]?.key || '').toLowerCase();
    if (k.includes('cursor')) params.splice(i, 1);
  }

  // q: make+model query
  if (q && q.trim().length) {
    setParam('q', q.trim());
  }

  // location/radius
  setParam('lat', String(LAT));
  setParam('lon', String(LNG));
  if (RADIUS) setParam('radius', String(RADIUS));

  // limit control based on OU_MAX_ITEMS
  const cap = Math.max(20, Math.min(100, MAX_ITEMS));
  setParam('limit', String(cap));

  const priceKeys = FILTER_HINTS.price ?? {
    minKey: DEFAULT_FILTER_KEYS.priceMin,
    maxKey: DEFAULT_FILTER_KEYS.priceMax,
  };
  if (F_MIN_PRICE != null) setParam(priceKeys.minKey, String(F_MIN_PRICE));
  else deleteParam(priceKeys.minKey);
  if (F_MAX_PRICE != null) setParam(priceKeys.maxKey, String(F_MAX_PRICE));
  else deleteParam(priceKeys.maxKey);

  const yearKeys = FILTER_HINTS.year ?? {
    minKey: DEFAULT_FILTER_KEYS.yearMin,
    maxKey: DEFAULT_FILTER_KEYS.yearMax,
  };
  if (F_MIN_YEAR != null) setParam(yearKeys.minKey, String(F_MIN_YEAR));
  else deleteParam(yearKeys.minKey);
  if (F_MAX_YEAR != null) setParam(yearKeys.maxKey, String(F_MAX_YEAR));
  else deleteParam(yearKeys.maxKey);

  const mileageValue = resolveMileageBand(F_MAX_MILEAGE ?? null);
  if (mileageValue) setParam(DEFAULT_FILTER_KEYS.mileage, mileageValue);
  else deleteParam(DEFAULT_FILTER_KEYS.mileage);

  return params;
}

// Fetch the FIRST GraphQL feed page using the saved request as template.
// This does NOT rely on page/Playwright; it uses Node fetch only.
async function fetchActiveFeedFirstPage(q: string): Promise<any | null> {
  try {
    const raw = await fs.readFile('offerup_gql_feed_req.json', 'utf8').catch(() => null);
    if (!raw) {
      logWarn('[ACTIVE-FEED] No offerup_gql_feed_req.json template found.');
      return null;
    }
    const saved = JSON.parse(raw) as {
      url: string;
      method: string;
      headers: Record<string, string>;
      postData: string;
    };

    const headers: Record<string, string> = { ...(saved.headers || {}) };
    delete (headers as any)['content-length'];
    delete (headers as any)['accept-encoding'];

    const bodyPrev = JSON.parse(saved.postData || '{}');
    const baseParams: any[] = Array.isArray(bodyPrev?.variables?.searchParams)
      ? bodyPrev.variables.searchParams
      : [];

    const searchParams = buildSearchParamsWithFilters(baseParams, q);

    // DEBUG: Log the actual search parameters being sent to OfferUp API
    const qParam = searchParams.find((p: any) => p.key === 'q');
    const latParam = searchParams.find((p: any) => p.key === 'lat');
    const lonParam = searchParams.find((p: any) => p.key === 'lon');
    const radiusParam = searchParams.find((p: any) => p.key === 'radius');
    logInfo('[DEBUG] GraphQL Request Parameters:', {
      query: qParam?.value || 'NONE',
      lat: latParam?.value || 'NONE',
      lon: lonParam?.value || 'NONE',
      radius: radiusParam?.value || 'NONE',
      totalParams: searchParams.length
    });

    const newBody = {
      ...bodyPrev,
      operationName: 'GetModularFeed',
      variables: {
        ...(bodyPrev.variables || {}),
        searchParams,
      },
    };

    const r = await safeJsonFetch(saved.url, {
      method: saved.method || 'POST',
      headers,
      body: JSON.stringify(newBody),
      context: 'active-first',
    });
    if (!r.ok) {
      logWarn('[ALERT] Active feed first call failed.', { status: r.status });
      return null;
    }
    const json = r.json;
    if (!json) {
      logWarn('[ACTIVE-FEED] Failed to parse first-page JSON');
      return null;
    }
    return json;
  } catch (e) {
    logWarn('[ACTIVE-FEED] Error in fetchActiveFeedFirstPage', { error: (e as any)?.message || String(e) });
    return null;
  }
}

// Extract tiles (plain JS objects) from a GraphQL body
function extractFeedTilesFromBody(body: any): any[] {
  const d = body?.data || {};
  const loose = d?.modularFeed?.looseTiles;
  const items = d?.modularFeed?.items;

  if (Array.isArray(loose)) return loose;
  if (Array.isArray(items)) return items;
  return [];
}

// Convert GraphQL tiles into FeedItem[] using your existing normalization logic.
function feedItemsFromBodies(bodies: any[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const b of bodies) {
    const tiles = extractFeedTilesFromBody(b);
    if (!Array.isArray(tiles) || !tiles.length) continue;

    for (const t of tiles) {
      const node = (t?.listing ? t.listing : t) || {};
      const id = String(
        node?.listingId ??
        node?.id ??
        node?.postId ??
        node?.postingId ??
        ''
      );
      if (!id) continue;

      const slug = String(node?.slug ?? id);
      const url = String(
        node?.url ??
        node?.seoUrl ??
        node?.seo_url ??
        `https://offerup.com/item/detail/${slug}`
      );
      const title = node?.title ?? null;
      const price = sanitizeInteger(node?.price ?? node?.priceCents ?? null, { min: 0, max: 500000 });
      const mileage = sanitizeInteger(node?.vehicleMiles ?? node?.mileage ?? null, { min: 0 });

      const city = normCity(
        node?.locationName ||
        node?.sellerLocationName ||
        node?.city ||
        null
      );

      out.push({
        id,
        url,
        title: title ?? null,
        price: price ?? null,
        mileage: mileage ?? null,
        city: city ?? null,
        postedAt: null,
        distanceMi: null,
      });
    }
  }
  return out;
}

// Follow cursors using gqlFetchNextPageFromSaved (already exists) to paginate.
async function collectActiveFeedGraphQL(q: string): Promise<FeedItem[]> {
  const bodies: any[] = [];
  const first = await fetchActiveFeedFirstPage(q);
  if (!first) {
    logWarn('[ACTIVE-FEED] First page returned null; no active feed.');
    return [];
  }

  hydrateFilterHintsFromBody(first);
  bodies.push(first);
  let cur = first;
  let pagesFetched = 0;

  const getNextCursor = (b: any): string | null => {
    try {
      const d = b?.data || {};
      return (
        d?.searchFeedResponse?.nextCursor ??
        d?.searchFeedResponse?.pageCursor ??
        d?.searchFeedResponse?.nextPageCursor ??
        d?.searchFeedResponse?.cursor ??
        d?.modularFeed?.nextCursor ??
        d?.modularFeed?.pageCursor ??
        null
      );
    } catch {
      return null;
    }
  };

  while (pagesFetched < PAGINATE_PAGES) {
    const cursor = getNextCursor(cur);
    if (!cursor) break;

    const next = await gqlFetchNextPageFromSaved(cursor);
    if (!next) break;

    hydrateFilterHintsFromBody(next);
    const tiles = extractFeedTilesFromBody(next);
    if (!Array.isArray(tiles) || !tiles.length) break;

    bodies.push(next);
    cur = next;
    pagesFetched++;
    logDebug('[ACTIVE-FEED][PAGINATE]', { pagesFetched, tiles: tiles.length });
  }

  const items = feedItemsFromBodies(bodies);
  logInfo('[ACTIVE-FEED] pages/tiles', { pages: bodies.length, tiles: items.length });
  return items;
}

async function runRegion(regionName?: string) {
  const t0 = Date.now();
  resetFilterHints();
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ userAgent: DESKTOP_UA });
  const page = await context.newPage();

  // ---------- Build feed via ACTIVE GraphQL feed ----------
  let feed: FeedItem[] = [];
  const qParts: string[] = [];
  if (F_MAKES.length) qParts.push(...F_MAKES);
  if (F_MODELS.length) qParts.push(...F_MODELS);
  const SEARCH_Q = (process.env.OU_SEARCH_QUERY || '').trim();
  const DEFAULT_VEHICLE_QUERY = 'car truck suv'; // Fallback to ensure vehicle-only results
  const q = (SEARCH_Q || qParts.join(' ').trim() || DEFAULT_VEHICLE_QUERY);

  if (q.length) {
    logInfo('[ACTIVE-FEED] query', { q });
    feed = await collectActiveFeedGraphQL(q);
  } else {
    logInfo('[ACTIVE-FEED] No q derived from filters; skipping active feed.');
  }

  if (!feed.length) {
    logWarn('[ACTIVE-FEED] No tiles from GraphQL; feedCount=0');
  }

  // ---------------- HARD FILTER: MAKE/MODEL (STRICT via parsed fields) ----------------
  // Force parsing before hard filtering
  for (const tile of feed) {
    tile.parsed = parseListingTitle(tile.title || "");
  }

  const strictFeed: FeedItem[] = [];
  for (const tile of feed) {
    const parsed = parseListingTitle(tile.title || "");
    const make = parsed.make?.toLowerCase() || null;
    const model = parsed.model?.toLowerCase() || null;

    const wantsMake = F_MAKES.length ? F_MAKES.map(x => x.toLowerCase()) : null;
    const wantsModel = F_MODELS.length ? F_MODELS.map(x => x.toLowerCase()) : null;

    let keep = true;

    if (wantsMake && !wantsMake.includes(make as any)) keep = false;
    if (wantsModel && !wantsModel.includes(model as any)) keep = false;

    // Price range filters
    const price = tile.price ?? null;
    if (keep && F_MIN_PRICE != null && price != null && price < F_MIN_PRICE) keep = false;
    if (keep && F_MAX_PRICE != null && price != null && price > F_MAX_PRICE) keep = false;

    // Year filters (based on parsed year only)
    const year = parsed.year ?? null;
    if (keep && F_MIN_YEAR != null && (year == null || year < F_MIN_YEAR)) keep = false;
    if (keep && F_MAX_YEAR != null && (year == null || year > F_MAX_YEAR)) keep = false;

    // Mileage filters
    const mileage = tile.mileage ?? null;
    if (keep && F_MIN_MILEAGE != null && mileage != null && mileage < F_MIN_MILEAGE) keep = false;
    if (keep && F_MAX_MILEAGE != null && mileage != null && mileage > F_MAX_MILEAGE) keep = false;

    if (keep) strictFeed.push({ ...tile, parsed });
  }
  const beforeHardFilter = feed.length;
  const afterHardFilter = strictFeed.length;
  const hardFilterRejected = beforeHardFilter - afterHardFilter;
  logInfo('[HARD FILTER] Results', {
    before: beforeHardFilter,
    after: afterHardFilter,
    rejected: hardFilterRejected,
    filters: {
      makes: F_MAKES.length > 0 ? F_MAKES : 'none',
      models: F_MODELS.length > 0 ? F_MODELS : 'none',
      priceRange: F_MIN_PRICE || F_MAX_PRICE ? `${F_MIN_PRICE || 0}-${F_MAX_PRICE || '∞'}` : 'none',
      yearRange: F_MIN_YEAR || F_MAX_YEAR ? `${F_MIN_YEAR || 0}-${F_MAX_YEAR || '∞'}` : 'none'
    }
  });

  // ---------------- END HARD FILTER ------------------------
  const seen = new Set<string>();
  const beforeDedupe = strictFeed.length;
  const deduped = strictFeed.filter(it => {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
  const duplicatesRemoved = beforeDedupe - deduped.length;
  if (duplicatesRemoved > 0) {
    logInfo('[DEDUPLICATION] Removed duplicates', { removed: duplicatesRemoved, remaining: deduped.length });
  }

  const beforeCap = deduped.length;
  const finalFeed: FeedItem[] = deduped.slice(0, MAX_ITEMS);
  const cappedCount = beforeCap - finalFeed.length;
  if (cappedCount > 0) {
    logInfo('[MAX_ITEMS CAP] Capped listings', { cap: MAX_ITEMS, capped: cappedCount, processing: finalFeed.length });
  } else {
    logInfo('[FEED READY] Proceeding to detail phase', { totalItems: finalFeed.length, maxCap: MAX_ITEMS });
  }

  const summaryBase = { feedCount: finalFeed.length } as any;
  const accepted: any[] = [];
  let errors = 0;
  let dealersFiltered = 0;
  let timestampRejected = 0;

  const queue = [...finalFeed];
  const workers: Promise<void>[] = [];
  let processedCount = 0;
  const runOne = async () => {
    while (queue.length) {
      const item = queue.shift()!;
      processedCount++;
      if (processedCount % 10 === 0) {
        logInfo('[DETAIL-PHASE] Progress', { processed: processedCount, remaining: queue.length });
      }
      const detail = await context.newPage();
      await detail.waitForTimeout(75 + Math.random() * 75);
      const url = item.url;
      const remote_id = item.id;
      try {
        await detail.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const [jsonLd, nextData] = await Promise.all([
          getJsonLd(detail),
          getNextData(detail),
        ]);
        const nd = nextData;

        // Extract seller information and filter dealers if enabled
        const sellerInfo = extractSellerInfo(jsonLd, nd);
        const isDealer = sellerInfo?.isDealer || false;
        const FILTER_DEALERS = (process.env.OU_FILTER_DEALERS ?? 'false').toLowerCase() === 'true';

        if (FILTER_DEALERS && isDealer) {
          dealersFiltered++;
          logInfo('[DEALER-FILTER] Skipping dealer listing', {
            url,
            seller: sellerInfo?.businessName || sellerInfo?.sellerName,
            truYou: sellerInfo?.truYouVerified,
          });
          continue; // Skip to next item
        }

        const title = (await getTextFast(detail, 'h1')) || (typeof nd?.props?.pageProps?.title === 'string' ? nd.props.pageProps.title : null) || item.title || null;
        const price = extractPriceFromStructures(jsonLd) ?? extractPriceFromNextData(nd) ?? sanitizeInteger(item.price ?? null, { min: 0 });
        const mileage = extractMileageFromStructures(jsonLd) ?? extractMileageFromNextData(nd) ?? sanitizeInteger(item.mileage ?? null, { min: 0 });

        // Unified timestamp extraction
        const unified = await extractPostedAt(detail, jsonLd, nd);
        let posted_at: string | null = unified.timestamp ? new Date(unified.timestamp).toISOString() : null;
        if (unified.source === 'jsonld') RUN_STATS.postedSrc.jsonld++;
        else if (unified.source === 'nextdata') RUN_STATS.postedSrc.nextdata++;
        else if (unified.source === 'relative') RUN_STATS.postedSrc.relative++;

        // Timestamp fallback behavior
        let needsTimestampResolution = false;
        if (posted_at) {
          if (F_POSTED_WITHIN_HOURS != null) {
            const cutoff = Date.now() - F_POSTED_WITHIN_HOURS * 3600_000;
            const ts = new Date(posted_at).getTime();
            if (!Number.isFinite(ts) || ts < cutoff) {
              RUN_STATS.postedRejected++;
              timestampRejected++;
              try { logInfo('[TS] too old', { url, posted_at }); } catch {}
              continue;
            } else {
              RUN_STATS.postedKept++;
              try { logInfo('[TS] OK recent', { url, posted_at }); } catch {}
            }
          } else {
            // No hours window set; accept
            RUN_STATS.postedKept++;
            try { logInfo('[TS] OK recent', { url, posted_at }); } catch {}
          }
        } else {
          RUN_STATS.missingTimestamp++;
          timestampRejected++;
          needsTimestampResolution = true;
          try { logInfo('[TS] missing timestamp → rejecting', { url, id: remote_id }); } catch {}
          continue;
        }

        // New parsing system only
        const parsed = parseCarTitleOrNull(title || item.title || null);
        const model = parsed.model ?? null;
        const make = parsed.make ?? null;
        const year = parsed.year ?? null;

        // City extraction
        let city: string | null = item.city || null;
        if (!city) {
          const mainText = (await getTextFast(detail, 'main')) || (await getTextFast(detail, 'body')) || '';
          city = extractCity(nd?.props?.pageProps?.listing || nd) || extractCity(mainText) || null;
        }

        const candidate = {
          source: 'offerup',
          remote_id,
          url,
          title,
          price: price ?? null,
          mileage: mileage ?? null,
          city,
          year,
          make,
          model,
          posted_at,
          needsTimestampResolution,
          // Seller information (dealer detection)
          is_dealer: isDealer,
          seller_name: sellerInfo?.sellerName || null,
          seller_business_name: sellerInfo?.businessName || null,
          seller_verified: sellerInfo?.truYouVerified || false,
        };

        // Make/Model filtering already applied in hard filter phase (lines 1434-1435)
        // Removed duplicate filter here for performance

        accepted.push(candidate);
      } catch (e: any) {
        logWarn('detail error', { message: e?.message, url });
        errors++;
      } finally {
        try { await detail.close(); } catch {}
      }
    }
  };

  const workerCount = Math.max(1, Math.min(DETAIL_CONCURRENCY, 3));
  logInfo('[DETAIL-PHASE] Starting detail enrichment', {
    totalItems: finalFeed.length,
    workers: workerCount,
    concurrency: DETAIL_CONCURRENCY
  });

  for (let i = 0; i < workerCount; i++) workers.push(runOne());
  await Promise.all(workers);

  logInfo('[DETAIL-PHASE] Completed detail enrichment', {
    processed: finalFeed.length,
    accepted: accepted.length,
    dealersFiltered,
    timestampRejected,
    errors,
    successRate: `${((accepted.length / finalFeed.length) * 100).toFixed(1)}%`
  });

  // Track actual inserted count
  let actualInsertedCount = 0;

  if (accepted.length) {
    // Require minimal fields: remote_id, source, url
    // Relaxed final filter: Trust the loop's decision.
    // Only filter if posted_at is missing entirely (which loop should catch, but safety first)
    const finalRows = accepted
      .filter(r => r.posted_at)
      .map(c => ({
        source: c.source,
        remote_slug: c.remote_id,
        remote_id: c.remote_id,
        url: c.url,
        title: c.title,
        price: c.price,
        mileage: c.mileage,
        city: c.city,
        year: c.year,
        make: c.make,
        model: c.model,
        posted_at: c.posted_at,
        // Include dealer info in upsert payload for debugging/future use
        is_dealer: c.is_dealer,
        seller_name: c.seller_name,
        seller_business_name: c.seller_business_name,
        seller_verified: c.seller_verified,
      }));

    // DEBUG: Log cities found in scraped listings
    const cityCounts = finalRows.reduce((acc, row) => {
      const city = row.city || 'UNKNOWN';
      acc[city] = (acc[city] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    logInfo('[DEBUG] Cities found in scraped listings:', cityCounts);

    logInfo('[UPSERT] inserting', { rows: finalRows.length });
    for (const group of chunked(finalRows, 75)) {
      // Timestamp filtering already applied twice:
      // 1. During detail phase (lines 1520-1541) - filters for recency
      // 2. Before finalRows (lines 1621-1628) - validates timestamps
      // Removed redundant third filter here for performance

      // Enforce source/remote_id presence
      const cleaned = group.filter(r => r.source && r.remote_id);
      const skipped = group.filter(r => !r.source || !r.remote_id);
      if (skipped.length) {
        logWarn('[UPsert] skipping rows missing keys', {
          skippedCount: skipped.length,
          rows: skipped.map(r => ({ source: r.source, remote_id: r.remote_id })),
        });
      }

      // Deduplicate by remote_id to prevent "ON CONFLICT DO UPDATE command cannot affect row a second time"
      const seen = new Set<string>();
      const deduplicated = cleaned.filter(r => {
        const key = `${r.source}:${r.remote_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (deduplicated.length < cleaned.length) {
        logWarn('[UPsert] deduplicated batch', {
          original: cleaned.length,
          deduplicated: deduplicated.length,
          duplicates: cleaned.length - deduplicated.length,
        });
      }

      if (!deduplicated.length) continue;
      const up = await supaSvc
        .from('listings')
        .upsert(deduplicated, { onConflict: 'source,remote_id' });
      if (up.error) {
        logError('[UPsert] detail upsert error', {
          message: up.error.message,
          code: (up.error as any).code,
          details: (up.error as any).details,
          hint: (up.error as any).hint,
          rows: deduplicated.map(r => ({ source: r.source, remote_id: r.remote_id })),
        });
        errors++;
      } else {
        logInfo('[UPsert] detail upsert success', { upsertedCount: deduplicated.length });
        actualInsertedCount += deduplicated.length;
      }
    }
  }
  const enrichMs = Date.now() - t0;
  const filtersUsed = {
    minPrice: F_MIN_PRICE,
    maxPrice: F_MAX_PRICE,
    minYear: F_MIN_YEAR,
    maxYear: F_MAX_YEAR,
    minMileage: F_MIN_MILEAGE,
    maxMileage: F_MAX_MILEAGE,
    makes: F_MAKES,
    models: F_MODELS,
    postedWithinHours: F_POSTED_WITHIN_HOURS,
    radiusMiles: RADIUS,
    lat: LAT,
    lng: LNG,
    // model filtering is handled via parsed title only
  };
  const results = accepted.slice(0, 75);
  console.log(JSON.stringify({
    ...summaryBase,
    detailEnrichedCount: accepted.length,
    mode: 'DETAIL',
    hints: {
      priceKeys: FILTER_HINTS.price,
      yearKeys: FILTER_HINTS.year,
      mileageBands: FILTER_HINTS.mileageBands,
      makeOptionsCount: FILTER_HINTS.makeOptions.length,
    },
    filtersUsed,
    results,
  }, null, 2));
  // Big-picture alerts
  try {
    const feedCount = (summaryBase.feedCount as number) || 0;
    const detailEnrichedCount = accepted.length;
    const postedRejected = RUN_STATS.postedRejected;
    const postedKept = RUN_STATS.postedKept;
    const missingTimestamp = RUN_STATS.missingTimestamp;

    if (feedCount === 0) {
      logWarn('[ALERT] No feed items captured for this search.', {
        makes: F_MAKES,
        models: F_MODELS,
        postedWithinHours: F_POSTED_WITHIN_HOURS,
        lat: LAT,
        lng: LNG,
      });
    }

    if (feedCount > 0 && postedKept === 0) {
      logWarn('[ALERT] All items were rejected by filters (likely too strict).', {
        feedCount,
        postedRejected,
        filtersUsed,
      });
    }

    if (missingTimestamp && missingTimestamp > 0) {
      logWarn('[ALERT] Some listings were missing timestamps.', { missingTimestamp });
    }

    if (feedCount > 0 && detailEnrichedCount === 0) {
      logWarn('[ALERT] Detail phase produced zero candidates; check make/model filters.', {
        feedCount,
        makes: F_MAKES,
        models: F_MODELS,
      });
    }
  } catch {}

  logInfo('Summary:', RUN_STATS as any);

  // Run-level meta log
  try {
    const feedCount = (summaryBase.feedCount as number) || 0;
    const detailEnrichedCount = accepted.length;
    const postedKept = RUN_STATS.postedKept;
    const postedRejected = RUN_STATS.postedRejected;
    const missingTimestamp = RUN_STATS.missingTimestamp;
    logInfo('[RUN-SUMMARY]', {
      source: 'offerup',
      makes: F_MAKES,
      models: F_MODELS,
      postedWithinHours: F_POSTED_WITHIN_HOURS,
      feedCount,
      detailEnrichedCount,
      postedKept,
      postedRejected,
      missingTimestamp,
    } as any);
  } catch {}

  // Output success JSON for worker to parse (only in single-region mode)
  // Use actualInsertedCount which reflects items that actually made it to the database
  const inserted = actualInsertedCount;
  const skipped = (summaryBase.feedCount as number || 0) - inserted;

  if (!OU_MULTI_REGION) {
    console.log(JSON.stringify({
      ok: true,
      inserted,
      skipped,
      errors,
    }));
  }

  await browser.close();

  return { inserted, skipped };
}

// Placeholder for future timestamp resolution worker
async function resolveTimestampFallback(url: string): Promise<string | null> {
  // Future worker will use this.
  return null;
}

// Target insert count (optional global stop)
const TARGET_INSERT_COUNT = parseInt(process.env.OU_TARGET_INSERT_COUNT || '0', 10);

async function main() {
  if (!OU_MULTI_REGION) {
    // Single region mode - run once
    await runRegion();
    return;
  }

  // Multi-region mode
  console.log('\n' + '='.repeat(70));
  console.log('[MULTI-REGION] OfferUp Multi-Region Scraper');
  console.log('='.repeat(70));
  console.log(`Regions: ${OU_REGION_COUNT}`);
  console.log(`Delay between regions: ${OU_REGION_DELAY_MS}ms`);
  if (TARGET_INSERT_COUNT > 0) {
    console.log(`Target Insert Count: ${TARGET_INSERT_COUNT}`);
  }
  console.log('='.repeat(70) + '\n');

  const regionsToScrape = US_REGIONS.slice(0, OU_REGION_COUNT);
  const startTime = Date.now();
  const results: Array<{ region: string; inserted: number; skipped: number }> = [];
  let globalInserted = 0;

  for (let i = 0; i < regionsToScrape.length; i++) {
    // Check if we hit the target
    if (TARGET_INSERT_COUNT > 0 && globalInserted >= TARGET_INSERT_COUNT) {
      console.log(`\n[MULTI-REGION] Reached target insert count (${globalInserted} >= ${TARGET_INSERT_COUNT}). Stopping early.`);
      break;
    }

    const region = regionsToScrape[i];
    console.log(`\n[${i + 1}/${OU_REGION_COUNT}] Scraping: ${region.name}`);
    console.log('─'.repeat(70));

    // Override LAT/LNG/RADIUS for this region
    LAT = region.lat;
    LNG = region.lng;
    RADIUS = 80; // 80 miles for multi-region mode

    try {
      const stats = await runRegion(region.name);
      results.push({
        region: region.name,
        inserted: stats.inserted,
        skipped: stats.skipped,
      });
      globalInserted += stats.inserted;
    } catch (err) {
      console.error(`[MULTI-REGION] Error scraping ${region.name}:`, err);
      results.push({
        region: region.name,
        inserted: 0,
        skipped: 0,
      });
    }

    // Delay before next region (except for last, and only if we haven't hit target)
    if (i < regionsToScrape.length - 1 && (TARGET_INSERT_COUNT === 0 || globalInserted < TARGET_INSERT_COUNT)) {
      console.log(`\n[MULTI-REGION] Waiting ${OU_REGION_DELAY_MS / 1000}s before next region...\n`);
      await new Promise(resolve => setTimeout(resolve, OU_REGION_DELAY_MS));
    }
  }

  // Summary
  const endTime = Date.now();
  const durationSec = Math.round((endTime - startTime) / 1000);
  const totalInserted = globalInserted; // Use accumulated global
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);

  console.log('\n' + '='.repeat(70));
  console.log('[MULTI-REGION] Summary');
  console.log('='.repeat(70));
  console.log(`Duration: ${durationSec}s`);
  console.log(`Total inserted: ${totalInserted}`);
  console.log(`Total skipped: ${totalSkipped}`);
  console.log('='.repeat(70));

  console.log('\nResults by region:');
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.region.padEnd(20)} (+${r.inserted} ~${r.skipped})`);
  });

  console.log('\n[MULTI-REGION] All regions processed!');

  // Output final JSON for worker to parse (multi-region summary)
  console.log(JSON.stringify({
    ok: true,
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: 0,
  }));
}

main().catch(async (err) => {
  logError('offerup script failed:', { error: String(err) });
  try {
    await fs.writeFile('offerup_error.txt', String(err?.stack || err));
  } catch {}
  process.exit(1);
});

/**
 * NOTE:
 * Server-side posted_after filter removed.
 * Recency filtering is now detail-phase only.
 * To re-enable server-side recency filtering, reintroduce a
 * PAGE_CURSOR + POSTED_AFTER injection in the GraphQL body.
 */
