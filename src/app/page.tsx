// app/page.tsx
import Link from 'next/link'
import { supaAdmin } from '@/lib/supabase-admin'

export const revalidate = 0

type ListingRow = {
  id: string
  source?: string | null
  url?: string | null
  title?: string | null
  year?: number | null
  make?: string | null
  model?: string | null
  price?: number | null
  mileage?: number | null
  title_status?: 'clean' | 'salvage' | null
  city?: string | null
  posted_at?: string | null
  first_seen_at?: string | null
}

// UI helpers ---------------------------------------------------------------
function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'danger' | 'neutral' }) {
  const map: Record<string, string> = {
    success: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    danger: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
    neutral: 'bg-neutral-500/15 text-neutral-300 ring-1 ring-neutral-500/20',
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${map[tone]}`}>{children}</span>
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl bg-neutral-900/60 ring-1 ring-white/10 p-4 shadow-sm shadow-black/20">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-neutral-100">{value}</div>
      {hint ? <div className="mt-1 text-xs text-neutral-500">{hint}</div> : null}
    </div>
  )
}

function IconLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="inline-block">
      <path d="M14 3h7v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 14L21 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M21 14v7h-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 10l11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ListingCard({ r }: { r: ListingRow }) {
  return (
    <div className="group rounded-2xl bg-neutral-900/70 ring-1 ring-white/10 p-4 transition hover:-translate-y-0.5 hover:bg-neutral-900 hover:shadow-lg hover:shadow-black/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm text-neutral-400">{r.source || '—'}</div>
          <h3 className="mt-0.5 text-base font-medium text-neutral-100">
            {r.year ? `${r.year} ` : ''}
            {r.make ? `${r.make} ` : ''}
            {r.model || r.title || 'Untitled'}
          </h3>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold text-neutral-100">
            {r.price ? `$${Number(r.price).toLocaleString()}` : '—'}
          </div>
          <div className="text-xs text-neutral-400">{r.mileage ? `${Number(r.mileage).toLocaleString()} mi` : '—'}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={r.title_status === 'clean' ? 'success' : r.title_status === 'salvage' ? 'danger' : 'neutral'}>
          {r.title_status || 'unknown'}
        </Badge>
        <span className="text-xs text-neutral-400">{r.city || '—'}</span>
        <span className="text-xs text-neutral-500">{r.posted_at ? new Date(r.posted_at).toLocaleString() : ''}</span>
      </div>
      <div className="mt-4">
        {r.url ? (
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600/90 px-3 py-1.5 text-sm text-white transition hover:bg-blue-500"
          >
            Open <IconLink />
          </a>
        ) : null}
      </div>
    </div>
  )
}

export default async function Page({ searchParams }: { searchParams?: Record<string, string> }) {
  const sp = searchParams || {}
  const minYear = parseInt(sp.minYear || '') || 0
  const maxYear = parseInt(sp.maxYear || '') || 0
  const minMileage = parseInt(sp.minMileage || '') || 0
  const maxMileage = parseInt(sp.maxMileage || '') || 0
  const makes = (sp.makes || '').split(',').filter(Boolean)
  const cities = (sp.cities || '').split(',').filter(Boolean)
  const sources = (sp.sources || '').split(',').filter(Boolean)
  const age = sp.age || ''

  function hrefWith(updates: Record<string, string | null | undefined>) {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (typeof v === 'string' && v.length) p.set(k, v)
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') p.delete(k)
      else p.set(k, v)
    }
    const qs = p.toString()
    return qs ? `/?${qs}` : '/'
  }

  // Data fetch (server-side) ----------------------------------------------
  let query = supaAdmin
    .from('listings')
    .select('*')
    .order('first_seen_at', { ascending: false })
    .limit(200)
  if (minYear) query = query.gte('year', minYear)
  if (maxYear) query = query.lte('year', maxYear)
  if (minMileage) query = query.gte('mileage', minMileage)
  if (maxMileage) query = query.lte('mileage', maxMileage)
  if (makes.length) query = query.in('make', makes)
  if (cities.length) query = query.in('city', cities)
  if (sources.length) query = query.in('source', sources)
  if (age) {
    const now = Date.now()
    const ms =
      age === '30m' ? 30 * 60 * 1000 : age === '2h' ? 2 * 60 * 60 * 1000 : age === '6h' ? 6 * 60 * 60 * 1000 : age === '24h' ? 24 * 60 * 60 * 1000 : age === '7d' ? 7 * 24 * 60 * 60 * 1000 : 0
    if (ms) {
      const sinceIso = new Date(now - ms).toISOString()
      query = query.gte('posted_at', sinceIso)
    }
  }

  const { data, error } = await query
  if (error) return <div className="p-6 text-rose-400">Error: {error.message}</div>

  const rows: ListingRow[] = (data || []) as ListingRow[]
  const total = rows.length
  const cleanCount = rows.filter((r) => r.title_status === 'clean').length
  const avgPrice = rows.length
    ? Math.round(
        rows
          .filter((r) => r.price != null)
          .reduce((acc, r) => acc + (r.price || 0), 0) / rows.length
      )
    : 0

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200">
      {/* Top Nav */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/70 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight text-neutral-100">Car Aggregator</Link>
          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Listings</Link>
            <Link href="/offerup" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Saved Searches</Link>
            <Link href="/analytics" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Analytics</Link>
          </nav>
          <div className="md:hidden text-sm text-neutral-400">Menu</div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Summary widgets */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4">
          <Stat label="Results loaded" value={total} />
          <Stat label="Clean titles" value={cleanCount} />
          <Stat label="Avg price" value={avgPrice ? `$${avgPrice.toLocaleString()}` : '—'} />
          <Stat label="Active filters" value={Object.values(sp).filter(Boolean).length} />
          <Stat label="Sources" value={sources.length ? sources.length : 'All'} />
          <Stat label="Time window" value={age || 'Any'} />
        </section>

        {/* Filter panel (collapsible on mobile) */}
        <section className="mt-6">
          <details className="group rounded-2xl bg-neutral-900/50 ring-1 ring-white/10 p-4 open:pb-5">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <div>
                <div className="text-sm font-medium text-neutral-100">Search & Filter</div>
                <div className="text-xs text-neutral-400">Refine your results by specs, price, and age</div>
              </div>
              <div className="text-xs text-neutral-400 group-open:rotate-180 transition">▾</div>
            </summary>
            <form className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3" method="GET">
              {/* Years */}
              <div className="md:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">Min Year</label>
                <input type="number" inputMode="numeric" min={1950} max={2100} placeholder="2015" name="minYear" defaultValue={sp.minYear || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60" />
                <div className="flex gap-2 mt-1 text-[11px] text-neutral-500">
                  {['2015', '2018', '2020'].map((v) => (
                    <a key={v} href={hrefWith({ minYear: v })} className="hover:text-neutral-200 underline underline-offset-2">
                      {v}+
                    </a>
                  ))}
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">Max Year</label>
                <input type="number" inputMode="numeric" min={1950} max={2100} placeholder="2022" name="maxYear" defaultValue={sp.maxYear || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60" />
              </div>

              {/* Mileage */}
              <div className="md:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">Min Mileage</label>
                <input type="number" inputMode="numeric" min={0} step={1000} placeholder="0" name="minMileage" defaultValue={sp.minMileage || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60" />
                <div className="flex flex-wrap gap-2 mt-1 text-[11px] text-neutral-500">
                  <a href={hrefWith({ maxMileage: '100000' })} className="hover:text-neutral-200 underline underline-offset-2">
                    Under 100k
                  </a>
                  <a href={hrefWith({ maxMileage: '75000' })} className="hover:text-neutral-200 underline underline-offset-2">
                    Under 75k
                  </a>
                  <a href={hrefWith({ maxMileage: '50000' })} className="hover:text-neutral-200 underline underline-offset-2">
                    Under 50k
                  </a>
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">Max Mileage</label>
                <input type="number" inputMode="numeric" min={0} step={1000} placeholder="120000" name="maxMileage" defaultValue={sp.maxMileage || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60" />
              </div>

              {/* Makes & Cities */}
              <div className="md:col-span-4">
                <label className="block text-xs text-neutral-400 mb-1">Makes (comma-separated)</label>
                <input name="makes" defaultValue={sp.makes || ''} placeholder="Honda, Toyota, Nissan" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60" />
                <div className="mt-1 text-[11px] text-neutral-500">
                  <a href={hrefWith({ makes: 'Honda,Toyota,Nissan,Mazda,Subaru,Acura,Lexus,Infiniti' })} className="hover:text-neutral-200 underline underline-offset-2">
                    Select Japanese brands
                  </a>
                </div>
              </div>
              <div className="md:col-span-4">
                <label className="block text-xs text-neutral-400 mb-1">Cities (comma-separated)</label>
                <input name="cities" defaultValue={sp.cities || ''} placeholder="e.g. Seattle, Tacoma, Everett" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60" />
              </div>

              {/* Source & Age */}
              <div className="md:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">Source</label>
                <select name="sources" defaultValue={sp.sources || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60">
                  <option value="">All</option>
                  <option value="craigslist">Craigslist</option>
                  <option value="offerup">OfferUp</option>
                  <option value="facebook">Facebook</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">Listing Age</label>
                <select name="age" defaultValue={sp.age || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60">
                  <option value="">Any time</option>
                  <option value="30m">Past 30 minutes</option>
                  <option value="2h">Past 2 hours</option>
                  <option value="6h">Past 6 hours</option>
                  <option value="24h">Past 24 hours</option>
                  <option value="7d">Past 7 days</option>
                </select>
              </div>

              <div className="md:col-span-12 flex gap-2 pt-1">
                <button type="submit" className="rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-600 px-3 py-2 text-sm text-white transition">Apply filters</button>
                <Link href="/" className="rounded-lg bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-800 px-3 py-2 text-sm text-neutral-200 transition">Reset</Link>
                <Link href="/offerup" className="ml-auto rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-600 px-3 py-2 text-sm text-white transition">Saved Searches</Link>
              </div>
            </form>
          </details>
        </section>

        {/* Listings: split by source, shared filters */}
        <section className="mt-6">
          {/* Mobile: stacked cards with headings */}
          <div className="md:hidden space-y-6">
            {(() => {
              const fb = rows.filter(r => (r.source || '').toLowerCase() === 'facebook')
              const ou = rows.filter(r => (r.source || '').toLowerCase() === 'offerup')
              return (
                <>
                  <div>
                    <div className="mb-2 text-sm font-medium text-neutral-300">Facebook Marketplace</div>
                    <div className="grid grid-cols-1 gap-3">
                      {fb.map(r => <ListingCard key={r.id} r={r} />)}
                      {!fb.length && <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-neutral-500">No Facebook listings.</div>}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-sm font-medium text-neutral-300">OfferUp</div>
                    <div className="grid grid-cols-1 gap-3">
                      {ou.map(r => <ListingCard key={r.id} r={r} />)}
                      {!ou.length && <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-neutral-500">No OfferUp listings.</div>}
                    </div>
                  </div>
                </>
              )
            })()}
          </div>

          {/* Desktop: two side-by-side tables under same filters */}
          <div className="hidden md:grid md:grid-cols-2 gap-4">
            {(['facebook','offerup'] as const).map((src) => {
              const list = rows.filter(r => (r.source || '').toLowerCase() === src)
              return (
                <div key={src} className="overflow-auto rounded-xl ring-1 ring-white/10">
                  <div className="sticky top-0 z-10 bg-neutral-950/80 backdrop-blur px-4 py-2 text-sm font-medium text-neutral-200 border-b border-white/10">{src === 'facebook' ? 'Facebook Marketplace' : 'OfferUp'}</div>
                  <table className="min-w-full text-sm">
                    <thead className="bg-neutral-950/80 backdrop-blur text-left text-neutral-400">
                      <tr>
                        <th className="py-3 pl-4 pr-6">Posted</th>
                        <th className="py-3 pr-6">Title</th>
                        <th className="py-3 pr-6">Price</th>
                        <th className="py-3 pr-6">Mileage</th>
                        <th className="py-3 pr-6">Title</th>
                        <th className="py-3 pr-6">City</th>
                        <th className="py-3 pr-4">Link</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {list.map((r) => (
                        <tr key={r.id} className="group hover:bg-white/5 transition">
                          <td className="py-3 pl-4 pr-6 text-neutral-300">{r.posted_at ? new Date(r.posted_at).toLocaleString() : ''}</td>
                          <td className="py-3 pr-6 font-medium text-neutral-100">
                            {r.year ? `${r.year} ` : ''}
                            {r.make ? `${r.make} ` : ''}
                            {r.model || r.title || ''}
                          </td>
                          <td className="py-3 pr-6 text-neutral-100">{r.price ? `$${Number(r.price).toLocaleString()}` : '—'}</td>
                          <td className="py-3 pr-6 text-neutral-300">{r.mileage ? `${Number(r.mileage).toLocaleString()} mi` : '—'}</td>
                          <td className="py-3 pr-6">
                            <Badge tone={r.title_status === 'clean' ? 'success' : r.title_status === 'salvage' ? 'danger' : 'neutral'}>
                              {r.title_status || 'unknown'}
                            </Badge>
                          </td>
                          <td className="py-3 pr-6 text-neutral-300">{r.city || '—'}</td>
                          <td className="py-3 pr-4">
                            {r.url ? (
                              <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md bg-blue-600/90 px-2.5 py-1.5 text-xs text-white transition hover:bg-blue-500">
                                Open <IconLink />
                              </a>
                            ) : (
                              <span className="text-neutral-500">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {!list.length && (
                        <tr>
                          <td colSpan={7} className="py-6 text-center text-sm text-neutral-400">No {src === 'facebook' ? 'Facebook' : 'OfferUp'} listings.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
