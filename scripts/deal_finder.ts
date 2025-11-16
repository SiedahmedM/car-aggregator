import { createClient } from '@supabase/supabase-js'
import { scoreListings } from '../src/lib/scoring/combined'
import { computeTradeoffParams } from '../src/lib/tradeoff/scorer'
import type { FlippedCar, Listing } from '../src/lib/knn/types'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!
const supaSvc = createClient(SUPA_URL, SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

interface DealFinderParams {
  referenceCarIds: string[]
  sources?: string[]
  userId?: string
}

// map DB rows (snake_case) to domain (camelCase) for KNN
function mapFlippedCar(row: any): FlippedCar {
  return {
    id: row.id,
    year: row.year,
    make: row.make,
    model: row.model,
    mileage: row.mileage,
    price: row.purchase_price, // not used directly in KNN for flipped cars
    purchasePrice: row.purchase_price,
    salePrice: row.sale_price,
    profit: row.profit,
    profitPercentage: row.profit_percentage,
    daysToFlip: row.days_to_flip,
    source: row.source,
    purchaseDate: row.purchase_date,
    saleDate: row.sale_date,
    notes: row.notes ?? undefined,
  }
}

function mapListing(row: any): Listing {
  return {
    id: row.id,
    year: row.year,
    make: row.make,
    model: row.model,
    mileage: row.mileage,
    price: row.price,
    source: row.source,
    url: row.url,
    title: row.title ?? null,
    city: row.city ?? null,
    postedAt: row.posted_at ?? null,
  }
}

export async function runDealFinder(params: DealFinderParams) {
  const { referenceCarIds, sources = ['offerup'], userId } = params

  console.log('[DEAL-FINDER] Starting...', { referenceCarIds, sources })

  // 1. Fetch reference cars
  const { data: referenceRows, error: refError } = await supaSvc
    .from('flipped_cars')
    .select('*')
    .in('id', referenceCarIds)

  if (refError || !referenceRows?.length) {
    throw new Error(`Failed to fetch reference cars: ${refError?.message}`)
  }

  const referenceCars = referenceRows.map(mapFlippedCar)

  if (referenceCars.length < 3) {
    throw new Error(`Need at least 3 reference cars, got ${referenceCars.length}`)
  }

  // Verify all same make/model
  const { make, model } = referenceCars[0]
  const allSame = referenceCars.every(c => c.make === make && c.model === model)
  if (!allSame) {
    throw new Error('All reference cars must be the same make and model')
  }

  console.log(`[DEAL-FINDER] Loaded ${referenceCars.length} reference ${make} ${model}s`)

  // Log basic reference ranges for sanity/debugging
  const years = referenceCars.map(c => c.year)
  const mileages = referenceCars.map(c => c.mileage)
  const prices = referenceCars.map(c => c.purchasePrice)
  console.log('[DEAL-FINDER] Reference range:', {
    year: { min: Math.min(...years), max: Math.max(...years) },
    mileage: { min: Math.min(...mileages), max: Math.max(...mileages) },
    purchasePrice: { min: Math.min(...prices), max: Math.max(...prices) },
  })

  // Extra: tradeoff parameters preview
  try {
    const p = computeTradeoffParams(referenceCars)
    console.log('[DEAL-FINDER] Tradeoff params:', p)
  } catch (err) {
    console.error('[DEAL-FINDER] Failed to compute tradeoff params:', err)
  }

  // 2. Fetch recent listings in an explicit time window (default 5 days)
  const WINDOW_DAYS = Number(process.env.DEAL_WINDOW_DAYS ?? 5)
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  
  const { data: listingRows, error: listError } = await supaSvc
    .from('listings')
    .select('*')
    .in('source', sources)
    .eq('make', make)
    .eq('model', model)
    .gte('posted_at', sinceIso)
    .order('posted_at', { ascending: false })

  if (listError) {
    throw new Error(`Failed to fetch listings: ${listError.message}`)
  }

  const listings = (listingRows ?? []).map(mapListing)
  console.log(`[DEAL-FINDER] Found ${listings.length} recent ${make} ${model} listings`)

  if (!listings.length) {
    return { topDeals: [], totalScored: 0, referenceCars }
  }

  // 3. Score all listings using combined scorer (tradeoff + KNN), hoisted threshold
  const scoredListings = scoreListings(listings as Listing[], referenceCars as FlippedCar[], 3)

  // TEMP DEBUG: log confidence and normalized neighbor distances
  scoredListings.forEach(l => {
    console.log('DEBUG', l.id, 'confidence:', +l.confidence.toFixed(4), 'distanceNeighbors:', l.neighbors.map(n => ({
      carId: n.carId,
      distanceNorm: n.distance, // normalized, bounded
      year: n.year,
      mileage: n.mileage,
      price: n.price,
    })))
  })

  console.log(`[DEAL-FINDER] Scored ${scoredListings.length} listings`)

  // 4. Get top 10
  const topDeals = scoredListings
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  // 5. Upsert scores to database
  const dealScoreRows = scoredListings.map(scored => ({
    listing_id: scored.id,
    user_id: userId || null,
    score: scored.score,
    confidence: scored.confidence,
    knn_neighbors: scored.neighbors,
  }))

  const { error: upsertError } = await supaSvc
    .from('deal_scores')
    .upsert(dealScoreRows as any, { onConflict: 'listing_id,user_id' })

  if (upsertError) {
    console.error('[DEAL-FINDER] Error upserting scores:', upsertError)
  } else {
    console.log(`[DEAL-FINDER] Upserted ${dealScoreRows.length} scores`)
  }

  return {
    topDeals,
    totalScored: scoredListings.length,
    referenceCars,
  }
}

// CLI execution (for testing)
// Ensure compatibility in ESM environments where `require` is undefined
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  const referenceCarIds = process.argv.slice(2)
  if (referenceCarIds.length < 3) {
    console.error('Usage: tsx scripts/deal_finder.ts <car_id_1> <car_id_2> <car_id_3> ...')
    process.exit(1)
  }

  runDealFinder({ referenceCarIds })
    .then(result => {
      console.log('\n✅ Top 10 Deals:')
      result.topDeals.forEach((deal, i) => {
        console.log(`${i + 1}. Score: ${deal.score} | ${deal.year} ${deal.make} ${deal.model} | $${deal.price} | ${deal.mileage}mi | ${deal.url}`)
      })
    })
    .catch(err => {
      console.error('❌ Deal finder failed:', err)
      process.exit(1)
    })
}
