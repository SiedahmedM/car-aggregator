export interface Vehicle {
  year: number
  make: string
  model: string
  mileage: number
  price: number
}

export interface FlippedCar extends Vehicle {
  id: string
  purchasePrice: number
  salePrice: number
  profit: number
  profitPercentage: number
  daysToFlip: number
  source: string
  purchaseDate: string
  saleDate: string
  notes?: string
}

export interface Listing extends Vehicle {
  id: string
  source: string
  url: string
  title: string | null
  city: string | null
  postedAt: string | null
}

export interface ScoredListing extends Listing {
  score: number            // final ranking score (similarity × freshness)
  confidence: number       // how similar this is to your pattern, 0–1
  isWithinPattern: boolean // passes your similarity threshold
  neighbors: {
    carId: string
    distanceNorm: number
    year: number
    mileage: number
    price: number          // purchasePrice of the neighbor car
  }[]
  explanation: string
}

export interface NormalizedFeatures {
  yearNorm: number | null
  mileageNorm: number | null
  priceNorm: number | null
}

export interface FeatureStats {
  year: { min: number; max: number; mean: number; stdDev: number }
  mileage: { min: number; max: number; mean: number; stdDev: number }
  price: { min: number; max: number; mean: number; stdDev: number }
}
