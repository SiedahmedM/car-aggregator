import { createClient } from '@supabase/supabase-js'
import { scoreListings } from '../src/lib/scoring/combined'
import { computeTradeoffParams } from '../src/lib/tradeoff/scorer'
import type { FlippedCar, Listing } from '../src/lib/knn/types'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!
const supaSvc = createClient(SUPA_URL, SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

interface WinPoint { year: number; mileage: number; purchasePrice: number }
interface DealFinderParams {
  // Either pass canonical flipped car IDs OR raw win points + make/model
  referenceCarIds?: string[]
  wins?: WinPoint[]
  make?: string
  model?: string
  sources?: string[]
  userId?: string
  jobId?: string // optional: tag scores to a queue job
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
  const { referenceCarIds, wins, make: makeIn, model: modelIn, sources = ['offerup'], userId } = params
  const jobId = params.jobId || process.env.DEAL_FINDER_JOB_ID || undefined

  console.log('[DEAL-FINDER] Starting...', { referenceCarIds, sources })

  // 1. Build reference cars either from DB (IDs) or from raw wins
  let referenceCars: FlippedCar[]
  let make: string
  let model: string

  if (wins && wins.length) {
    if (!makeIn || !modelIn) throw new Error('wins provided but make/model missing')
    make = makeIn.toLowerCase()
    model = modelIn.toLowerCase()
    if (wins.length < 3) throw new Error(`Need at least 3 wins, got ${wins.length}`)
    referenceCars = wins.map((w, i) => ({
      id: `win-${i + 1}`,
      year: w.year,
      make,
      model,
      mileage: w.mileage,
      price: w.purchasePrice,
      purchasePrice: w.purchasePrice,
      salePrice: w.purchasePrice,
      profit: 0,
      profitPercentage: 0,
      daysToFlip: 0,
      source: 'manual',
      purchaseDate: new Date().toISOString(),
      saleDate: new Date().toISOString(),
      notes: undefined,
    }))
  } else if (referenceCarIds && referenceCarIds.length) {
    const { data: referenceRows, error: refError } = await supaSvc
      .from('flipped_cars')
      .select('*')
      .in('id', referenceCarIds)
    if (refError || !referenceRows?.length) {
      throw new Error(`Failed to fetch reference cars: ${refError?.message}`)
    }
    referenceCars = referenceRows.map(mapFlippedCar)
    if (referenceCars.length < 3) {
      throw new Error(`Need at least 3 reference cars, got ${referenceCars.length}`)
    }
    make = referenceCars[0].make
    model = referenceCars[0].model
    const allSame = referenceCars.every(c => c.make === make && c.model === model)
    if (!allSame) throw new Error('All reference cars must be the same make and model')
  } else {
    throw new Error('Provide either referenceCarIds or wins + make/model')
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

  // 2. Fetch recent listings in an explicit time window (default 24 hours)
  const WINDOW_HOURS = Number(process.env.DEAL_WINDOW_HOURS ?? 24)
  const sinceIso = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()

  // Check if dealer filtering is enabled (default to true for deal finder)
  const FILTER_DEALERS = (process.env.OU_FILTER_DEALERS ?? 'true').toLowerCase() === 'true'

  console.log('[DEAL-FINDER] Querying listings with filters:')
  console.log('  - sources:', sources)
  console.log('  - make:', make)
  console.log('  - model:', model)
  console.log('  - posted_at >=', sinceIso, `(${WINDOW_HOURS} hours ago)`)
  console.log('  - filter dealers:', FILTER_DEALERS)

  let query = supaSvc
    .from('listings')
    .select('*')
    .in('source', sources)
    .eq('make', make)
    .eq('model', model)
    .gte('posted_at', sinceIso)

  // Filter out dealer listings if enabled
  if (FILTER_DEALERS) {
    query = query.or('is_dealer.is.null,is_dealer.eq.false')
  }

  const { data: listingRows, error: listError } = await query.order('posted_at', { ascending: false })

  if (listError) {
    console.error('[DEAL-FINDER] Query error:', listError)
    throw new Error(`Failed to fetch listings: ${listError.message}`)
  }

  console.log('[DEAL-FINDER] Raw query returned:', listingRows?.length || 0, 'rows')

  const listings = (listingRows ?? []).map(mapListing)
  console.log(`[DEAL-FINDER] Found ${listings.length} recent ${make} ${model} listings`)

  // Log sample of listings if any found
  if (listings.length > 0) {
    console.log('[DEAL-FINDER] Sample listings:')
    listings.slice(0, 3).forEach(l => {
      console.log('  -', l.year, l.make, l.model, '|', l.mileage, 'mi | $' + l.price, '| source:', l.source)
    })
  } else {
    console.log('[DEAL-FINDER] ⚠️  No listings found! Checking why...')

    // Debug: Check total listings without time filter (but with dealer filter if enabled)
    let debugQuery1 = supaSvc
      .from('listings')
      .select('*', { count: 'exact', head: true })
      .in('source', sources)
      .eq('make', make)
      .eq('model', model)

    if (FILTER_DEALERS) {
      debugQuery1 = debugQuery1.or('is_dealer.is.null,is_dealer.eq.false')
    }

    const { count: totalCount } = await debugQuery1

    console.log('[DEAL-FINDER] Total', make, model, 'listings (no time filter):', totalCount)

    if (totalCount && totalCount > 0) {
      // Check how many have posted_at in range
      let debugQuery2 = supaSvc
        .from('listings')
        .select('*', { count: 'exact', head: true })
        .in('source', sources)
        .eq('make', make)
        .eq('model', model)
        .gte('posted_at', sinceIso)

      if (FILTER_DEALERS) {
        debugQuery2 = debugQuery2.or('is_dealer.is.null,is_dealer.eq.false')
      }

      const { count: recentCount } = await debugQuery2

      console.log('[DEAL-FINDER] With posted_at >=', sinceIso, ':', recentCount)

      // Sample the most recent by first_seen_at to see dates
      let debugQuery3 = supaSvc
        .from('listings')
        .select('year, mileage, price, posted_at, first_seen_at, source, is_dealer')
        .in('source', sources)
        .eq('make', make)
        .eq('model', model)

      if (FILTER_DEALERS) {
        debugQuery3 = debugQuery3.or('is_dealer.is.null,is_dealer.eq.false')
      }

      const { data: sample } = await debugQuery3
        .order('first_seen_at', { ascending: false })
        .limit(3)

      console.log('[DEAL-FINDER] Sample listings (by first_seen_at):')
      sample?.forEach(s => {
        console.log('  -', s.year, make, model, '| posted_at:', s.posted_at, '| first_seen_at:', s.first_seen_at)
      })
    }
  }

  if (!listings.length) {
    console.log('[DEAL-FINDER] 🔄 No listings found in DB - triggering scraper...')

    // Auto-trigger OfferUp scraper to get fresh data
    const { spawn } = await import('node:child_process')
    const scraperEnv = { ...process.env }

    // Set scraper filters based on our search criteria
    scraperEnv.OU_FILTER_MAKES = make
    scraperEnv.OU_FILTER_MODELS = model
    scraperEnv.OU_FILTER_POSTED_WITHIN_HOURS = '48' // Last 24 hours

    console.log('[DEAL-FINDER] Launching OfferUp scraper with:', {
      make,
      model,
      sources,
    })

    // Run scraper synchronously and wait for it to complete
    await new Promise<void>((resolve, reject) => {
      const tsxPath = './node_modules/.bin/tsx'
      const child = spawn(tsxPath, ['scripts/offerup.ts'], {
        env: scraperEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let output = ''
      child.stdout.on('data', (d) => { output += String(d) })
      child.stderr.on('data', (d) => { output += String(d) })

      child.on('close', (code) => {
        if (code === 0) {
          console.log('[DEAL-FINDER] ✅ Scraper completed successfully')
          // Check if we got the success JSON
          const match = output.match(/\{\s*"ok"\s*:\s*true[\s\S]*?\}/)
          if (match) {
            try {
              const result = JSON.parse(match[0])
              console.log('[DEAL-FINDER] Scraper result:', result)
            } catch {}
          }
          resolve()
        } else {
          console.error('[DEAL-FINDER] ❌ Scraper failed with code:', code)
          console.error('[DEAL-FINDER] Output:', output.slice(0, 1000))
          reject(new Error(`Scraper failed with code ${code}`))
        }
      })
    })

    // Retry the query after scraper completes
    console.log('[DEAL-FINDER] 🔄 Retrying query after scrape...')
    let retryQuery = supaSvc
      .from('listings')
      .select('*')
      .in('source', sources)
      .eq('make', make)
      .eq('model', model)
      .gte('posted_at', sinceIso)

    // Apply same dealer filter
    if (FILTER_DEALERS) {
      retryQuery = retryQuery.or('is_dealer.is.null,is_dealer.eq.false')
    }

    const { data: retryRows, error: retryError } = await retryQuery.order('posted_at', { ascending: false })

    if (retryError) {
      throw new Error(`Retry query failed: ${retryError.message}`)
    }

    const retryListings = (retryRows ?? []).map(mapListing)
    console.log('[DEAL-FINDER] After scrape:', retryListings.length, 'listings found')

    if (!retryListings.length) {
      console.log('[DEAL-FINDER] ⚠️  Still no listings after scrape - giving up')
      return { topDeals: [], totalScored: 0, referenceCars }
    }

    // Update listings variable to continue with scoring
    listings.push(...retryListings)
  }

  // 3. Score all listings using combined scorer (tradeoff + KNN), hoisted threshold
  const scoredListings = scoreListings(listings as Listing[], referenceCars as FlippedCar[])

  // TEMP DEBUG: log confidence and normalized neighbor distances
  scoredListings.forEach(l => {
    console.log('DEBUG', l.id, 'confidence:', +l.confidence.toFixed(4), 'distanceNeighbors:', l.neighbors.map(n => ({
      carId: n.carId,
      distanceNorm: n.distanceNorm, // normalized, bounded
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

  // 5. Upsert scores to database (optionally tag with job_id)
  const dealScoreRows = scoredListings.map(scored => ({
    listing_id: scored.id,
    user_id: userId || null,
    score: scored.score,
    confidence: scored.confidence,
    knn_neighbors: scored.neighbors,
    ...(jobId ? { job_id: jobId } : {}),
  }))

  // Optional cleanup: clear any prior rows for this job to ensure a clean slate
  if (jobId) {
    await supaSvc.from('deal_scores').delete().eq('job_id', jobId)
  }

  // Use a conflict target that matches schema
  const conflictTarget = jobId ? 'job_id,listing_id' : 'listing_id,user_id'
  const { error: upsertError } = await supaSvc
    .from('deal_scores')
    .upsert(dealScoreRows as any, { onConflict: conflictTarget })

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
  console.log('[CLI] ========================================')
  console.log('[CLI] DEAL FINDER - MANUAL EXECUTION')
  console.log('[CLI] ========================================')
  console.log('[CLI] Script started at:', new Date().toISOString())
  console.log('[CLI] Process args:', process.argv)

  const referenceCarIds = process.argv.slice(2)
  console.log('[CLI] Reference car IDs:', referenceCarIds)

  if (referenceCarIds.length < 3) {
    console.error('[CLI] ❌ Not enough car IDs provided')
    console.error('Usage: tsx scripts/deal_finder.ts <car_id_1> <car_id_2> <car_id_3> ...')
    process.exit(1)
  }

  console.log('[CLI] Calling runDealFinder with', referenceCarIds.length, 'reference cars')

  runDealFinder({ referenceCarIds })
    .then(result => {
      console.log('[CLI] ========================================')
      console.log('[CLI] ✅ DEAL FINDER COMPLETED')
      console.log('[CLI] ========================================')
      console.log('[CLI] Total scored:', result.totalScored)
      console.log('[CLI] Top deals:', result.topDeals.length)
      console.log('\n✅ Top 10 Deals:')
      result.topDeals.forEach((deal, i) => {
        console.log(`${i + 1}. Score: ${deal.score.toFixed(4)} | ${deal.year} ${deal.make} ${deal.model} | $${deal.price} | ${deal.mileage}mi | ${deal.url}`)
      })
      console.log('\n[CLI] Finished at:', new Date().toISOString())
    })
    .catch(err => {
      console.error('[CLI] ========================================')
      console.error('[CLI] ❌ DEAL FINDER FAILED')
      console.error('[CLI] ========================================')
      console.error('[CLI] Error:', err)
      console.error('[CLI] Stack:', err.stack)
      process.exit(1)
    })
}
