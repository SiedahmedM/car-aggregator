import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import { supaAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

type OfferupParams = {
  minYear?: number
  maxYear?: number
  minMileage?: number
  maxMileage?: number
  models?: string[]
  minPrice?: number
  maxPrice?: number
  postedWithinHours?: number
  lat?: number
  lng?: number
  radius?: number
  maxItems?: number
}

type OfferupSearch = { id: string; name?: string; params: OfferupParams; created_at?: string; date_key?: string; active?: boolean }

async function getSearchesForTodayOrLast(): Promise<OfferupSearch[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data: todays, error } = await supaAdmin
    .from('offerup_searches')
    .select('*')
    .eq('date_key', today)
    .eq('active', true)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  if (todays && todays.length) return todays as OfferupSearch[]
  const { data: lastDateRow, error: dErr } = await supaAdmin
    .from('offerup_searches')
    .select('date_key')
    .order('date_key', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (dErr) throw new Error(dErr.message)
  if (!lastDateRow) return []
  const lastDate = (lastDateRow as { date_key: string }).date_key
  const { data: fallback } = await supaAdmin
    .from('offerup_searches')
    .select('*')
    .eq('date_key', lastDate)
    .eq('active', true)
    .order('created_at', { ascending: true })
  return (fallback || []) as OfferupSearch[]
}

function runOfferupDirect(params: OfferupParams, name?: string): Promise<{ ok: boolean; inserted?: number; skipped?: number; errors?: number; log: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (params) {
      if (params.minYear) env.OU_FILTER_MIN_YEAR = String(params.minYear)
      if (params.maxYear) env.OU_FILTER_MAX_YEAR = String(params.maxYear)
      if (params.minMileage) env.OU_FILTER_MIN_MILEAGE = String(params.minMileage)
      if (params.maxMileage) env.OU_FILTER_MAX_MILEAGE = String(params.maxMileage)
      if (params.minPrice) env.OU_FILTER_MIN_PRICE = String(params.minPrice)
      if (params.maxPrice) env.OU_FILTER_MAX_PRICE = String(params.maxPrice)
      if (Array.isArray(params.models) && params.models.length) env.OU_FILTER_MODELS = params.models.join(',')
      if (params.postedWithinHours) env.OU_FILTER_POSTED_WITHIN_HOURS = String(params.postedWithinHours)
      if (params.lat) env.OU_LAT = String(params.lat)
      if (params.lng) env.OU_LNG = String(params.lng)
      if (params.radius) env.OU_RADIUS_MILES = String(params.radius)
      if (params.maxItems) env.OU_MAX_ITEMS = String(params.maxItems)
    }
    // If no explicit models, treat the saved-search name as a model hint
    if ((!params?.models || params.models.length === 0) && name) {
      env.OU_FILTER_MODELS = String(name)
    }
    // Favor fast path defaults for direct runs
    if (!env.OU_FEED_ONLY) env.OU_FEED_ONLY = 'true'
    if (!env.OU_FAST_MODE) env.OU_FAST_MODE = 'true'
    if (!env.OU_DIRECT_FEED) env.OU_DIRECT_FEED = 'true'

    const tsxPath = './node_modules/.bin/tsx'
    const child = spawn(tsxPath, ['scripts/offerup.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    child.on('close', () => {
      const m = out.match(/\{\s*"ok"\s*:\s*true[\s\S]*?\}\s*$/m)
      if (m) {
        try {
          const j = JSON.parse(m[0])
          resolve({ ok: true, inserted: j.inserted || 0, skipped: j.skipped || 0, errors: j.errors || 0, log: out.slice(0, 20000) })
          return
        } catch {}
      }
      resolve({ ok: false, log: out.slice(0, 20000) })
    })
  })
}

export async function POST(req: Request) {
  type RunBody = { searchIds?: string[] }
  let body: Partial<RunBody> = {}
  const ctype = req.headers.get('content-type') || ''
  if (ctype.includes('application/json')) {
    const parsed = await req.json().catch(() => ({}))
    body = (parsed && typeof parsed === 'object') ? (parsed as Partial<RunBody>) : {}
  } else {
    const fd = await req.formData()
    const ids = fd.getAll('searchIds[]').map(String).filter(Boolean)
    body.searchIds = ids.length ? ids : undefined
  }

  const searchIds: string[] | undefined = body.searchIds
  let searches: OfferupSearch[] = []
  if (Array.isArray(searchIds) && searchIds.length) {
    const { data, error } = await supaAdmin
      .from('offerup_searches')
      .select('*')
      .in('id', searchIds)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    searches = (data || []) as OfferupSearch[]
  } else {
    searches = await getSearchesForTodayOrLast()
  }
  if (!searches.length) return NextResponse.json({ ok: false, message: 'No searches to run' }, { status: 400 })

  // For now, run the first search directly
  const first = searches[0]
  const res = await runOfferupDirect(first.params || {}, first.name)
  if (!res.ok) return NextResponse.json({ ok: false, log: res.log }, { status: 500 })
  return NextResponse.json(res)
}


