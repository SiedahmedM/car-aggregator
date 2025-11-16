import { FlippedCar, FeatureStats, NormalizedFeatures, Vehicle } from './types'

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : null
}

function normalizeValue(v: unknown, stat: { min: number; max: number }): number | null {
  const n = toFiniteNumber(v)
  if (n === null) return null
  const range = stat.max - stat.min
  if (range === 0) return 0.5
  // No clipping: allow values outside [0,1]; the distance formula will handle it
  return (n - stat.min) / range
}

export function calculateFeatureStats(cars: FlippedCar[]): FeatureStats {
  const years = cars.map(c => c.year)
  const mileages = cars.map(c => c.mileage)
  const prices = cars.map(c => c.purchasePrice)

  const stats = (arr: number[]) => {
    const min = Math.min(...arr)
    const max = Math.max(...arr)
    const mean = arr.reduce((sum, v) => sum + v, 0) / arr.length
    const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length
    const stdDev = Math.sqrt(variance)
    return { min, max, mean, stdDev }
  }

  return {
    year: stats(years),
    mileage: stats(mileages),
    price: stats(prices),
  }
}

export function normalizeVehicle(vehicle: Vehicle, stats: FeatureStats): NormalizedFeatures {
  return {
    yearNorm: normalizeValue(vehicle.year, stats.year),
    mileageNorm: normalizeValue(vehicle.mileage, stats.mileage),
    priceNorm: normalizeValue(vehicle.price, stats.price),
  }
}

export function normalizeFlippedCar(car: FlippedCar, stats: FeatureStats): NormalizedFeatures {
  return normalizeVehicle(
    { year: car.year, make: car.make, model: car.model, mileage: car.mileage, price: car.purchasePrice },
    stats
  )
}
