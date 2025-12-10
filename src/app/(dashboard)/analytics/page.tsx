'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/browserClient'

type Flip = {
  id: string
  make: string
  model: string
  year: number
  mileage: number
  purchase_price: number
  sale_price: number | null
  purchase_date: string | null
  sale_date: string | null
  source: string | null
  notes: string | null
}

type WinPoint = { year: number; mileage: number; purchasePrice: number }

function numberOrEmpty(n: number | null | undefined) {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : ''
}

export default function AnalyticsPage() {
  const supabase = useMemo(() => supabaseBrowser(), [])
  const [flips, setFlips] = useState<Flip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Deal Scores state
  type ListingLite = { id: string; year: number | null; make: string | null; model: string | null; mileage: number | null; price: number | null; url: string | null }
  const [deals, setDeals] = useState<Array<{ score: number; confidence: number; listing: ListingLite }>>([])
  const [loadingDeals, setLoadingDeals] = useState(true)
  const [dealErr, setDealErr] = useState<string | null>(null)
  const [dealsLoaded, setDealsLoaded] = useState(false)
  const [autoRefreshDeals, setAutoRefreshDeals] = useState(false)
  const [showNewHunt, setShowNewHunt] = useState(false)

  // Saved Hunts state
  const [saved, setSaved] = useState<Array<{ listing: ListingLite; note: string | null; saved_at: string }>>([])
  const [loadingSaved, setLoadingSaved] = useState(true)
  const [savedErr, setSavedErr] = useState<string | null>(null)
  const [savedLoaded, setSavedLoaded] = useState(false)
  const [autoRefreshSaved, setAutoRefreshSaved] = useState(false)

  const loadFlips = useCallback(async function loadFlips() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('flipped_cars')
      .select('*')
      .order('purchase_date', { ascending: false })
    if (error) setError(error.message)
    setFlips(data || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { void loadFlips() }, [loadFlips])

  const loadTopDeals = useCallback(async function loadTopDeals() {
    setDealErr(null)
    if (!dealsLoaded) setLoadingDeals(true)
    try {
      const res = await fetch('/api/deal-scores/top?limit=15', { cache: 'no-store' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setDealErr(j.error || 'Failed to load deals')
      } else {
        const j: Array<{ score: number; confidence: number; listing: ListingLite }> = await res.json()
        // shallow compare by id+score to avoid flicker when unchanged
        const key = (arr: typeof j) => arr.map((x) => `${x.listing.id}:${x.score}`).join('|')
        if (key(j || []) !== key(deals || [])) setDeals(j || [])
      }
    } finally {
      if (!dealsLoaded) { setLoadingDeals(false); setDealsLoaded(true) }
    }
  }, [deals, dealsLoaded])

  const loadSaved = useCallback(async function loadSaved() {
    setSavedErr(null)
    if (!savedLoaded) setLoadingSaved(true)
    // Minimal: join saved_deals -> listings client-side
    const { data: savedRows, error: savedError } = await supabase.from('saved_deals').select('listing_id, note, saved_at').order('saved_at', { ascending: false })
    if (savedError) { setSavedErr(savedError.message); setLoadingSaved(false); return }
    const ids = (savedRows || []).map((r: { listing_id: string }) => r.listing_id)
    if (!ids.length) { setSaved([]); setLoadingSaved(false); setSavedLoaded(true); return }
    const { data: listings, error: listErr } = await supabase.from('listings').select('*').in('id', ids)
    if (listErr) { setSavedErr(listErr.message); setLoadingSaved(false); return }
    const byId = new Map<string, ListingLite>((listings || []).map((l: ListingLite) => [l.id, l]))
    const joined = (savedRows || []).map((r: { listing_id: string; note: string | null; saved_at: string }) => ({ listing: byId.get(r.listing_id)!, note: r.note, saved_at: r.saved_at }))
    const next = joined.filter((r) => !!r.listing)
    const key = (arr: typeof next) => arr.map((x) => x.listing.id).join('|')
    if (key(next) !== key(saved)) setSaved(next)
    setLoadingSaved(false); setSavedLoaded(true)
  }, [supabase, saved, savedLoaded])

  useEffect(() => { void loadTopDeals(); void loadSaved() }, [loadTopDeals, loadSaved])

  // Optional auto-refresh (off by default to avoid visible flicker)
  useEffect(() => {
    if (!autoRefreshDeals && !autoRefreshSaved) return
    const id = setInterval(() => {
      if (autoRefreshDeals) void loadTopDeals()
      if (autoRefreshSaved) void loadSaved()
    }, 7000)
    return () => clearInterval(id)
  }, [autoRefreshDeals, autoRefreshSaved, loadTopDeals, loadSaved])

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Analytics</h1>
        <AddFlipForm onCreated={loadFlips} />
      </header>

      {/* Three-card grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Card 1: Flips + Hunt */}
        <div className="rounded-2xl bg-neutral-900/60 ring-1 ring-white/10 divide-y divide-white/10 shadow-sm shadow-black/30">
          <div className="p-3 text-sm font-medium">Flips</div>
          {error && <div className="px-4 pb-2 text-sm text-red-600">Error: {error}</div>}
          {loading ? (
            <div className="p-4">Loading…</div>
          ) : (
            <div>
              {flips.map(f => (
                <div key={f.id} className="p-4 border-t border-white/10">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">
                      <div className="font-medium capitalize">{f.make} {f.model}</div>
                      <div className="text-gray-600">
                        {f.year} • {f.mileage.toLocaleString()} mi • bought ${f.purchase_price.toLocaleString()}
                        {f.sale_price ? <> • sold ${f.sale_price.toLocaleString()}</> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        className="px-3 py-1.5 text-sm rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10"
                        onClick={() => setExpandedId(expandedId === f.id ? null : f.id)}
                      >
                        {expandedId === f.id ? 'Close' : 'Hunt for similar deals'}
                      </button>
                    </div>
                  </div>
                  {expandedId === f.id && (
                    <div className="mt-4">
                      <WinsEditor make={f.make} model={f.model} seed={{ year: f.year, mileage: f.mileage, purchasePrice: f.purchase_price }} />
                    </div>
                  )}
                </div>
              ))}
              {flips.length === 0 && (
                <div className="p-8 text-sm text-neutral-400">No flips yet. Add your first one with “Add flip”.</div>
              )}
            </div>
          )}
        </div>

        {/* Card 2: Deal Scores (Top 15) */}
        <div className="rounded-2xl bg-neutral-900/60 ring-1 ring-white/10 divide-y divide-white/10 shadow-sm shadow-black/30">
          <div className="p-3 flex items-center justify-between">
            <div className="text-sm font-medium">Deal Scores (Top 15)</div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowNewHunt((s) => !s)} className="text-xs rounded-md bg-blue-600 text-white px-2 py-1 hover:bg-blue-500">
                {showNewHunt ? 'Close hunt' : 'Start new hunt'}
              </button>
              {deals.length > 0 && (
                <button
                  onClick={async () => { await dismissDealBulk(deals.map(d => d.listing.id)); await loadTopDeals() }}
                  className="text-xs rounded-md bg-neutral-800 text-neutral-200 ring-1 ring-white/10 px-2 py-1 hover:bg-neutral-700"
                >
                  Delete all
                </button>
              )}
              <button
                onClick={async () => { await fetch('/api/dismissed-deals', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }); await loadTopDeals() }}
                className="text-xs rounded-md bg-white/5 text-neutral-300 ring-1 ring-white/10 px-2 py-1 hover:bg-white/10"
              >
                Reset hidden
              </button>
              <label className="flex items-center gap-1 text-xs text-neutral-400">
                <input type="checkbox" checked={autoRefreshDeals} onChange={e => setAutoRefreshDeals(e.target.checked)} />
                Auto-refresh
              </label>
              <button onClick={() => void loadTopDeals()} className="text-xs rounded-md bg-white/5 text-neutral-300 ring-1 ring-white/10 px-2 py-1 hover:bg-white/10">Refresh</button>
            </div>
          </div>
          {dealErr && <div className="px-4 pb-2 text-sm text-red-600">Error: {dealErr}</div>}
          {showNewHunt && (
            <div className="px-3 pb-3 border-b border-white/10">
              <NewHuntEditor />
            </div>
          )}
          {loadingDeals ? (
            <div className="p-4">Loading…</div>
          ) : deals.length ? (
            <div className="max-h-96 overflow-y-auto">
              {deals.map((d, i) => (
                <div key={d.listing.id ?? i} className="p-3 border-t border-white/10">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <div className="font-medium capitalize">{d.listing.year} {d.listing.make} {d.listing.model}</div>
                      <div className="text-gray-600">{d.listing.mileage?.toLocaleString?.() ?? d.listing.mileage} mi • ${d.listing.price?.toLocaleString?.() ?? d.listing.price}</div>
                      {d.listing.url ? <a className="text-xs underline text-blue-300 hover:text-blue-200" href={d.listing.url} target="_blank" rel="noreferrer">Open listing</a> : null}
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <button className="text-xs rounded-md bg-emerald-600/90 text-white px-2 py-1 hover:bg-emerald-500" onClick={() => void saveDeal(d.listing.id)}>Save</button>
                      <button className="text-xs rounded-md bg-neutral-800 text-neutral-200 ring-1 ring-white/10 px-2 py-1 hover:bg-neutral-700" onClick={() => void dismissDeal(d.listing.id)}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4">
              <div className="mb-3 text-sm text-neutral-400">No deals right now.</div>
              <NewHuntEditor />
            </div>
          )}
        </div>

        {/* Card 3: Saved Hunts */}
        <div className="rounded-2xl bg-neutral-900/60 ring-1 ring-white/10 divide-y divide-white/10 shadow-sm shadow-black/30">
          <div className="p-3 flex items-center justify-between">
            <div className="text-sm font-medium">Saved Hunts</div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-neutral-400">
                <input type="checkbox" checked={autoRefreshSaved} onChange={e => setAutoRefreshSaved(e.target.checked)} />
                Auto-refresh
              </label>
              <button onClick={() => void loadSaved()} className="text-xs rounded-md bg-white/5 text-neutral-300 ring-1 ring-white/10 px-2 py-1 hover:bg-white/10">Refresh</button>
            </div>
          </div>
          {savedErr && <div className="px-4 pb-2 text-sm text-red-600">Error: {savedErr}</div>}
          {loadingSaved ? (
            <div className="p-4">Loading…</div>
          ) : saved.length ? (
            <div>
              {saved.map((s, i) => (
                <div key={s.listing.id ?? i} className="p-3 border-t border-white/10">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <div className="font-medium capitalize">{s.listing.year} {s.listing.make} {s.listing.model}</div>
                      <div className="text-gray-600">{s.listing.mileage?.toLocaleString?.() ?? s.listing.mileage} mi • ${s.listing.price?.toLocaleString?.() ?? s.listing.price}</div>
                      {s.listing.url ? <a className="text-xs underline text-blue-300 hover:text-blue-200" href={s.listing.url} target="_blank" rel="noreferrer">Open listing</a> : null}
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <button className="text-xs rounded-md bg-neutral-800 text-neutral-200 ring-1 ring-white/10 px-2 py-1 hover:bg-neutral-700" onClick={() => void unsaveDeal(s.listing.id)}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-neutral-400">No saved hunts yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function AddFlipForm({ onCreated }: { onCreated: () => void }) {
  const supabase = useMemo(() => supabaseBrowser(), [])
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [year, setYear] = useState<number | ''>('')
  const [mileage, setMileage] = useState<number | ''>('')
  const [purchasePrice, setPurchasePrice] = useState<number | ''>('')
  const [salePrice, setSalePrice] = useState<number | ''>('')

  async function save() {
    setSaving(true); setErr(null)
    const payload = {
      make: make.trim().toLowerCase(),
      model: model.trim().toLowerCase(),
      year: Number(year),
      mileage: Number(mileage),
      purchase_price: Number(purchasePrice),
      sale_price: salePrice === '' ? null : Number(salePrice),
      source: 'manual',
      purchase_date: new Date().toISOString(),
    }
    if (!payload.make || !payload.model || !payload.year || !payload.mileage || !payload.purchase_price) {
      setErr('Please fill required fields.'); setSaving(false); return
    }
    const { error } = await supabase.from('flipped_cars').insert(payload)
    if (error) { setErr(error.message) } else { onCreated(); setOpen(false) }
    setSaving(false)
  }

  if (!open) {
    return <button className="px-3 py-1.5 text-sm rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10" onClick={() => setOpen(true)}>Add flip</button>
  }
  return (
    <div className="p-4 rounded-2xl bg-neutral-900/70 ring-1 ring-white/10 shadow-sm">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="make (e.g., honda)" value={make} onChange={e => setMake(e.target.value)} />
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="model (e.g., civic)" value={model} onChange={e => setModel(e.target.value)} />
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="year" type="number" value={year} onChange={e => setYear(e.target.value === '' ? '' : Number(e.target.value))} />
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="mileage" type="number" value={mileage} onChange={e => setMileage(e.target.value === '' ? '' : Number(e.target.value))} />
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="purchase price" type="number" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value === '' ? '' : Number(e.target.value))} />
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="sale price (optional)" type="number" value={salePrice} onChange={e => setSalePrice(e.target.value === '' ? '' : Number(e.target.value))} />
      </div>
      {err && <div className="text-sm text-rose-400 mt-2">{err}</div>}
      <div className="mt-3 flex gap-2">
        <button disabled={saving} className="px-3 py-1.5 text-sm rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10" onClick={() => setOpen(false)}>Cancel</button>
        <button disabled={saving} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-500" onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

function WinsEditor({ make, model, seed }: { make: string; model: string; seed: WinPoint }) {
  const REQUIRED_POINTS = Number(process.env.NEXT_PUBLIC_MIN_WINS || 5) // 3 for testing, 5 for prod
  const [rows, setRows] = useState<WinPoint[]>([
    { ...seed }, // locked row 0 (from the flip the user clicked)
    // empty slots the user fills in
    ...Array.from({ length: Math.max(0, REQUIRED_POINTS - 1) }, () => ({ year: seed.year, mileage: seed.mileage, purchasePrice: seed.purchasePrice })),
  ])
  const [sources, setSources] = useState<string[]>(['offerup'])
  const [submitting, setSubmitting] = useState<'add' | 'run' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  function update(i: number, patch: Partial<WinPoint>) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  function addRow() {
    setRows(prev => [...prev, { year: seed.year, mileage: seed.mileage, purchasePrice: seed.purchasePrice }])
  }
  function removeRow(i: number) {
    if (i === 0) return // keep seed
    setRows(prev => prev.filter((_, idx) => idx !== i))
  }

  const canSubmit = rows.length >= 3 && rows.every((r) =>
    Number.isFinite(r.year) && Number.isFinite(r.mileage) && Number.isFinite(r.purchasePrice)
  )

  async function submit(runNow: boolean) {
    setSubmitting(runNow ? 'run' : 'add'); setErr(null); setOk(null)
    try {
      const payload = {
        make, model,
        wins: rows.map((r) => ({ year: Number(r.year), mileage: Number(r.mileage), purchasePrice: Number(r.purchasePrice) })),
        sources,
        runNow
      }
      const res = await fetch('/api/deal-finder/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || 'Failed to create job')
      setOk(`Job ${json.id} queued${runNow ? ' (run now)' : ''}.`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unexpected error'
      setErr(msg)
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="rounded-2xl bg-neutral-900/70 ring-1 ring-white/10 p-4 space-y-3">
      <div className="text-sm font-medium capitalize text-neutral-100">{make} {model}</div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-neutral-400">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">Year</th>
            <th className="py-1 pr-2">Mileage</th>
            <th className="py-1 pr-2">Bought for ($)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-middle">
              <td className="py-1 pr-2">{i + 1}</td>
              <td className="py-1 pr-2">
                <input className={`w-24 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 border ${i===0?'bg-neutral-900/40 text-neutral-300 border-white/10':'bg-neutral-950 text-neutral-200 border-white/10 placeholder:text-neutral-500'}`} type="number" value={numberOrEmpty(r.year)}
                  onChange={e => update(i, { year: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  disabled={i === 0} />
              </td>
              <td className="py-1 pr-2">
                <input className={`w-28 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 border ${i===0?'bg-neutral-900/40 text-neutral-300 border-white/10':'bg-neutral-950 text-neutral-200 border-white/10 placeholder:text-neutral-500'}`} type="number" value={numberOrEmpty(r.mileage)}
                  onChange={e => update(i, { mileage: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  disabled={i === 0} />
              </td>
              <td className="py-1 pr-2">
                <input className={`w-32 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 border ${i===0?'bg-neutral-900/40 text-neutral-300 border-white/10':'bg-neutral-950 text-neutral-200 border-white/10 placeholder:text-neutral-500'}`} type="number" value={numberOrEmpty(r.purchasePrice)}
                  onChange={e => update(i, { purchasePrice: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  disabled={i === 0} />
              </td>
              <td className="py-1 pr-2">
                {i > 0 && (
                  <button className="text-xs text-neutral-300 hover:text-white" onClick={() => removeRow(i)}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-3">
        <button className="px-2 py-1 text-xs rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10" onClick={addRow}>Add row</button>
        <span className="text-xs text-neutral-400">Need at least 3 points; 5 recommended.</span>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-neutral-300">Sources:</label>
        <label className="text-sm flex items-center gap-1 text-neutral-300">
          <input type="checkbox" checked={sources.includes('offerup')}
            onChange={e => setSources(s => e.target.checked ? Array.from(new Set([...s, 'offerup'])) : s.filter(x => x !== 'offerup'))} />
          OfferUp
        </label>
      </div>

      {err && <div className="text-sm text-rose-400">{err}</div>}
      {ok && <div className="text-sm text-emerald-400">{ok}</div>}

      <div className="flex items-center gap-2">
        <button disabled={!canSubmit || !!submitting} className="px-3 py-1.5 text-sm rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50" onClick={() => submit(false)}>
          {submitting === 'add' ? 'Adding…' : 'Add to job'}
        </button>
        <button disabled={!canSubmit || !!submitting} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50" onClick={() => submit(true)}>
          {submitting === 'run' ? 'Starting…' : 'Search now'}
        </button>
      </div>
    </div>
  )
}

// Helpers for Deal Scores card actions
async function saveDeal(listingId: string) {
  await fetch('/api/saved-deals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingId }) })
}
async function unsaveDeal(listingId: string) {
  await fetch('/api/saved-deals', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingId }) })
}
async function dismissDeal(listingId: string) {
  await fetch('/api/dismissed-deals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingId }) })
}
async function dismissDealBulk(listingIds: string[]) {
  if (!listingIds.length) return
  await fetch('/api/dismissed-deals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingIds }) })
}

// Empty-state new hunt editor (manual 3–5 wins + make/model)
function NewHuntEditor() {
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const REQUIRED_POINTS = Number(process.env.NEXT_PUBLIC_MIN_WINS || 5)
  const [rows, setRows] = useState<WinPoint[]>(
    Array.from({ length: Math.max(3, REQUIRED_POINTS) }, () => ({ year: NaN as unknown as number, mileage: NaN as unknown as number, purchasePrice: NaN as unknown as number }))
  )
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  function update(i: number, patch: Partial<WinPoint>) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  function addRow() { setRows(prev => [...prev, { year: NaN as unknown as number, mileage: NaN as unknown as number, purchasePrice: NaN as unknown as number }]) }
  function removeRow(i: number) { setRows(prev => prev.filter((_, idx) => idx !== i)) }

  const canSubmit = !!make && !!model && rows.length >= 3 && rows.every(r => Number.isFinite(r.year) && Number.isFinite(r.mileage) && Number.isFinite(r.purchasePrice))

  async function submit(runNow: boolean) {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const payload = { make: make.trim().toLowerCase(), model: model.trim().toLowerCase(), wins: rows.map(r => ({ year: Number(r.year), mileage: Number(r.mileage), purchasePrice: Number(r.purchasePrice) })), sources: ['offerup'], runNow }
      const res = await fetch('/api/deal-finder/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await res.json()
      if (!res.ok) throw new Error(j?.error || 'Failed to create job')
      setMsg(`Job ${j.id} queued${runNow ? ' (run now)' : ''}.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unexpected error')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-2xl bg-neutral-900/70 ring-1 ring-white/10 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="make" value={make} onChange={e => setMake(e.target.value)} />
        <input className="rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50" placeholder="model" value={model} onChange={e => setModel(e.target.value)} />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-neutral-400">
            <th className="py-1 pr-2">Year</th>
            <th className="py-1 pr-2">Mileage</th>
            <th className="py-1 pr-2">Bought for ($)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-1 pr-2"><input className="w-24 rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50" type="number" value={numberOrEmpty(r.year)} onChange={e => update(i, { year: e.target.value === '' ? Number.NaN : Number(e.target.value) })} /></td>
              <td className="py-1 pr-2"><input className="w-28 rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50" type="number" value={numberOrEmpty(r.mileage)} onChange={e => update(i, { mileage: e.target.value === '' ? Number.NaN : Number(e.target.value) })} /></td>
              <td className="py-1 pr-2"><input className="w-32 rounded-md bg-neutral-950 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50" type="number" value={numberOrEmpty(r.purchasePrice)} onChange={e => update(i, { purchasePrice: e.target.value === '' ? Number.NaN : Number(e.target.value) })} /></td>
              <td className="py-1 pr-2">{rows.length > 3 && <button className="text-xs text-neutral-300 hover:text-white" onClick={() => removeRow(i)}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        <button className="px-2 py-1 text-xs rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10" onClick={addRow}>Add row</button>
        <span className="text-xs text-neutral-400">3–5 points recommended.</span>
      </div>
      {err && <div className="text-sm text-rose-400">{err}</div>}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}
      <div className="flex items-center gap-2">
        <button disabled={!canSubmit || busy} className="px-3 py-1.5 text-sm rounded-md bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50" onClick={() => void submit(false)}>{busy ? 'Adding…' : 'Add to job'}</button>
        <button disabled={!canSubmit || busy} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-500" onClick={() => void submit(true)}>{busy ? 'Starting…' : 'Search now'}</button>
      </div>
    </div>
  )
}
