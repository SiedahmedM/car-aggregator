import type { FlippedCar, Listing, ScoredListing } from '../knn/types'
import { computeTradeoffParams, scoreListingTradeoff, type TradeoffParams } from '../tradeoff/scorer'
// Reuse the existing KNN as-is; we’ll use its "confidence" (similarity) not its own score.
import { scoreListing as scoreListingKNN } from '../knn/scorer'

const TRADEOFF_WEIGHT = 0.70
const KNN_WEIGHT = 0.30
const MIN_GATE = 0.08
const MAX_GATE = 0.20
// const MIN_COMBINED_CONFIDENCE = 0.08  // fallback gate if LOOCV not available

export function computeLOOCVThreshold(
  wins: FlippedCar[],
  tradeoffWeight: number,
  knnWeight: number,
  params?: TradeoffParams
): number {
  if (!wins || wins.length < 3) return 0.08 // fallback

  const p = params ?? computeTradeoffParams(wins)
  const confs: number[] = []

  for (let i = 0; i < wins.length; i++) {
    const w = wins[i]
    const others = wins.filter((_, j) => j !== i)

    // Treat the held-out win as a "listing"
    const listing: Listing = {
      id: `loocv-${w.id}`,
      make: w.make, model: w.model, year: w.year, mileage: w.mileage, price: w.purchasePrice,
      source: w.source, url: '', title: null, city: null, postedAt: new Date().toISOString()
    }

    const t = scoreListingTradeoff(listing, others, p)
    const k = scoreListingKNN(listing, others, Math.min(3, others.length))
    const combined = tradeoffWeight * t.tradeoffSimilarity + knnWeight * k.confidence
    confs.push(combined)
  }

  // Use a conservative lower percentile of self-confidence as the pass bar
  confs.sort((a,b) => a - b)
  const idx = Math.max(0, Math.floor(confs.length * 0.25)) // 25th percentile
  const thr = Math.max(0.05, confs[idx] * 0.9) // nudge slightly below to avoid over-rejecting
  console.log('[COMBINED] LOOCV threshold:', { values: confs.map(v => +v.toFixed(3)), threshold: +thr.toFixed(3) })
  return thr
}

export function autoTuneWeightsAndK(
  wins: FlippedCar[],
  params: TradeoffParams
): { tradeoffWeight: number; knnWeight: number; k: number } {
  const WEIGHTS: Array<[number, number]> = [
    [0.6, 0.4],
    [0.7, 0.3],
    [0.8, 0.2],
  ]
  const K_LIST = [1, 3, 5]

  if (!wins || wins.length < 5) {
    return { tradeoffWeight: TRADEOFF_WEIGHT, knnWeight: KNN_WEIGHT, k: 3 }
  }

  let best = { score: -Infinity, w: TRADEOFF_WEIGHT, k: 3, kw: KNN_WEIGHT }

  for (const [tw, kw] of WEIGHTS) {
    for (const kCand of K_LIST) {
      let sum = 0
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i]
        const others = wins.filter((_, j) => j !== i)
        const kUse = Math.min(kCand, others.length)
        if (kUse <= 0) continue

        const listing: Listing = {
          id: `loocv-${w.id}`,
          make: w.make, model: w.model, year: w.year, mileage: w.mileage, price: w.purchasePrice,
          source: w.source, url: '', title: null, city: null, postedAt: new Date().toISOString(),
        }

        const t = scoreListingTradeoff(listing, wins, params)
        const k = scoreListingKNN(listing, others, kUse)
        const combined = tw * t.tradeoffSimilarity + kw * k.confidence
        sum += combined
      }
      const mean = sum / wins.length
      if (mean > best.score) best = { score: mean, w: tw, k: Math.max(1, kCand), kw }
    }
  }

  console.log('[COMBINED] Auto-tune:', { weights: { tradeoff: best.w, knn: best.kw }, k: best.k, mean: +best.score.toFixed(3) })
  return { tradeoffWeight: best.w, knnWeight: best.kw, k: best.k }
}

export type CombinedContext = {
  params: TradeoffParams
  tradeoffWeight: number
  knnWeight: number
  k: number
  threshold: number
  scoreFloor: number
}

export function prepareCombinedContext(wins: FlippedCar[]): CombinedContext {
  const params = computeTradeoffParams(wins)
  const tuned = autoTuneWeightsAndK(wins, params)
  const tw = tuned.tradeoffWeight ?? TRADEOFF_WEIGHT
  const kw = tuned.knnWeight ?? KNN_WEIGHT
  const kEff = Math.min(tuned.k ?? 3, wins.length)

  const thrRaw = computeLOOCVThreshold(wins, tw, kw, params)
  const threshold = Math.min(Math.max(thrRaw, MIN_GATE), MAX_GATE)
  const scoreFloor = Math.max(0.12, Math.min(0.25, 0.5 * threshold + 0.05))

  console.log('[COMBINED] Gate:', {
    thresholdRaw: +thrRaw.toFixed(3),
    threshold: +threshold.toFixed(3),
    weights: { tradeoff: tw, knn: kw },
    k: kEff,
  })

  return { params, tradeoffWeight: tw, knnWeight: kw, k: kEff, threshold, scoreFloor }
}

export function scoreListing(
  listing: Listing,
  wins: FlippedCar[]
): ScoredListing {
  const ctx = prepareCombinedContext(wins)
  return scoreListingWithContext(listing, wins, ctx)
}

export function scoreListingWithContext(
  listing: Listing,
  wins: FlippedCar[],
  ctx: CombinedContext
): ScoredListing {
  const { params, tradeoffWeight: tw, knnWeight: kw, k: kEff, threshold, scoreFloor } = ctx

  // Sanity guards
  function sanityGuards(listing: Listing, baselinePrice: number) {
    const minPrice = Math.max(1500, 0.35 * baselinePrice)
    if (!listing.mileage || listing.mileage <= 0) return { ok: false, reason: 'no_mileage', redFlags: false }
    if (!listing.price || listing.price < minPrice) return { ok: false, reason: 'too_cheap', redFlags: false }
    const txt = (listing.title || '').toLowerCase()
    const redFlags = /(salvage|rebuilt|parts|mechanic|flood|frame)/i.test(txt)
    return { ok: true, reason: null as string | null, redFlags }
  }

  // Tradeoff + KNN
  const t = scoreListingTradeoff(listing, wins, params)
  const k = scoreListingKNN(listing, wins, kEff)
  const knnConfidence = k.confidence

  // Combined confidence and score
  const combinedConfidence = tw * t.tradeoffSimilarity + kw * knnConfidence
  let score = tw * t.tradeoffScore + kw * (knnConfidence * t.freshness)

  // Sanity + penalties
  const sg = sanityGuards(listing, params.baselinePrice)
  const flags: string[] = []
  if (!sg.ok) {
    score = 0
    console.warn('[SANITY] Filtered', { id: listing.id, reason: sg.reason })
  } else {
    if (sg.redFlags) { score *= 0.6; flags.push('red_flags') }
    if (t.residual < -3 * params.priceIQR) { score *= 0.3; flags.push('extreme_underpricing') }
  }

  // Dual gate (confidence + score)
  const pass = combinedConfidence >= threshold && score >= scoreFloor
  console.log('[GATE]', {
    id: listing.id,
    conf: +combinedConfidence.toFixed(3),
    thr: +threshold.toFixed(3),
    scorePreGate: +score.toFixed(3),
    floor: +scoreFloor.toFixed(3),
    pass,
  })
  const isWithinPattern = pass
  if (!isWithinPattern) score = 0

  console.log('[COMBINED]', {
    id: listing.id,
    tradeoff: { similarity: t.tradeoffSimilarity, freshness: t.freshness, score: t.tradeoffScore, residual: t.residual },
    knn: { confidence: knnConfidence },
    combined: { confidence: +combinedConfidence.toFixed(4), score: +score.toFixed(4) },
    guards: flags.length ? flags : undefined,
  })

  const explanation =
    `Pattern ${(combinedConfidence*100).toFixed(0)}% (gate ${(threshold*100).toFixed(0)}%). ` +
    `Adj→baseline: $${t.adjustedPrice} (Δ $${t.residual} vs $${params.baselinePrice}). ` +
    `KNN ${(knnConfidence*100).toFixed(0)}% (k=${kEff}). Freshness ${t.freshness.toFixed(2)}.` +
    (flags.length ? ` Penalties: ${flags.join(', ')}.` : '')

  return {
    ...listing,
    score: Math.round(score * 100) / 100,
    confidence: Math.round(combinedConfidence * 10000) / 10000,
    isWithinPattern,
    neighbors: k.neighbors,
    explanation,
  }
}

export function scoreListings(
  listings: Listing[],
  wins: FlippedCar[]
): ScoredListing[] {
  const ctx = prepareCombinedContext(wins)
  return listings.map(l => scoreListingWithContext(l, wins, ctx))
}

export function getTopDeals(
  listings: Listing[],
  referenceCars: FlippedCar[],
  topN = 10
): ScoredListing[] {
  const scored = scoreListings(listings, referenceCars)
  return scored
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}
