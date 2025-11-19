import { scoreListing } from '../src/lib/knn/scorer'
import type { Listing, FlippedCar } from '../src/lib/knn/types'

const MAX = Math.hypot(1.0, 1.2, 2.0)
console.log('Expected MAX_NORM_DIST ~', MAX)

const wins: FlippedCar[] = [
  { id: 'A', make: 'honda', model: 'civic', year: 2016, mileage:120000, price:10000, purchasePrice:10000, salePrice:0, profit:0, profitPercentage:0, daysToFlip:0, source:'', purchaseDate:'', saleDate:'' }
]

const testListing: Listing = {
  id: 'T1',
  make: 'honda', model: 'civic', year: 2016, mileage:120000, price:10000,
  source:'', url:'', title:'', city:'', postedAt:new Date().toISOString()
}

console.log(scoreListing(testListing, wins))

