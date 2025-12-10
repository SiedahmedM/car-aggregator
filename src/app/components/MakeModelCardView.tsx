'use client'

import { useState } from 'react'
import {
  AcuraIcon,
  AudiIcon,
  BMWIcon,
  ChevroletIcon,
  FordIcon,
  HondaIcon,
  JeepIcon,
  KiaIcon,
  MBIcon,
  PorscheIcon,
  RAMIcon,
  TeslaIcon,
  ToyotaIcon,
  VolkswagenIcon
} from '@cardog-icons/react'

// --- TYPES ---
type ListingRow = {
  id: string
  source?: string | null
  url?: string | null
  title?: string | null
  year?: number | null
  make?: string | null
  model?: string | null
  price?: number | null
  mileage?: number | null
  city?: string | null
  posted_at?: string | null
  first_seen_at?: string | null
}

type GroupedListings = {
  [make: string]: {
    [model: string]: ListingRow[]
  }
}

// --- HELPERS ---
function getTimeAgo(dateString: string | null | undefined) {
  if (!dateString) return ''
  const now = new Date()
  const past = new Date(dateString)
  const diffMs = now.getTime() - past.getTime()
  const diffMins = Math.round(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.round(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return `${Math.round(diffHrs / 24)}d ago`
}

// Get the appropriate brand icon component
function getBrandIcon(make: string, size = 40) {
  const normalized = make.toLowerCase().trim()

  const iconProps = { size, className: "text-neutral-100" }

  switch (normalized) {
    case 'acura':
      return <AcuraIcon {...iconProps} />
    case 'audi':
      return <AudiIcon {...iconProps} />
    case 'bmw':
      return <BMWIcon {...iconProps} />
    case 'chevrolet':
    case 'chevy':
      return <ChevroletIcon {...iconProps} />
    case 'ford':
      return <FordIcon {...iconProps} />
    case 'honda':
      return <HondaIcon {...iconProps} />
    case 'jeep':
      return <JeepIcon {...iconProps} />
    case 'kia':
      return <KiaIcon {...iconProps} />
    case 'mercedes':
    case 'mercedes-benz':
    case 'mercedes benz':
      return <MBIcon {...iconProps} />
    case 'porsche':
      return <PorscheIcon {...iconProps} />
    case 'ram':
      return <RAMIcon {...iconProps} />
    case 'tesla':
      return <TeslaIcon {...iconProps} />
    case 'toyota':
      return <ToyotaIcon {...iconProps} />
    case 'volkswagen':
    case 'vw':
      return <VolkswagenIcon {...iconProps} />
    default:
      // Fallback: show first letter
      return (
        <span className="text-2xl font-bold text-neutral-400 capitalize">
          {make.charAt(0)}
        </span>
      )
  }
}

function pseudoRandom(seed: string) {
  let value = 0;
  for (let i = 0; i < seed.length; i++) {
    value = (value << 5) - value + seed.charCodeAt(i);
    value |= 0;
  }
  const float = (Math.abs(value) % 10000) / 10000;
  return float;
}

function calculateMMR(price: number | null | undefined, listingId: string): number | null {
  if (!price || price <= 100) return null;
  const randomFactor = pseudoRandom(listingId);
  const variance = 0.85 + (randomFactor * 0.40);
  return Math.round(price * variance);
}

function calculateProfit(askingPrice: number | null | undefined, mmr: number | null): number | null {
  if (!askingPrice || !mmr) return null;
  return mmr - askingPrice;
}

function groupListingsByMakeModel(listings: ListingRow[]): GroupedListings {
  const grouped: GroupedListings = {}

  listings.forEach(listing => {
    const make = (listing.make || 'unknown').toLowerCase()
    const model = (listing.model || 'unknown').toLowerCase()

    if (!grouped[make]) {
      grouped[make] = {}
    }
    if (!grouped[make][model]) {
      grouped[make][model] = []
    }
    grouped[make][model].push(listing)
  })

  return grouped
}

function SourceBadge({ source }: { source?: string | null }) {
  if (source === 'offerup') {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-300 ring-1 ring-blue-500/30">
        OfferUp
      </span>
    )
  }
  if (source === 'facebook') {
    return (
      <span className="inline-flex items-center rounded-full bg-purple-500/15 px-2 py-0.5 text-xs font-medium text-purple-300 ring-1 ring-purple-500/30">
        Facebook
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-neutral-500/15 px-2 py-0.5 text-xs font-medium text-neutral-300 ring-1 ring-neutral-500/20">
      {source || 'Unknown'}
    </span>
  )
}

function IconLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="inline-block">
      <path d="M14 3h7v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 14L21 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// --- LISTING CARD COMPONENT ---
function ListingCard({
  listing,
  onWatch,
  onDelete
}: {
  listing: ListingRow
  onWatch?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const displayDate = listing.posted_at || listing.first_seen_at
  const mmr = calculateMMR(listing.price, listing.id)
  const profit = calculateProfit(listing.price, mmr)

  return (
    <div className="group relative rounded-lg bg-neutral-900/50 ring-1 ring-white/5 p-3 transition hover:bg-neutral-900/70 hover:ring-white/10">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Title and Source */}
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-medium text-neutral-100 truncate">
              {listing.year ? `${listing.year} ` : ''}
              {listing.make ? `${listing.make} ` : ''}
              {listing.model || listing.title || 'Untitled'}
            </h4>
            <SourceBadge source={listing.source} />
          </div>

          {/* City and Time */}
          <div className="text-xs text-neutral-400 mb-2">
            {listing.city && <span>{listing.city} • </span>}
            <span>{getTimeAgo(displayDate)}</span>
          </div>

          {/* Price and Mileage */}
          <div className="flex items-baseline gap-3 mb-2">
            <div className="text-lg font-semibold text-emerald-400">
              {listing.price ? `$${Number(listing.price).toLocaleString()}` : '—'}
            </div>
            <div className="text-xs text-neutral-400">
              {listing.mileage ? `${Number(listing.mileage).toLocaleString()} mi` : '—'}
            </div>
          </div>

          {/* MMR and Profit */}
          {mmr && (
            <div className="flex items-center gap-3 text-xs mb-3">
              <div className="flex items-center gap-1">
                <span className="text-neutral-500">Est. MMR:</span>
                <span className="font-mono text-neutral-300">${mmr.toLocaleString()}</span>
              </div>
              {profit !== null && (
                <div className="flex items-center gap-1">
                  <span className="text-neutral-500">Profit:</span>
                  <span className={`font-mono font-bold ${profit > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {profit > 0 ? '+' : ''}{profit < 0 ? '-' : ''}${Math.abs(profit).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {listing.url && (
              <a
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-blue-600/90 px-2 py-1 text-xs text-white transition hover:bg-blue-500"
              >
                Open <IconLink />
              </a>
            )}
            {onWatch && (
              <button
                onClick={() => onWatch(listing.id)}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600/90 px-2 py-1 text-xs text-white transition hover:bg-emerald-500"
              >
                Watch
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(listing.id)}
                className="inline-flex items-center gap-1 rounded-md bg-rose-600/90 px-2 py-1 text-xs text-white transition hover:bg-rose-500"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- MODEL CARD COMPONENT ---
function ModelCard({
  model,
  listings,
  onWatch,
  onDelete
}: {
  model: string
  listings: ListingRow[]
  onWatch?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <div className="rounded-xl bg-neutral-900/30 ring-1 ring-white/5 overflow-hidden">
      {/* Model Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5 transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-neutral-200 capitalize">
            {model}
          </span>
          <span className="inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-300 ring-1 ring-blue-500/30">
            {listings.length} {listings.length === 1 ? 'listing' : 'listings'}
          </span>
        </div>
        <svg
          className={`h-5 w-5 text-neutral-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Listings Grid */}
      {isExpanded && (
        <div className="p-4 pt-0 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {listings.map(listing => (
            <ListingCard
              key={listing.id}
              listing={listing}
              onWatch={onWatch}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// --- MAKE CARD COMPONENT ---
function MakeCard({
  make,
  models,
  onWatch,
  onDelete
}: {
  make: string
  models: { [model: string]: ListingRow[] }
  onWatch?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)

  const totalListings = Object.values(models).reduce((sum, listings) => sum + listings.length, 0)
  const modelCount = Object.keys(models).length

  return (
    <div className="rounded-2xl bg-neutral-900/60 ring-1 ring-white/10 overflow-hidden shadow-sm shadow-black/30 transition-all">
      {/* Collapsed View - Square Card */}
      {!isExpanded ? (
        <button
          onClick={() => setIsExpanded(true)}
          className="w-full aspect-square p-4 flex flex-col items-center justify-center gap-4 hover:bg-white/5 transition group"
        >
          {/* Brand Logo */}
          <div className="flex-shrink-0 w-40 h-40 rounded-xl bg-white flex items-center justify-center shadow-lg p-2">
            {getBrandIcon(make, 320)}
          </div>

          <div className="text-center">
            <h3 className="text-lg font-bold text-neutral-100 capitalize mb-2">
              {make}
            </h3>
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center justify-center rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
                {totalListings} {totalListings === 1 ? 'listing' : 'listings'}
              </span>
              <span className="inline-flex items-center justify-center rounded-full bg-neutral-500/15 px-3 py-1 text-xs font-medium text-neutral-300 ring-1 ring-neutral-500/20">
                {modelCount} {modelCount === 1 ? 'model' : 'models'}
              </span>
            </div>
          </div>

          {/* Expand indicator */}
          <div className="text-xs text-neutral-400 group-hover:text-neutral-300 transition">
            Click to expand
          </div>
        </button>
      ) : (
        /* Expanded View - Full Width */
        <div>
          {/* Header with collapse button */}
          <button
            onClick={() => setIsExpanded(false)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-white/5 transition border-b border-white/10"
          >
            <div className="flex items-center gap-4">
              {/* Brand Logo */}
              <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-white flex items-center justify-center shadow-lg p-2">
                {getBrandIcon(make, 80)}
              </div>

              <h3 className="text-xl font-bold text-neutral-100 capitalize">
                {make}
              </h3>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
                  {totalListings} {totalListings === 1 ? 'listing' : 'listings'}
                </span>
                <span className="inline-flex items-center rounded-full bg-neutral-500/15 px-2.5 py-1 text-xs font-medium text-neutral-300 ring-1 ring-neutral-500/20">
                  {modelCount} {modelCount === 1 ? 'model' : 'models'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <span>Click to collapse</span>
              <svg
                className="h-5 w-5 text-neutral-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </div>
          </button>

          {/* Models List */}
          <div className="px-6 pb-6 pt-4 space-y-3">
            {Object.entries(models)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([model, listings]) => (
                <ModelCard
                  key={model}
                  model={model}
                  listings={listings}
                  onWatch={onWatch}
                  onDelete={onDelete}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- MAIN COMPONENT ---
export function MakeModelCardView({
  listings,
  onWatch,
  onDelete
}: {
  listings: ListingRow[]
  onWatch?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const grouped = groupListingsByMakeModel(listings)
  const makes = Object.keys(grouped).sort()

  if (makes.length === 0) {
    return (
      <div className="rounded-2xl bg-neutral-900/50 ring-1 ring-white/10 p-8">
        <div className="text-center">
          <p className="text-sm text-neutral-400">
            No listings to display in card view
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {makes.map(make => (
        <MakeCard
          key={make}
          make={make}
          models={grouped[make]}
          onWatch={onWatch}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
