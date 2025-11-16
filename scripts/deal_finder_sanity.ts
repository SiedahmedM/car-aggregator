import { scoreListing } from '../src/lib/knn/scorer'
import type { FlippedCar, Listing } from '../src/lib/knn/types'

const referenceCars: FlippedCar[] = [
  {
    id: 'c1',
    year: 2016,
    make: 'honda',
    model: 'civic',
    mileage: 120_000,
    price: 10_000,
    purchasePrice: 10_000,
    salePrice: 13_500,
    profit: 3_500,
    profitPercentage: 0.35,
    daysToFlip: 10,
    source: 'offerup',
    purchaseDate: '2025-01-01',
    saleDate: '2025-01-10',
  },
  {
    id: 'c2',
    year: 2017,
    make: 'honda',
    model: 'civic',
    mileage: 110_000,
    price: 10_500,
    purchasePrice: 10_500,
    salePrice: 13_200,
    profit: 2_700,
    profitPercentage: 0.26,
    daysToFlip: 8,
    source: 'offerup',
    purchaseDate: '2025-02-01',
    saleDate: '2025-02-09',
  },
  {
    id: 'c3',
    year: 2015,
    make: 'honda',
    model: 'civic',
    mileage: 130_000,
    price: 9_500,
    purchasePrice: 9_500,
    salePrice: 12_500,
    profit: 3_000,
    profitPercentage: 0.31,
    daysToFlip: 14,
    source: 'offerup',
    purchaseDate: '2025-03-01',
    saleDate: '2025-03-15',
  },
]

const listingNearWins: Listing = {
  id: 'L1',
  year: 2016,
  make: 'honda',
  model: 'civic',
  mileage: 118_000,
  price: 10_200,
  source: 'offerup',
  url: 'https://example.com/near',
  title: '2016 Civic',
  city: 'Anaheim',
  postedAt: new Date().toISOString(),
}

const listingFar: Listing = {
  id: 'L2',
  year: 2022,
  make: 'honda',
  model: 'civic',
  mileage: 20_000,
  price: 24_000,
  source: 'offerup',
  url: 'https://example.com/far',
  title: '2022 Civic',
  city: 'Irvine',
  postedAt: new Date().toISOString(),
}

function logResult(label: string, res: any) {
  console.log(`\n=== ${label} ===`)
  console.log('score:', res.score)
  console.log('confidence:', res.confidence)
  console.log('isWithinPattern:', res.isWithinPattern)
  console.log('neighbors:', res.neighbors)
  console.log('explanation:', res.explanation)
}

const nearRes = scoreListing(listingNearWins, referenceCars, 3)
const farRes = scoreListing(listingFar, referenceCars, 3)

logResult('NEAR', nearRes)
logResult('FAR', farRes)
