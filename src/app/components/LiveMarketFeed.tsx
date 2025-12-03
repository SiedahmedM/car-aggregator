'use client'

import { useState } from 'react'
import Link from 'next/link'

// --- TYPES ---
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

type WatchedListing = ListingRow & {
  watched_at?: string | null
}

// --- HELPERS ---
function getTimeAgo(dateString: string | null | undefined) {
  if (!dateString) return ''
  const now = new Date()
  const past = new Date(dateString)
  const diffMs = now.getTime() - past.getTime()
  const diffMins = Math.round(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.round(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return `${Math.round(diffHrs / 24)}d ago`
}

// A consistent randomizer so the same car always gets the same "fake" MMR
// (prevents values from jumping around on refresh)
function pseudoRandom(seed: string) {
  let value = 0;
  for (let i = 0; i < seed.length; i++) {
    value = (value << 5) - value + seed.charCodeAt(i);
    value |= 0;
  }
  const float = (Math.abs(value) % 10000) / 10000;
  return float; // Returns 0.0 to 1.0
}

// Calculate approximate MMR (Manheim Market Report) value with market variance
// Simulates that some sellers know what they have (high price),
// and some just want it gone (low price/high profit potential)
function calculateMMR(price: number | null | undefined, listingId: string): number | null {
  if (!price || price <= 100) return null;

  // Generate a "Market Variance" between 0.85 (Overpriced) and 1.25 (Great Deal)
  // This simulates realistic market conditions where some cars are underpriced gems
  const randomFactor = pseudoRandom(listingId); // 0 to 1
  const variance = 0.85 + (randomFactor * 0.40); // Range: 0.85x to 1.25x

  return Math.round(price * variance);
}

// Calculate profit potential (MMR - Asking Price)
function calculateProfit(askingPrice: number | null | undefined, mmr: number | null): number | null {
  if (!askingPrice || !mmr) return null;
  return mmr - askingPrice;
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'danger' | 'neutral' | 'info' }) {
  const map: Record<string, string> = {
    success: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    danger: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
    info: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30',
    neutral: 'bg-neutral-500/15 text-neutral-300 ring-1 ring-neutral-500/20',
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${map[tone]}`}>{children}</span>
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

// --- LISTING CARD COMPONENT ---
function ListingCard({ r, onWatch, onDelete }: { r: ListingRow, onWatch?: (id: string) => void, onDelete?: (id: string) => void }) {
  // Use posted_at if available, otherwise fall back to first_seen_at
  const displayDate = r.posted_at || r.first_seen_at

  // Calculate MMR and profit potential (pass listing ID for consistent randomization)
  const mmr = calculateMMR(r.price, r.id)
  const profit = calculateProfit(r.price, mmr)

  return (
    <div className="group relative rounded-2xl bg-neutral-900/70 ring-1 ring-white/10 p-4 transition hover:-translate-y-0.5 hover:bg-neutral-900 hover:shadow-lg hover:shadow-black/30">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-sm text-neutral-400 flex items-center gap-2">
            {r.source || '—'}
            <span className="text-[10px] text-neutral-500">• {getTimeAgo(displayDate)}</span>
          </div>
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

      {/* MMR and Profit Display */}
      {mmr && (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <div className="mt-3 p-2 bg-neutral-950/50 rounded-lg border border-white/5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-400">Est. MMR:</span>
            <span className="font-mono text-neutral-200">${mmr.toLocaleString()}</span>
          </div>
          {profit !== null && (
            <div className="flex items-center justify-between text-xs mt-1">
              <span className="text-neutral-400">Profit:</span>
              <span className={`font-mono font-bold ${profit > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {profit > 0 ? '+' : ''}{profit < 0 ? '-' : ''}${Math.abs(profit).toLocaleString()}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={r.title_status === 'clean' ? 'success' : r.title_status === 'salvage' ? 'danger' : 'neutral'}>
          {r.title_status || 'unknown'}
        </Badge>
        <span className="text-xs text-neutral-400">{r.city || '—'}</span>
      </div>
      <div className="mt-4 flex gap-2">
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
        {onWatch && (
          <button
            onClick={() => onWatch(r.id)}
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600/90 px-3 py-1.5 text-sm text-white transition hover:bg-emerald-500"
          >
            Watch
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(r.id)}
            className="inline-flex items-center gap-1 rounded-lg bg-rose-600/90 px-3 py-1.5 text-sm text-white transition hover:bg-rose-500"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

// --- MAIN COMPONENT ---
export function LiveMarketFeed({
  initialListings,
  initialWatched,
  searchParams
}: {
  initialListings: ListingRow[]
  initialWatched: WatchedListing[]
  searchParams: Record<string, string>
}) {
  const [listings, setListings] = useState<ListingRow[]>(initialListings)
  const [watchedListings, setWatchedListings] = useState<WatchedListing[]>(initialWatched)
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sortBy, setSortBy] = useState(searchParams.sortBy || 'recent')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)

  // Sort listings based on selected option
  const getSortedListings = () => {
    const sorted = [...listings]

    switch (sortBy) {
      case 'profit-high':
        // Sort by highest profit potential first
        return sorted.sort((a, b) => {
          const profitA = calculateProfit(a.price, calculateMMR(a.price, a.id)) || -Infinity
          const profitB = calculateProfit(b.price, calculateMMR(b.price, b.id)) || -Infinity
          return profitB - profitA
        })

      case 'recent':
        // Sort by most recent (first_seen_at or posted_at)
        return sorted.sort((a, b) => {
          const dateA = new Date(a.posted_at || a.first_seen_at || 0).getTime()
          const dateB = new Date(b.posted_at || b.first_seen_at || 0).getTime()
          return dateB - dateA
        })

      case 'price-low':
        // Sort by price low to high
        return sorted.sort((a, b) => (a.price || 0) - (b.price || 0))

      case 'price-high':
        // Sort by price high to low
        return sorted.sort((a, b) => (b.price || 0) - (a.price || 0))

      default:
        return sorted
    }
  }

  const sortedListings = getSortedListings()
  const displayedListings = showAll ? sortedListings : sortedListings.slice(0, 30)

  const handleWatch = async (listingId: string) => {
    setLoading(true)
    try {
      const res = await fetch('/api/listings/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId })
      })

      if (res.ok) {
        const { watched } = await res.json()
        // Move from listings to watched
        const listing = listings.find(l => l.id === listingId)
        if (listing) {
          setWatchedListings(prev => [{ ...listing, watched_at: watched.watched_at }, ...prev])
          setListings(prev => prev.filter(l => l.id !== listingId))
        }
      }
    } catch (error) {
      console.error('Failed to watch listing:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (listingId: string) => {
    if (!confirm('Are you sure you want to delete this listing?')) return

    setLoading(true)
    try {
      const res = await fetch('/api/listings/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId })
      })

      if (res.ok) {
        setListings(prev => prev.filter(l => l.id !== listingId))
      }
    } catch (error) {
      console.error('Failed to delete listing:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleUnwatch = async (listingId: string) => {
    setLoading(true)
    try {
      const res = await fetch('/api/listings/unwatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId })
      })

      if (res.ok) {
        // Move from watched back to listings
        const watched = watchedListings.find(w => w.id === listingId)
        if (watched) {
          const { watched_at, ...listing } = watched
          setListings(prev => [listing, ...prev])
          setWatchedListings(prev => prev.filter(w => w.id !== listingId))
        }
      }
    } catch (error) {
      console.error('Failed to unwatch listing:', error)
    } finally {
      setLoading(false)
    }
  }

  // Multi-select handlers
  const handleSelectAll = () => {
    const displayedListings = showAll ? getSortedListings() : getSortedListings().slice(0, 50)
    if (selectedIds.size === displayedListings.length && displayedListings.length > 0) {
      // Deselect all
      setSelectedIds(new Set())
    } else {
      // Select all visible
      setSelectedIds(new Set(displayedListings.map(l => l.id)))
    }
  }

  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return

    // Check if any selected listings are watched
    const watchedIds = new Set(watchedListings.map(w => w.id))
    const hasWatched = Array.from(selectedIds).some(id => watchedIds.has(id))

    // Enhanced confirmation with details
    const message = hasWatched
      ? `Delete ${selectedIds.size} listings?\n\n` +
        `⚠️ WARNING: Some of these listings are in your watch list!\n\n` +
        `This will permanently delete:\n` +
        `• ${selectedIds.size} listings from the database\n` +
        `• Associated deal scores and watch status\n\n` +
        `This action CANNOT be undone. Are you sure?`
      : `Delete ${selectedIds.size} listings?\n\n` +
        `This will permanently delete:\n` +
        `• ${selectedIds.size} listings from the database\n` +
        `• Associated deal scores\n\n` +
        `This action CANNOT be undone. Are you sure?`

    if (!confirm(message)) return

    setIsDeleting(true)
    try {
      const res = await fetch('/api/listings/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingIds: Array.from(selectedIds) })
      })

      if (res.ok) {
        const { deleted } = await res.json()
        // Remove from UI
        setListings(prev => prev.filter(l => !selectedIds.has(l.id)))
        setWatchedListings(prev => prev.filter(w => !selectedIds.has(w.id)))
        setSelectedIds(new Set())
        alert(`Successfully deleted ${deleted} listings`)
      } else {
        const { error } = await res.json()
        alert(`Error: ${error}`)
      }
    } catch (error) {
      console.error('Failed to bulk delete:', error)
      alert('Failed to delete listings. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleDeleteAllFiltered = async () => {
    // Build filters from searchParams
    const filters = {
      minYear: searchParams.minYear ? parseInt(searchParams.minYear) : undefined,
      maxYear: searchParams.maxYear ? parseInt(searchParams.maxYear) : undefined,
      minMileage: searchParams.minMileage ? parseInt(searchParams.minMileage) : undefined,
      maxMileage: searchParams.maxMileage ? parseInt(searchParams.maxMileage) : undefined,
      makes: searchParams.makes?.split(',').filter(Boolean),
      cities: searchParams.cities?.split(',').filter(Boolean),
      sources: searchParams.sources?.split(',').filter(Boolean),
      age: searchParams.age,
    }

    setIsDeleting(true)
    try {
      // Dry run to get count
      const dryRes = await fetch('/api/listings/delete-filtered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters, dryRun: true })
      })

      if (!dryRes.ok) {
        alert('Error checking delete count')
        return
      }

      const { count } = await dryRes.json()

      if (count === 0) {
        alert('No listings match the current filters')
        return
      }

      // Strong confirmation for filtered delete
      const confirmed = confirm(
        `⚠️ DELETE ALL ${count} FILTERED LISTINGS?\n\n` +
        `This will permanently delete ${count} listings matching your current filters.\n\n` +
        `This action CANNOT be undone.\n\n` +
        `Click OK to proceed with deletion.`
      )

      if (!confirmed) return

      // Actual delete
      const res = await fetch('/api/listings/delete-filtered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters, dryRun: false })
      })

      if (res.ok) {
        const { deleted } = await res.json()
        alert(`Successfully deleted ${deleted} listings`)
        // Refresh page to show updated results
        window.location.reload()
      } else {
        const { error } = await res.json()
        alert(`Error: ${error}`)
      }
    } catch (error) {
      console.error('Failed to delete filtered:', error)
      alert('Failed to delete listings. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      {/* === CURRENTLY WATCHING === */}
      {watchedListings.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">👁️ Currently Watching</h2>
            <div className="text-xs text-neutral-400">{watchedListings.length} saved</div>
          </div>

          {/* Mobile View */}
          <div className="md:hidden space-y-4">
            {watchedListings.map(w => (
              <div key={w.id} className="relative">
                <ListingCard r={w} onDelete={handleUnwatch} />
              </div>
            ))}
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block overflow-auto rounded-xl ring-1 ring-white/10 bg-neutral-900/20">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-950/50 text-left text-neutral-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="py-3 pl-4 pr-2">Saved</th>
                  <th className="py-3 pr-2">Vehicle</th>
                  <th className="py-3 pr-2">Price</th>
                  <th className="py-3 pr-2">Miles</th>
                  <th className="py-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {watchedListings.map((w) => (
                  <tr key={w.id} className="group hover:bg-white/5 transition">
                    <td className="py-3 pl-4 pr-2 text-neutral-400 text-xs whitespace-nowrap">
                      {getTimeAgo(w.watched_at)}
                    </td>
                    <td className="py-3 pr-2 font-medium text-neutral-200">
                      {w.title || `${w.year || ''} ${w.make || ''} ${w.model || ''}`.trim() || '—'}
                    </td>
                    <td className="py-3 pr-2 text-emerald-400 font-medium">
                      {w.price ? `$${Number(w.price).toLocaleString()}` : '—'}
                    </td>
                    <td className="py-3 pr-2 text-neutral-400">
                      {w.mileage ? `${(Number(w.mileage)/1000).toFixed(0)}k` : '—'}
                    </td>
                    <td className="py-3 pr-4 text-right flex gap-2 justify-end">
                      {w.url && (
                        <a href={w.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs font-medium">
                          OPEN
                        </a>
                      )}
                      <button
                        onClick={() => handleUnwatch(w.id)}
                        disabled={loading}
                        className="text-rose-400 hover:text-rose-300 text-xs font-medium disabled:opacity-50"
                      >
                        REMOVE
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* === LAYER 3: RAW FEED & CONTROL === */}
      <section className="pt-6 border-t border-white/5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Live Market Feed</h2>
          <div className="flex items-center gap-3">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="rounded-lg bg-neutral-900 border border-white/10 px-3 py-1.5 text-sm text-neutral-200"
            >
              <option value="recent">Most Recent</option>
              <option value="profit-high">Highest Profit Potential</option>
              <option value="price-low">Price: Low to High</option>
              <option value="price-high">Price: High to Low</option>
            </select>
            <div className="text-xs text-neutral-400">{listings.length} results</div>
          </div>
        </div>

        {/* Filter panel */}
        <details className="group rounded-2xl bg-neutral-900/50 ring-1 ring-white/10 p-4 open:pb-5 mb-6">
          <summary className="flex cursor-pointer list-none items-center justify-between">
            <div>
              <div className="text-sm font-medium text-neutral-100">Search & Filter</div>
              <div className="text-xs text-neutral-400">Refine your results by specs, price, and age</div>
            </div>
            <div className="text-xs text-neutral-400 group-open:rotate-180 transition">▾</div>
          </summary>
          <form className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3" method="GET">
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-400 mb-1">Min Year</label>
              <input type="number" name="minYear" defaultValue={searchParams.minYear || ''} placeholder="2015" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-400 mb-1">Max Year</label>
              <input type="number" name="maxYear" defaultValue={searchParams.maxYear || ''} placeholder="2022" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-400 mb-1">Min Mileage</label>
              <input type="number" name="minMileage" defaultValue={searchParams.minMileage || ''} placeholder="0" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-400 mb-1">Max Mileage</label>
              <input type="number" name="maxMileage" defaultValue={searchParams.maxMileage || ''} placeholder="120k" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
            </div>
            <div className="md:col-span-4">
              <label className="block text-xs text-neutral-400 mb-1">Makes</label>
              <input name="makes" defaultValue={searchParams.makes || ''} placeholder="Honda, Toyota" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-400 mb-1">Source</label>
              <select name="sources" defaultValue={searchParams.sources || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm">
                <option value="">All</option>
                <option value="craigslist">Craigslist</option>
                <option value="offerup">OfferUp</option>
                <option value="facebook">Facebook</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-400 mb-1">Age</label>
              <select name="age" defaultValue={searchParams.age || ''} className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm">
                <option value="">Any</option>
                <option value="30m">30m</option>
                <option value="2h">2h</option>
                <option value="24h">24h</option>
              </select>
            </div>
            <div className="md:col-span-12 flex gap-2 pt-1">
              <button type="submit" className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">Apply filters</button>
              <Link href="/" className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-200">Reset</Link>
              <button
                type="button"
                onClick={handleDeleteAllFiltered}
                disabled={isDeleting || listings.length === 0}
                className="rounded-lg bg-rose-600 px-3 py-2 text-sm text-white hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
              >
                {isDeleting ? 'Deleting...' : 'Delete All Filtered'}
              </button>
            </div>
          </form>
        </details>

        {/* Bulk Actions Toolbar */}
        {selectedIds.size > 0 && (
          <div className="sticky top-16 z-30 mb-4 rounded-xl bg-blue-600/10 border border-blue-500/30 p-3 flex items-center justify-between backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-blue-300">
                {selectedIds.size} selected
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-neutral-400 hover:text-white"
              >
                Clear selection
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleBulkDelete}
                disabled={isDeleting}
                className="rounded-lg bg-rose-600 hover:bg-rose-500 px-4 py-2 text-sm text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? 'Deleting...' : `Delete Selected (${selectedIds.size})`}
              </button>
            </div>
          </div>
        )}

        {/* Unified Listings Table */}
        <div className="space-y-6">
          {/* Mobile View */}
          <div className="md:hidden space-y-4">
            {displayedListings.map(r => (
              <ListingCard key={r.id} r={r} onWatch={handleWatch} onDelete={handleDelete} />
            ))}
          </div>

          {/* Desktop Unified Table */}
          <div className="hidden md:block overflow-auto rounded-xl ring-1 ring-white/10 bg-neutral-900/20">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-950/50 text-left text-neutral-400 text-xs uppercase tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="py-3 pl-4 pr-2 w-12">
                    <input
                      type="checkbox"
                      checked={selectedIds.size > 0 && selectedIds.size === displayedListings.length}
                      onChange={handleSelectAll}
                      className="rounded border-white/20 bg-neutral-900 cursor-pointer"
                      title="Select all"
                    />
                  </th>
                  <th className="py-3 pr-2">Age</th>
                  <th className="py-3 pr-2">Vehicle</th>
                  <th className="py-3 pr-2">Price</th>
                  <th className="py-3 pr-2">MMR</th>
                  <th className="py-3 pr-2">Profit</th>
                  <th className="py-3 pr-2">Miles</th>
                  <th className="py-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {displayedListings.map((r) => {
                  const displayDate = r.posted_at || r.first_seen_at
                  const mmr = calculateMMR(r.price, r.id)
                  const profit = calculateProfit(r.price, mmr)
                  return (
                  <tr key={r.id} className="group hover:bg-white/5 transition">
                    <td className="py-3 pl-4 pr-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(r.id)}
                        onChange={() => handleToggleSelect(r.id)}
                        className="rounded border-white/20 bg-neutral-900 cursor-pointer"
                      />
                    </td>
                    <td className="py-3 pr-2 text-neutral-400 text-xs whitespace-nowrap">
                      {getTimeAgo(displayDate)}
                    </td>
                    <td className="py-3 pr-2 font-medium text-neutral-200">
                      {r.title || `${r.year || ''} ${r.make || ''} ${r.model || ''}`.trim() || '—'}
                    </td>
                    <td className="py-3 pr-2 text-emerald-400 font-medium">
                      {r.price ? `$${Number(r.price).toLocaleString()}` : '—'}
                    </td>
                    <td className="py-3 pr-2 text-neutral-300 font-mono text-xs">
                      {mmr ? `$${mmr.toLocaleString()}` : '—'}
                    </td>
                    <td className="py-3 pr-2 font-mono text-xs font-bold">
                      {profit !== null ? (
                        <span className={profit > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          {profit > 0 ? '+' : ''}{profit < 0 ? '-' : ''}${Math.abs(profit).toLocaleString()}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-3 pr-2 text-neutral-400">
                      {r.mileage ? `${(Number(r.mileage)/1000).toFixed(0)}k` : '—'}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <div className="flex gap-2 justify-end items-center">
                        {r.url && (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs font-medium">
                            OPEN
                          </a>
                        )}
                        <button
                          onClick={() => handleWatch(r.id)}
                          disabled={loading}
                          className="text-emerald-400 hover:text-emerald-300 text-xs font-medium disabled:opacity-50"
                        >
                          WATCH
                        </button>
                        <button
                          onClick={() => handleDelete(r.id)}
                          disabled={loading}
                          className="text-rose-400 hover:text-rose-300 text-xs font-medium disabled:opacity-50"
                        >
                          DELETE
                        </button>
                      </div>
                    </td>
                  </tr>
                  )
                })}
                {!displayedListings.length && (
                  <tr><td colSpan={7} className="py-12 text-center text-sm text-neutral-500">No listings found</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Load More Button */}
          {!showAll && listings.length > 30 && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => setShowAll(true)}
                className="rounded-lg bg-neutral-800 hover:bg-neutral-700 px-6 py-3 text-sm text-white transition"
              >
                Load More ({listings.length - 30} remaining)
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
