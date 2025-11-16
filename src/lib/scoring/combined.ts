import type { FlippedCar, Listing, ScoredListing } from '../knn/types'
import { computeTradeoffParams, scoreListingTradeoff, type TradeoffParams } from '../tradeoff/scorer'
// Reuse the existing KNN as-is; we’ll use its "confidence" (similarity) not its own score.
import { scoreListing as scoreListingKNN } from '../knn/scorer'

const TRADEOFF_WEIGHT = 0.70
const KNN_WEIGHT = 0.30
const MIN_GATE = 0.08
const MAX_GATE = 0.20
const MIN_COMBINED_CONFIDENCE = 0.08  // fallback gate if LOOCV not available

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

    const t = scoreListingTradeoff(listing, wins, p)
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

export function scoreListing(
  listing: Listing,
  referenceCars: FlippedCar[],
  k = 3
): ScoredListing {
  // Compute tradeoff params + LOOCV threshold; callers that batch should hoist this.
  const params = computeTradeoffParams(referenceCars)
  const thrRaw = computeLOOCVThreshold(referenceCars, TRADEOFF_WEIGHT, KNN_WEIGHT)
  const threshold = Math.min(Math.max(thrRaw, MIN_GATE), MAX_GATE)

  // Tradeoff scorer
  const t = scoreListingTradeoff(listing, referenceCars, params)

  // KNN scorer (confidence only; neighbors for explanation)
  const knn = scoreListingKNN(listing, referenceCars, k)
  const knnConfidence = knn.confidence

  // Combined
  const combinedConfidence = TRADEOFF_WEIGHT * t.tradeoffSimilarity + KNN_WEIGHT * knnConfidence
  // Apply freshness to both paths in the final score
  let score = TRADEOFF_WEIGHT * t.tradeoffScore + KNN_WEIGHT * (knnConfidence * t.freshness)

  const isWithinPattern = combinedConfidence >= threshold
  if (!isWithinPattern) score = 0

  // Debug log (one line per listing)
  console.log('[COMBINED]', {
    id: listing.id,
    tradeoff: { similarity: t.tradeoffSimilarity, freshness: t.freshness, score: t.tradeoffScore, residual: t.residual },
    knn: { confidence: knnConfidence },
    combined: { confidence: +combinedConfidence.toFixed(4), score: +score.toFixed(4) },
  })

  const explanation =
    `Tradeoff ${(t.tradeoffSimilarity*100).toFixed(0)}% (adj=$${t.adjustedPrice}, Δ=$${t.residual}), ` +
    `KNN ${(knnConfidence*100).toFixed(0)}% → combined ${(combinedConfidence*100).toFixed(0)}%`

  return {
    ...listing,
    score: Math.round(score * 100) / 100,
    confidence: Math.round(combinedConfidence * 10000) / 10000,
    isWithinPattern,
    neighbors: knn.neighbors, // keep KNN neighbors for explainability
    explanation,
  }
}

export function scoreListings(
  listings: Listing[],
  referenceCars: FlippedCar[],
  k = 3
): ScoredListing[] {
  const params = computeTradeoffParams(referenceCars) // hoist for efficiency
  // Auto-tune when enough wins, else keep defaults
  const tuned = autoTuneWeightsAndK(referenceCars, params)
  const tw = tuned.tradeoffWeight ?? TRADEOFF_WEIGHT
  const kw = tuned.knnWeight ?? KNN_WEIGHT
  const kEff = Math.min(tuned.k ?? k, referenceCars.length)

  const thrRaw = computeLOOCVThreshold(referenceCars, tw, kw, params)
  const threshold = Math.min(Math.max(thrRaw, MIN_GATE), MAX_GATE)
  console.log('[COMBINED] Gate:', {
    thresholdRaw: +thrRaw.toFixed(3),
    threshold: +threshold.toFixed(3),
    weights: { tradeoff: tw, knn: kw },
    k: kEff,
  })
  const MIN_SCORE_FLOOR = 0.15

  function sanityGuards(listing: Listing, baselinePrice: number) {
    const minPrice = Math.max(1500, 0.35 * baselinePrice)
    if (!listing.mileage || listing.mileage <= 0) return { ok: false, reason: 'no_mileage', redFlags: false }
    if (!listing.price || listing.price < minPrice) return { ok: false, reason: 'too_cheap', redFlags: false }
    const txt = (listing.title || '').toLowerCase()
    const redFlags = /(salvage|rebuilt|parts|mechanic|flood|frame)/i.test(txt)
    return { ok: true, reason: null as any, redFlags }
  }
  return listings.map(listing => {
    // Use combined scorer but reuse params
    const t = scoreListingTradeoff(listing, referenceCars, params)
    const knn = scoreListingKNN(listing, referenceCars, kEff)
    const knnConfidence = knn.confidence

    const combinedConfidence = tw * t.tradeoffSimilarity + kw * knnConfidence
    // Apply freshness to both paths in the final score:
    let score = tw * t.tradeoffScore + kw * (knnConfidence * t.freshness)

    // Sanity checks and light-touch penalties
    const sg = sanityGuards(listing, params.baselinePrice)
    let flags: string[] = []
    if (!sg.ok) {
      score = 0
      console.warn('[SANITY] Filtered', { id: listing.id, reason: sg.reason })
    } else {
      if (sg.redFlags) {
        score *= 0.6 // 40% penalty for red-flag words
        flags.push('red_flags')
      }
      if (t.residual < -3 * params.priceIQR) {
        score *= 0.3 // extreme underpricing clamp
        flags.push('extreme_underpricing')
      }
    }

    // Dual gate: confidence and score
    const isWithinPattern = combinedConfidence >= threshold && score >= MIN_SCORE_FLOOR
    if (!isWithinPattern) score = 0

    console.log('[COMBINED]', {
      id: listing.id,
      tradeoff: { similarity: t.tradeoffSimilarity, freshness: t.freshness, score: t.tradeoffScore, residual: t.residual },
      knn: { confidence: knnConfidence },
      combined: { confidence: +combinedConfidence.toFixed(4), score: +score.toFixed(4) },
      guards: flags.length ? flags : undefined,
    })

    let explanation =
      `Pattern ${(combinedConfidence*100).toFixed(0)}% (gate ${(threshold*100).toFixed(0)}%). ` +
      `Adj→baseline: $${t.adjustedPrice} (Δ $${t.residual} vs $${params.baselinePrice}). ` +
      `KNN ${(knnConfidence*100).toFixed(0)}% (k=${kEff}). Freshness ${t.freshness.toFixed(2)}.`
    if (!sg.ok) explanation = `[FILTER:${sg.reason}] ` + explanation
    else if (flags.length) explanation += ` Penalties: ${flags.join(', ')}.`

    return {
      ...listing,
      score: Math.round(score * 100) / 100,
      confidence: Math.round(combinedConfidence * 10000) / 10000,
      isWithinPattern,
      neighbors: knn.neighbors,
      explanation,
    }
  })
}

export function getTopDeals(
  listings: Listing[],
  referenceCars: FlippedCar[],
  topN = 10,
  k = 3
): ScoredListing[] {
  const scored = scoreListings(listings, referenceCars, k)
  return scored.sort((a, b) => b.score - a.score).slice(0, topN)
}
