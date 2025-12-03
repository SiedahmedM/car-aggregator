'use client'

import { useState } from 'react'
import { ArbitrageCarouselCard } from './ArbitrageCarouselCard'

// Types
type Win = {
  id: string
  year: number
  make: string
  model: string
  profit: number
}

type ListingData = {
  id: string
  url?: string | null
  posted_at?: string | null
  year?: number | null
  make?: string | null
  model?: string | null
  mileage?: number | null
  price?: number | null
}

type Deal = {
  score: number
  confidence: number
  listing: ListingData
}

export function SmartDiscovery({
  wins,
  deals
}: {
  wins: Win[],
  deals: Deal[]
}) {
  const [activeWinId, setActiveWinId] = useState<string>(wins[0]?.id)

  // For the MVP Demo, we will simulate "filtering" by just showing different slices of the deals.
  // In the real backend, you'd filter deals by which reference car generated them.
  // Strategy:
  // Win 1 shows deals [0, 1, 2, 3, 4]
  // Win 2 shows deals [5, 6, 7, 8, 9]
  // Win 3 shows deals [10, 11, 12, 13, 14]
  const activeIndex = wins.findIndex(w => w.id === activeWinId)
  const filteredDeals = deals.slice(activeIndex * 5, (activeIndex * 5) + 5)

  return (
    <section className="mb-8">
      {/* 1. THE PATTERN SELECTOR (The Reference Wins) */}
      <div className="mb-4">
        <h2 className="text-sm font-bold text-blue-400 tracking-wide uppercase mb-3">
          Select a Winning Pattern
        </h2>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {wins.map((win) => {
            const isActive = win.id === activeWinId
            return (
              <button
                key={win.id}
                onClick={() => setActiveWinId(win.id)}
                className={`
                  relative flex-shrink-0 px-4 py-3 rounded-xl border text-left transition-all
                  ${isActive
                    ? 'bg-blue-600/10 border-blue-500 ring-1 ring-blue-500/50'
                    : 'bg-neutral-900 border-white/10 hover:border-white/30 text-neutral-400'
                  }
                `}
              >
                <div className="text-xs font-medium uppercase tracking-wider mb-1">
                  {isActive ? <span className="text-blue-400">● Active Pattern</span> : 'Past Win'}
                </div>
                <div className={`text-sm font-bold ${isActive ? 'text-white' : 'text-neutral-300'}`}>
                  {win.year} {win.make} {win.model}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 2. THE REVEAL (The Carousel) */}
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <div className="flex items-center justify-between mb-3">
           <h3 className="text-sm font-medium text-white flex items-center gap-2">
             Results for <span className="text-blue-400 font-bold">
               {wins.find(w => w.id === activeWinId)?.year} {wins.find(w => w.id === activeWinId)?.model}
             </span> Strategy
           </h3>
           <span className="text-xs text-neutral-500">{filteredDeals.length} High-Confidence Matches Found</span>
        </div>

        <div className="flex gap-4 overflow-x-auto pb-6 snap-x no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
          {filteredDeals.length > 0 ? (
            filteredDeals.map((deal) => (
              <ArbitrageCarouselCard key={deal.listing.id} deal={deal} />
            ))
          ) : (
            <div className="w-full py-8 text-center border border-dashed border-white/10 rounded-xl text-neutral-500 text-sm">
              No matches found for this pattern yet.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
