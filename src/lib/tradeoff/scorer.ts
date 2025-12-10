import type { FlippedCar, Listing } from '../knn/types'

export interface TradeoffParams {
  baselineYear: number
  baselineMiles: number
  baselinePrice: number
  slopePerYear: number       // $ per year (typically negative for older => cheaper)
  slopePerMile: number       // $ per mile (typically negative; e.g., -0.05 means -$50 per 1k miles)
  priceIQR: number           // scale for residuals
}

const FALLBACK_SLOPE_PER_YEAR = -1500     // sensible generic default
const FALLBACK_SLOPE_PER_MILE = -0.05     // -$0.05 per mile (~$50 per 1k)
const MIN_PRICE_SCALE = 500               // prevent divide-by-near-zero on tiny IQR
const HALF_LIFE_HOURS_DEFAULT = 72        // 3 days
const MAX_AGE_HOURS_IF_MISSING = 24 * 5   // treat missing postedAt as 5 days old

function toNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : null
}

function median(arr: number[]): number {
  if (!arr.length) return NaN
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 === 0 ? (a[m - 1] + a[m]) / 2 : a[m]
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return NaN
  const a = [...arr].sort((x, y) => x - y)
  const idx = (a.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return a[lo]
  return a[lo] + (a[hi] - a[lo]) * (idx - lo)
}

function iqr(arr: number[]): number {
  const q1 = percentile(arr, 0.25)
  const q3 = percentile(arr, 0.75)
  return q3 - q1
}

function mad(arr: number[]): number {
  const m = median(arr)
  const devs = arr.map(v => Math.abs(v - m))
  return median(devs)
}

export function computeTradeoffParams(wins: FlippedCar[]): TradeoffParams {
  if (!wins || wins.length < 3) {
    throw new Error(`[TRADEOFF] Need ≥3 reference wins; got ${wins?.length ?? 0}`)
  }

  const years = wins.map(w => w.year)
  const miles = wins.map(w => w.mileage)
  const prices = wins.map(w => w.purchasePrice)

  if (years.some(v => !Number.isFinite(v)) || miles.some(v => !Number.isFinite(v)) || prices.some(v => !Number.isFinite(v))) {
    throw new Error('[TRADEOFF] Wins contain non-numeric year/mileage/purchasePrice')
  }

  const baselineYear  = median(years)
  const baselineMiles = median(miles)
  const baselinePrice = median(prices)

  // Pairwise slopes (Theil–Sen style)
  const slopeY: number[] = []
  const slopeM: number[] = []
  for (let i = 0; i < wins.length; i++) {
    for (let j = i + 1; j < wins.length; j++) {
      const p1 = wins[i]
      const p2 = wins[j]
      // Always order by year before taking differences
      const [a, b] = p1.year <= p2.year ? [p1, p2] : [p2, p1]
      const dy = b.year - a.year
      const dp = b.purchasePrice - a.purchasePrice
      if (Number.isFinite(dy) && dy !== 0 && Number.isFinite(dp)) slopeY.push(dp / dy)

      // Mileage slope (keep sign consistent with increasing mileage)
      const dm = p2.mileage - p1.mileage
      if (Number.isFinite(dm) && dm !== 0 && Number.isFinite(dp)) slopeM.push(dp / dm)
    }
  }

  // Empirical median slopes
  const slopePerYearEmp = median(slopeY)       // $ per year (often negative)
  const slopePerMileEmp = median(slopeM)       // $ per mile (often negative)

  // Robust price scale
  let priceIQR = iqr(prices)
  if (!Number.isFinite(priceIQR) || priceIQR <= 0) {
    const robust = Math.max(
      MIN_PRICE_SCALE,
      mad(prices) * 2.5 * 1.4826,   // stronger fallback
      (baselinePrice || 10000) * 0.08
    )
    priceIQR = robust
    console.warn('[TRADEOFF] priceIQR=0; using robust fallback scale:', priceIQR)
  }

  // Price-tier prior & shrinkage
  const tier = Math.min(3, Math.max(1, baselinePrice / 20000)) // 10–60k → 0.5–3 scale, clipped to [1,3]
  const priorPerYear = FALLBACK_SLOPE_PER_YEAR * tier          // more negative for expensive segments
  const priorPerMile = FALLBACK_SLOPE_PER_MILE * tier

  const nPairsY = slopeY.length
  const nPairsM = slopeM.length

  // Shrink toward prior: slope_hat = (n / (n+λ)) * emp + (λ / (n+λ)) * prior
  const LAMBDA_Y = 3
  const LAMBDA_M = 3

  let slopePerYear = Number.isFinite(slopePerYearEmp)
    ? (nPairsY / (nPairsY + LAMBDA_Y)) * slopePerYearEmp + (LAMBDA_Y / (nPairsY + LAMBDA_Y)) * priorPerYear
    : priorPerYear

  let slopePerMile = Number.isFinite(slopePerMileEmp)
    ? (nPairsM / (nPairsM + LAMBDA_M)) * slopePerMileEmp + (LAMBDA_M / (nPairsM + LAMBDA_M)) * priorPerMile
    : priorPerMile

  // Safety clamps (avoid extreme slopes with tiny/identical wins)
  const YEAR_CAP = 10000 * tier
  const MILE_CAP = 0.50 * tier       // $0.50 per mile == $500 per 1k
  slopePerYear = Math.max(-YEAR_CAP, Math.min(YEAR_CAP, slopePerYear))
  slopePerMile = Math.max(-MILE_CAP, Math.min(MILE_CAP, slopePerMile))

  // === Price scale widening for broad ranges ===
  const ALLOWED_DELTA_YEARS = 5
  const ALLOWED_DELTA_MILES = 50_000
  const PRICE_SCALE_MIN_FRACTION = 0.08      // at least 8% of baseline price
  const PRICE_SCALE_ALLOWANCE_FRACTION = 0.30 // use 30% of slope-implied allowance

  const allowance =
    Math.abs(slopePerYear) * ALLOWED_DELTA_YEARS +
    Math.abs(slopePerMile) * ALLOWED_DELTA_MILES

  const priceScaleMin = Math.max(MIN_PRICE_SCALE, baselinePrice * PRICE_SCALE_MIN_FRACTION)
  const widened = Math.max(priceIQR, priceScaleMin, allowance * PRICE_SCALE_ALLOWANCE_FRACTION)

  // Keep the same field name so callers don't change
  priceIQR = widened

  console.log('[TRADEOFF] Params:', {
    baselineYear, baselineMiles, baselinePrice,
    slopePerYear: Math.round(slopePerYear),
    slopePerMile: Math.round(slopePerMile * 1000) / 1000,
    priceIQR: Math.round(priceIQR),
    pairsYear: nPairsY, pairsMiles: nPairsM, tier
  })

  return { baselineYear, baselineMiles, baselinePrice, slopePerYear, slopePerMile, priceIQR }
}

export function scoreListingTradeoff(
  listing: Listing,
  wins: FlippedCar[],
  params: TradeoffParams,
  nowMs = Date.now(),
  halfLifeHours = HALF_LIFE_HOURS_DEFAULT
): {
  tradeoffSimilarity: number
  freshness: number
  tradeoffScore: number
  adjustedPrice: number
  residual: number
  ok: boolean
  reason?: string
} {
  // Validate listing fields
  const y = toNum(listing.year)
  const m = toNum(listing.mileage)
  const p = toNum(listing.price)

  if (y === null || m === null || p === null) {
    const reason = '[TRADEOFF] Listing missing numeric year/mileage/price'
    console.warn(reason, { id: listing.id, year: listing.year, mileage: listing.mileage, price: listing.price })
    return { tradeoffSimilarity: 0, freshness: 0, tradeoffScore: 0, adjustedPrice: 0, residual: 0, ok: false, reason }
  }

  const { baselineYear, baselineMiles, baselinePrice, slopePerYear, slopePerMile, priceIQR } = params

  // Adjust listing price to baseline year & miles
  const adjustedPrice = p + slopePerYear * (baselineYear - y) + slopePerMile * (baselineMiles - m)

  // Residual vs baseline buy price
  const residual = adjustedPrice - baselinePrice
  const similarity = 1 / (1 + Math.abs(residual) / priceIQR) // smooth, robust (symmetric)
  // Directional bonus: no penalty if under baseline; penalize if over
  const dealBonus = 1 / (1 + Math.max(0, residual) / priceIQR)

  // Recency (exponential decay)
  const postedMs = listing.postedAt ? new Date(listing.postedAt).getTime() : nowMs - MAX_AGE_HOURS_IF_MISSING * 3600 * 1000
  const ageHours = Math.max(0, (nowMs - postedMs) / (1000 * 60 * 60))
  const lambda = Math.log(2) / halfLifeHours
  const freshness = Math.exp(-lambda * ageHours)

  const tradeoffScore = similarity * dealBonus * freshness

  return {
    tradeoffSimilarity: Math.round(similarity * 10000) / 10000,
    freshness: Math.round(freshness * 10000) / 10000,
    tradeoffScore: Math.round(tradeoffScore * 10000) / 10000,
    adjustedPrice: Math.round(adjustedPrice),
    residual: Math.round(residual),
    ok: true,
  }
}
