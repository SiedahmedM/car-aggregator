// app/page.tsx
import Link from 'next/link'
import { supaAdmin } from '@/lib/supabase-admin'
import { DealScoresTable } from '@/app/components/DealScoresTable'
import { LiveMarketFeed } from '@/app/components/LiveMarketFeed'

export const revalidate = 0

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

// Type for the Smart Search Deal
type SmartDeal = {
  score: number
  confidence: number
  listing: ListingRow
}

// --- MAIN PAGE ---

export default async function Page({ searchParams }: { searchParams?: Record<string, string> }) {
  const sp = searchParams || {}

  // --- DATA FETCHING ---

  // Clear smart deals - will show empty state (no data fetching for now)
  const smartDeals: SmartDeal[] = []

  // 2. The Raw Feed (Live Market Feed)
  const minYear = parseInt(sp.minYear || '') || 0
  const maxYear = parseInt(sp.maxYear || '') || 0
  const minMileage = parseInt(sp.minMileage || '') || 0
  const maxMileage = parseInt(sp.maxMileage || '') || 0
  const makes = (sp.makes || '').split(',').filter(Boolean)
  const cities = (sp.cities || '').split(',').filter(Boolean)
  const sources = (sp.sources || '').split(',').filter(Boolean)
  const age = sp.age || ''

  let query = supaAdmin
    .from('listings')
    .select('*')
    .order('first_seen_at', { ascending: false }) // Order by first_seen_at for most recently scraped
    .limit(500) // Show up to 500 listings in UI (newest first, within 48h window)

  // Apply default 48-hour filter for Live Market Feed (unless user specifies 'age')
  const now = Date.now()
  if (age) {
    const ms =
      age === '30m' ? 30 * 60 * 1000 : age === '2h' ? 2 * 60 * 60 * 1000 : age === '6h' ? 6 * 60 * 60 * 1000 : age === '24h' ? 24 * 60 * 60 * 1000 : age === '7d' ? 7 * 24 * 60 * 60 * 1000 : 0
    if (ms) {
      const sinceIso = new Date(now - ms).toISOString()
      query = query.gte('first_seen_at', sinceIso)
    }
  } else {
    // Default: only show listings from last 48 hours
    const since48h = new Date(now - 48 * 60 * 60 * 1000).toISOString()
    query = query.gte('first_seen_at', since48h)
  }

  // Ensure first_seen_at is not null (exclude old listings without timestamps)
  query = query.not('first_seen_at', 'is', null)

  // Apply filters
  if (minYear) query = query.gte('year', minYear)
  if (maxYear) query = query.lte('year', maxYear)
  if (minMileage) query = query.gte('mileage', minMileage)
  if (maxMileage) query = query.lte('mileage', maxMileage)
  if (makes.length) query = query.in('make', makes)
  if (cities.length) query = query.in('city', cities)
  if (sources.length) query = query.in('source', sources)

  const { data: rawData, error } = await query
  if (error) return <div className="p-6 text-rose-400">Error: {error.message}</div>

  // Listings from main feed
  // Listings from main feed
  const rows: ListingRow[] = (rawData || []) as ListingRow[]

  // --- Watched Listings Join Types ---
  type WatchedRow = {
    listing_id: string
    watched_at: string
    listings: ListingRow[]       // Supabase returns an ARRAY when using listings(*)
  }

  type WatchedListing = ListingRow & { watched_at: string }

  // Fetch watched listings
  const { data: watchedData } = await supaAdmin
    .from('watched_listings')
    .select('listing_id, watched_at, listings(*)')
    .order('watched_at', { ascending: false })

  // Flatten watched listings with joined data - handle array from Supabase join
  const watchedListings: WatchedListing[] = ((watchedData || []) as unknown as WatchedRow[])
    .filter(w => Array.isArray(w.listings) && w.listings.length > 0)
    .map(w => ({
      ...w.listings[0],  // Take first element from the array
      watched_at: w.watched_at,
    }))

  // Filter out watched listings from main feed
  const watchedIds = new Set(watchedListings.map(w => w.id))
  const filteredRows = rows.filter(r => !watchedIds.has(r.id))

  // Separate exotics ($100k+) from regular listings
  const EXOTIC_THRESHOLD = 100000
  const exoticListings = filteredRows.filter(r => r.price && r.price >= EXOTIC_THRESHOLD)
  const regularListings = filteredRows.filter(r => !r.price || r.price < EXOTIC_THRESHOLD)

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 pb-20">
      
      {/* HEADER */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/70 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight text-neutral-100 flex items-center gap-2">
            Saifnesse <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">BETA</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-md px-3 py-1.5 bg-white/5 text-white font-medium">Listings</Link>
            <Link href="/offerup" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Searches</Link>
            <Link href="/dashboard" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Dashboard</Link>
            <Link href="/admin" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Admin</Link>
          </nav>
          <div className="md:hidden text-sm text-neutral-400">Menu</div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 space-y-8">

        {/* === LIVE MARKET FEED WITH WATCH/DELETE === */}
        <LiveMarketFeed
          initialListings={regularListings}
          initialExotics={exoticListings}
          initialWatched={watchedListings}
          searchParams={sp}
        />

        {/* === SMART SEARCH RESULTS (Top 15 Deals Ranked by Score) === */}
        <DealScoresTable deals={smartDeals} />

      </div>
    </main>
  )
}