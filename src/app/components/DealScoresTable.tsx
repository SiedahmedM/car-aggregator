'use client'

import Link from 'next/link'

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
}

type DealScore = {
  score: number
  confidence: number
  listing: ListingRow
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

function IconLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="inline-block">
      <path d="M14 3h7v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 14L21 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M21 14v7h-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 10l11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// --- MAIN COMPONENT ---
export function DealScoresTable({ deals }: { deals: DealScore[] }) {
  if (!deals || deals.length === 0) {
    return (
      <div className="rounded-2xl bg-neutral-900/50 ring-1 ring-white/10 p-8">
        <div className="text-center">
          <h3 className="text-lg font-semibold text-neutral-300 mb-2">No Smart Deals Found</h3>
          <p className="text-sm text-neutral-400">
            Run the deal finder to discover listings matching your winning patterns.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-neutral-900/50 ring-1 ring-white/10 overflow-hidden">
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-4">
        <h2 className="text-xl font-semibold text-neutral-100">
          Smart Search Results
          <span className="ml-2 text-sm font-normal text-neutral-400">
            Top {deals.length} deals ranked by score
          </span>
        </h2>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-neutral-900/50">
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Rank
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Vehicle
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Price
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Mileage
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                City
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Score
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Confidence
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Posted
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {deals.map((deal, idx) => {
              const r = deal.listing
              return (
                <tr
                  key={r.id}
                  className="hover:bg-neutral-900/70 transition-colors"
                >
                  {/* Rank */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <span className="text-lg font-bold text-emerald-400">#{idx + 1}</span>
                    </div>
                  </td>

                  {/* Vehicle */}
                  <td className="px-6 py-4">
                    <div className="text-neutral-100 font-medium">
                      {r.year ? `${r.year} ` : ''}
                      {r.make ? `${r.make} ` : ''}
                      {r.model || r.title || 'Untitled'}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {r.source || '—'}
                    </div>
                  </td>

                  {/* Price */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-neutral-100 font-semibold">
                      {r.price ? `$${Number(r.price).toLocaleString()}` : '—'}
                    </div>
                  </td>

                  {/* Mileage */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-neutral-300">
                      {r.mileage ? `${Number(r.mileage).toLocaleString()} mi` : '—'}
                    </div>
                  </td>

                  {/* City */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-neutral-300 text-xs">
                      {r.city || '—'}
                    </div>
                  </td>

                  {/* Score */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
                      {deal.score.toFixed(2)}
                    </div>
                  </td>

                  {/* Confidence */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-neutral-300 font-mono text-xs">
                      {(deal.confidence * 100).toFixed(0)}%
                    </div>
                  </td>

                  {/* Posted */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-neutral-400 text-xs">
                      {getTimeAgo(r.posted_at)}
                    </div>
                  </td>

                  {/* Actions */}
                  <td className="px-6 py-4 whitespace-nowrap">
                    {r.url ? (
                      <Link
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600/90 px-3 py-1.5 text-xs text-white transition hover:bg-blue-500"
                      >
                        Open <IconLink />
                      </Link>
                    ) : (
                      <span className="text-xs text-neutral-500">No URL</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
