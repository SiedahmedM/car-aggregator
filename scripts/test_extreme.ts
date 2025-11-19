import { scoreListingWithContext, prepareCombinedContext } from '../src/lib/scoring/combined'
import type { Listing, FlippedCar } from '../src/lib/knn/types'

const wins: FlippedCar[] = [
  { id:'w1', make:'honda', model:'civic', year:2016, mileage:120000, purchasePrice:10000, price:10000, profit:0, profitPercentage:0, salePrice:0, daysToFlip:0, source:'x', purchaseDate:'', saleDate:'' },
  { id:'w2', make:'honda', model:'civic', year:2017, mileage:110000, purchasePrice:10500, price:10500, profit:0, profitPercentage:0, salePrice:0, daysToFlip:0, source:'x', purchaseDate:'', saleDate:'' },
  { id:'w3', make:'honda', model:'civic', year:2015, mileage:130000, purchasePrice:9500,  price:9500,  profit:0, profitPercentage:0, salePrice:0, daysToFlip:0, source:'x', purchaseDate:'', saleDate:'' },
]

const ctx = prepareCombinedContext(wins)

const extreme: Listing = {
  id:'extreme', make:'honda', model:'civic',
  year:2008, mileage:250000, price:2000,
  source:'x', url:'', title:'mechanic special flood salvage', city:'', postedAt:new Date().toISOString()
}

console.log(scoreListingWithContext(extreme, wins, ctx))

