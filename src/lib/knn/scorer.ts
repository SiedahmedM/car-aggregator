import { FlippedCar, Listing, ScoredListing, NormalizedFeatures } from './types'
import { calculateFeatureStats, normalizeVehicle, normalizeFlippedCar } from './normalization'

interface ScoringWeights {
  year: number
  mileage: number
  price: number
}

export const WEIGHTS: ScoringWeights = {
  year: 1.0,
  mileage: 1.2,
  price: 2.0,
}
const DEFAULT_WEIGHTS = WEIGHTS

// Deterministic normalization bound (max possible weighted Euclidean distance)
export const MAX_NORM_DIST = Math.hypot(WEIGHTS.year, WEIGHTS.mileage, WEIGHTS.price)

// minimum similarity to treat as "within pattern"
const MIN_CONFIDENCE = 0.05

function clamp01(v: number | null): number | null {
  if (v === null) return null
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function euclideanDistanceClamped(
  a: NormalizedFeatures,
  b: NormalizedFeatures,
  weights: ScoringWeights
): { dist: number; dimsUsed: number } {
  const ay = clamp01(a.yearNorm)
  const by = clamp01(b.yearNorm)
  const am = clamp01(a.mileageNorm)
  const bm = clamp01(b.mileageNorm)
  const ap = clamp01(a.priceNorm)
  const bp = clamp01(b.priceNorm)

  let sumSq = 0
  let dimsUsed = 0

  if (ay !== null && by !== null) {
    const d = (ay - by) * weights.year
    sumSq += d * d
    dimsUsed++
  }
  if (am !== null && bm !== null) {
    const d = (am - bm) * weights.mileage
    sumSq += d * d
    dimsUsed++
  }
  if (ap !== null && bp !== null) {
    const d = (ap - bp) * weights.price
    sumSq += d * d
    dimsUsed++
  }

  if (dimsUsed === 0) return { dist: Number.POSITIVE_INFINITY, dimsUsed: 0 }
  const dist = Math.sqrt(sumSq)
  return { dist, dimsUsed }
}

// Note: standalone euclideanDistance helper removed (unused)

export function scoreListing(
  listing: Listing,
  referenceCars: FlippedCar[],
  k = 3,
  weights = DEFAULT_WEIGHTS
): ScoredListing {
  if (referenceCars.length === 0) {
    throw new Error('Need at least 1 reference car to score listings')
  }

  // 1. Stats from reference (your past buys) in year/mileage/purchasePrice space
  const stats = calculateFeatureStats(referenceCars)

  // 2. Normalize listing features (year, mileage, current price)
  const listingNorm = normalizeVehicle(
    {
      year: listing.year,
      make: listing.make,
      model: listing.model,
      mileage: listing.mileage,
      price: listing.price,
    },
    stats
  )

  // 3. Distances to each reference car (using purchasePrice for refs), skipping missing dimensions
  const distances = referenceCars.map(ref => {
    const refNorm = normalizeFlippedCar(ref, stats)
    const { dist, dimsUsed } = euclideanDistanceClamped(listingNorm, refNorm, weights)
    return { car: ref, distance: dist, dimsUsed }
  })

  // 4. K nearest neighbors
  const kNearest = Math.min(k, referenceCars.length)
  const neighbors = distances
    .sort((a, b) => a.distance - b.distance)
    .slice(0, kNearest)

  const avgDistance = neighbors.reduce((sum, n) => sum + n.distance, 0) / neighbors.length
  // dimsUsedAvg removed (unused)

  // 5. Confidence from bounded normalized distance
  // Prefer deterministic bound using top-level WEIGHTS
  const maxNorm = MAX_NORM_DIST
  const confidenceRaw = Math.max(0, 1 - (avgDistance / maxNorm))

  // 6. (Optional) Confidence floor for very close matches
  const best = neighbors[0]?.distance ?? Infinity
  const confidence = best <= 0.2 ? Math.max(confidenceRaw, 0.55) : confidenceRaw

  // Log helpful KNN diagnostics
  try {
    console.log('[KNN]', listing.id, {
      avgDist: +avgDistance.toFixed(4),
      max: +maxNorm.toFixed(4),
      confidence: +confidence.toFixed(4),
      neighbors: neighbors.map(n => ({ carId: n.car.id, distanceNorm: +n.distance.toFixed(4) })),
    })
  } catch {}

  // 7. Freshness boost
  let freshnessMultiplier = 1.0
  if (listing.postedAt) {
    const hoursOld =
      (Date.now() - new Date(listing.postedAt).getTime()) / (1000 * 60 * 60)
    if (hoursOld < 2) {
      freshnessMultiplier = 1.1
    }
  }

  // 8. Final score: similarity × freshness
  let score = confidence * freshnessMultiplier

  const isWithinPattern = confidence >= MIN_CONFIDENCE
  if (!isWithinPattern) {
    // Too dissimilar; push to bottom
    score = 0
  }

  // 9. Build explanation using year/mileage/price of nearest buys
  const neighborDescriptions = neighbors
    .map(
      n =>
        `${n.car.year} (${n.car.mileage.toLocaleString()} mi, $${n.car.purchasePrice.toLocaleString()} buy)`
    )
    .join(', ')

  const explanation = `Similarity ${(confidence * 100).toFixed(
    0
  )}% to your past buys: ${neighborDescriptions}`

  return {
    ...listing,
    score: Math.round(score * 100) / 100,
    confidence: Math.round(confidence * 10000) / 10000,
    isWithinPattern,
    neighbors: neighbors.map(n => ({
      carId: n.car.id,
      distanceNorm: Math.round(n.distance * 10000) / 10000, // normalized, weighted Euclidean
      year: n.car.year,
      mileage: n.car.mileage,
      price: n.car.purchasePrice,
    })),
    explanation,
  }
}

export function scoreListings(
  listings: Listing[],
  referenceCars: FlippedCar[],
  k = 3
): ScoredListing[] {
  return listings.map(listing => scoreListing(listing, referenceCars, k))
}

export function getTopDeals(
  listings: Listing[],
  referenceCars: FlippedCar[],
  topN = 10,
  k = 3
): ScoredListing[] {
  const scored = scoreListings(listings, referenceCars, k)
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}
